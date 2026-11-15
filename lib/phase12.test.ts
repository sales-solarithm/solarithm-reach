import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadRecord } from './types';
import {
  cacheActiveBatchLeads,
  clearPendingDispositions,
  enqueueOfflineDisposition,
  flushPendingDispositionsToFirestore,
  getCachedBatchLeads,
  getPendingDispositions,
  reconcileOfflineDispositionPure,
} from './offlineSync';
import {
  ALT_NUMBER_SWEEP_EXACT_NOTE,
  runDidntReceiveAltNumberSweepPure,
  runSwitchOff90DayRevivalPure,
} from './reengagementEngine';
import { generateStratifiedBatch, REVIVED_QUOTA_MAX_RATIO } from './batchGenerator';
import {
  ANOMALY_FLAG_LABEL,
  computeHourlyCallingIntensity,
  computeRepDispositionMatrix,
} from '@/components/analytics/DispositionHeatmap';
import { INITIAL_AUTHORIZED_USERS, INITIAL_LEADS } from './seedData';

function createMockLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: 'lead-test-1',
    companyName: 'Test Solar Spinning Mills',
    companyNameNormalized: 'test solar spinning mills',
    phoneNumber: '9825011223',
    formattedPhone: '+91 98250 11223',
    altNumber: '9426088991',
    state: 'Gujarat',
    city: 'Ahmedabad',
    status: 'FRESH',
    assignedBatchId: 'BATCH_2026_10_28_01',
    assignedRepEmail: 'sales@solarithmdesign.com',
    assignedRepName: 'Priya Nair',
    callAttempts: 0,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: null,
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-25T08:00:00.000Z',
    notes: 'Initial note',
    callHistory: [],
    ...overrides,
  };
}

describe('Phase 12 Task 1: Offline Calling & State Reconciliation (lib/offlineSync.ts)', () => {
  it('stores active batch leads in reach_local_queue and enqueues offline dispositions with clientLoggedAt', async () => {
    await clearPendingDispositions();
    const lead1 = createMockLead({ id: 'offline-lead-1' });
    await cacheActiveBatchLeads([lead1]);

    const cached = await getCachedBatchLeads();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].id, 'offline-lead-1');

    const loggedItem = await enqueueOfflineDisposition({
      lead: lead1,
      repEmail: 'sales@solarithmdesign.com',
      repName: 'Priya Nair',
      repRole: 'sales',
      newStatus: 'PROPOSAL_SHARED',
      callNotes: 'Spoke to MD while offline in GIDC; shared 800 kWp quote',
      clientLoggedAt: '2026-10-28T06:15:00.000Z',
    });

    assert.equal(loggedItem.clientLoggedAt, '2026-10-28T06:15:00.000Z');
    const pending = await getPendingDispositions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].newStatus, 'PROPOSAL_SHARED');
    await clearPendingDispositions();
  });

  it('honors Owner assignment override on conflict while appending offline call notes to audit timeline', async () => {
    await clearPendingDispositions();
    const baseLead = createMockLead({
      id: 'conflict-lead-1',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
      status: 'FRESH',
      updatedAt: '2026-10-28T08:00:00.000Z',
      notes: 'Original plant record',
    });

    // Sales rep logs disposition offline based on 08:00 state
    const offlinePending = await enqueueOfflineDisposition({
      lead: baseLead,
      repEmail: 'sales@solarithmdesign.com',
      repName: 'Priya Nair',
      repRole: 'sales',
      newStatus: 'DIDNT_RECEIVE',
      callNotes: 'Dialed from field tablet while offline — rang out',
      clientLoggedAt: '2026-10-28T08:30:00.000Z',
    });

    // Meanwhile on the server at 08:45, Owner re-assigned the lead to Rohan Kulkarni
    const serverModifiedLead: LeadRecord = {
      ...baseLead,
      assignedRepEmail: 'rohan@solarithmdesign.com',
      assignedRepName: 'Rohan Kulkarni (Enterprise Telecaller)',
      assignedBatchId: 'BATCH_OWNER_HANDOVER',
      status: 'PROPOSAL_SHARED',
      updatedAt: '2026-10-28T08:45:00.000Z',
      notes: 'Owner reassigned to Rohan Kulkarni',
    };

    const reconciled = reconcileOfflineDispositionPure(
      offlinePending,
      serverModifiedLead,
      '2026-10-28T09:00:00.000Z'
    );

    assert.equal(reconciled.conflictDetected, true);
    // Honors Owner's assignment override & server status
    assert.equal(reconciled.reconciledLead.assignedRepEmail, 'rohan@solarithmdesign.com');
    assert.equal(
      reconciled.reconciledLead.assignedRepName,
      'Rohan Kulkarni (Enterprise Telecaller)'
    );
    assert.equal(reconciled.reconciledLead.status, 'PROPOSAL_SHARED');
    // Appends offline call notes to historical audit timeline (`notes` and `callHistory`)
    assert.ok(
      reconciled.reconciledLead.notes?.includes(
        'Dialed from field tablet while offline — rang out'
      )
    );
    assert.equal(reconciled.reconciledLead.callHistory?.length, 1);
    assert.ok(
      reconciled.reconciledLead.callHistory?.[0].note?.includes(
        'Honored server/Owner override'
      )
    );

    // Also test ordered flush across multiple pending items
    const flushReport = await flushPendingDispositionsToFirestore(
      [serverModifiedLead],
      '2026-10-28T09:05:00.000Z'
    );
    assert.equal(flushReport.flushedCount, 1);
    assert.equal(flushReport.conflictsResolvedCount, 1);
    const remaining = await getPendingDispositions();
    assert.equal(remaining.length, 0);
  });
});

describe('Phase 12 Task 2: Dormant Pool Re-engagement Engine (lib/reengagementEngine.ts)', () => {
  it('revives SWITCH_OFF_DEAD leads older than 90 days to REVIVED_FRESH and caps morning batch quota at 10%', () => {
    const now = new Date('2026-10-28T10:00:00.000Z');
    const dormantOver90Days = createMockLead({
      id: 'dormant-so-1',
      status: 'SWITCH_OFF_DEAD',
      switchOffCount: 3,
      callAttempts: 3,
      updatedAt: '2026-06-15T10:00:00.000Z', // > 130 days ago
    });
    const recentSwitchOffDead = createMockLead({
      id: 'recent-so-2',
      status: 'SWITCH_OFF_DEAD',
      switchOffCount: 3,
      callAttempts: 3,
      updatedAt: '2026-10-10T10:00:00.000Z', // Only 18 days ago -> Must NOT revive
    });

    const revivalResult = runSwitchOff90DayRevivalPure(
      [dormantOver90Days, recentSwitchOffDead],
      now
    );

    assert.equal(revivalResult.revivedCount, 1);
    const revived = revivalResult.updatedLeads.find((l) => l.id === 'dormant-so-1')!;
    const untouchedRecent = revivalResult.updatedLeads.find((l) => l.id === 'recent-so-2')!;

    assert.equal(revived.status, 'REVIVED_FRESH');
    assert.equal(revived.switchOffCount, 0);
    assert.equal(revived.callAttempts, 0);
    assert.equal(untouchedRecent.status, 'SWITCH_OFF_DEAD');

    // Verify 10% low-priority quota in generateStratifiedBatch (e.g., targetSize = 100 -> max 10 REVIVED_FRESH)
    const manyRevived: LeadRecord[] = Array.from({ length: 25 }, (_, idx) =>
      createMockLead({
        id: `revived-${idx}`,
        status: 'REVIVED_FRESH',
        callAttempts: 0,
      })
    );
    const standardFreshA: LeadRecord[] = Array.from({ length: 100 }, (_, idx) =>
      createMockLead({
        id: `fresh-a-${idx}`,
        status: 'FRESH',
        callAttempts: 0,
      })
    );
    const standardFreshB: LeadRecord[] = Array.from({ length: 50 }, (_, idx) =>
      createMockLead({
        id: `fresh-b-${idx}`,
        status: 'FRESH',
        callAttempts: 2,
        didntReceiveCount: 2,
      })
    );

    const batchOut = generateStratifiedBatch(
      [...manyRevived, ...standardFreshA, ...standardFreshB],
      100,
      now
    );

    assert.equal(batchOut.batchLeads.length, 100);
    assert.equal(batchOut.revivedCount, Math.floor(100 * REVIVED_QUOTA_MAX_RATIO)); // Strictly capped at 10 (10%)
    assert.equal(batchOut.eligibleRevivedTotal, 25);
  });

  it('swaps primary and secondary numbers for DIDNT_RECEIVE_DEAD leads with undialed 10-digit altNumber', () => {
    const now = new Date('2026-10-28T10:00:00.000Z');
    const exhaustedLead = createMockLead({
      id: 'exhausted-nr-1',
      phoneNumber: '9825011223',
      formattedPhone: '+91 98250 11223',
      altNumber: '9426088991',
      altNumberDialed: false,
      status: 'DIDNT_RECEIVE_DEAD',
      didntReceiveCount: 10,
      callAttempts: 10,
      notes: '10 attempts unanswered',
    });

    const sweepResult = runDidntReceiveAltNumberSweepPure([exhaustedLead], now);
    assert.equal(sweepResult.swappedCount, 1);

    const swapped = sweepResult.swappedLeads[0];
    assert.equal(swapped.phoneNumber, '9426088991');
    assert.equal(swapped.formattedPhone, '+91 94260 88991');
    assert.equal(swapped.altNumber, '9825011223');
    assert.equal(swapped.altNumberDialed, true);
    assert.equal(swapped.didntReceiveCount, 0);
    assert.equal(swapped.status, 'FRESH');
    assert.ok(swapped.notes?.includes(ALT_NUMBER_SWEEP_EXACT_NOTE));
  });
});

describe('Phase 12 Task 3: Call Disposition Distribution & Quality Heatmap', () => {
  it('computes 24-hour IST calling intensity and flags reps with >80% DIDNT_RECEIVE as anomaly', () => {
    const hourly = computeHourlyCallingIntensity(INITIAL_LEADS);
    assert.equal(hourly.length, 24);

    // Morning peak (10:00-13:00 IST) and Afternoon peak (15:00-18:00 IST) have calls from seed data
    const morningPeakCalls = hourly
      .filter((b) => b.isMorningPeak)
      .reduce((s, b) => s + b.totalCalls, 0);
    const afternoonPeakCalls = hourly
      .filter((b) => b.isAfternoonPeak)
      .reduce((s, b) => s + b.totalCalls, 0);
    assert.ok(morningPeakCalls > 0);
    assert.ok(afternoonPeakCalls > 0);

    const matrix = computeRepDispositionMatrix(INITIAL_LEADS, INITIAL_AUTHORIZED_USERS);
    assert.ok(matrix.repRows.length >= 3);

    // Kavita Sharma has 8/9 (88.9%) DIDNT_RECEIVE vs ~50% team baseline -> Flagged!
    const kavitaRow = matrix.repRows.find((r) =>
      r.repEmail.toLowerCase().includes('kavita@solarithmdesign.com')
    );
    assert.ok(kavitaRow, 'Kavita row should exist in matrix');
    assert.ok(kavitaRow.didntReceiveRatioPct > 80);
    assert.equal(kavitaRow.isHighDisconnectAnomaly, true);
    assert.equal(kavitaRow.anomalyLabel, ANOMALY_FLAG_LABEL);
  });
});
