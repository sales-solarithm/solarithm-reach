import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DailyBatchDocument,
  formatBatchId,
  getTodayIstDateString,
} from './../types/batch';
import {
  claimBatchStateTransition,
  createDailyBatchPure,
  filterBatchesForUser,
  runNightlySweepPure,
} from './batchResetCron';
import { runMidnightResetPure } from './../functions/src/cron/midnightReset';
import { LeadRecord } from './types';

function makeTestLead(
  index: number,
  overrides: Partial<LeadRecord> = {}
): LeadRecord {
  const phone = String(9100000000 + index);
  return {
    id: `lead-p3-${index}`,
    companyName: `Solar Prospect ${index} Pvt Ltd`,
    companyNameNormalized: `solar prospect ${index} pvt ltd`,
    phoneNumber: phone,
    formattedPhone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
    altNumber: null,
    state: 'Gujarat',
    city: 'Ahmedabad',
    status: 'FRESH',
    assignedBatchId: null,
    assignedRepEmail: null,
    assignedRepName: null,
    callAttempts: 0,
    callCount: 0,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: null,
    lastCalledByEmail: null,
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-31T04:00:00.000Z',
    updatedAt: '2026-10-31T04:00:00.000Z',
    notes: '',
    ...overrides,
  };
}

describe('Phase 3 Task 1: Batch Collection Schema & Daily 3,000-Lead Generation', () => {
  it('formats batchId strictly as BATCH_YYYY_MM_DD_XX and increments sequential batchNumber', () => {
    assert.equal(formatBatchId('2026-10-31', 1), 'BATCH_2026_10_31_01');
    assert.equal(formatBatchId('2026-10-31', 2), 'BATCH_2026_10_31_02');
    assert.equal(formatBatchId('2026-10-31', 12), 'BATCH_2026_10_31_12');

    const todayIso = getTodayIstDateString(
      new Date('2026-10-31T08:00:00.000Z')
    );
    assert.equal(todayIso, '2026-10-31');

    const leads = Array.from({ length: 120 }, (_, i) => makeTestLead(i + 1));

    const first = createDailyBatchPure(leads, [], 3000, '2026-10-31');
    assert.equal(first.newBatch.batchId, 'BATCH_2026_10_31_01');
    assert.equal(first.newBatch.batchNumber, 1);
    assert.equal(first.newBatch.date, '2026-10-31');
    assert.equal(first.newBatch.totalLeads, 3000);
    assert.equal(first.newBatch.claimedByEmail, null);
    assert.equal(first.newBatch.claimedByName, null);
    assert.equal(first.newBatch.claimedAt, null);
    assert.equal(first.newBatch.status, 'AVAILABLE');
    assert.equal(first.newBatch.completedCallsCount, 0);

    const second = createDailyBatchPure(
      leads,
      first.updatedBatches,
      3000,
      '2026-10-31'
    );
    assert.equal(second.newBatch.batchId, 'BATCH_2026_10_31_02');
    assert.equal(second.newBatch.batchNumber, 2);
    assert.equal(second.updatedBatches.length, 2);
  });
});

describe('Phase 3 Task 2: Morning Batch Claim, Atomic Lock & Multi-User Isolation', () => {
  it('atomically transitions AVAILABLE batch to IN_PROGRESS, assigns constituent leads, and blocks double-claim', () => {
    const leads = [
      makeTestLead(1),
      makeTestLead(2),
      makeTestLead(3),
      makeTestLead(4),
    ];
    const batch1: DailyBatchDocument = {
      batchId: 'BATCH_2026_10_31_01',
      batchNumber: 1,
      date: '2026-10-31',
      totalLeads: 3000,
      claimedByEmail: null,
      claimedByName: null,
      claimedAt: null,
      status: 'AVAILABLE',
      completedCallsCount: 0,
      leadIds: ['lead-p3-1', 'lead-p3-2', 'lead-p3-3'],
    };

    const claimTime = '2026-10-31T04:15:00.000Z';
    const transition = claimBatchStateTransition(
      'BATCH_2026_10_31_01',
      { email: 'rohan@solarithmdesign.com', name: 'Rohan Desai' },
      [batch1],
      leads,
      claimTime
    );

    assert.equal(transition.updatedBatch.status, 'IN_PROGRESS');
    assert.equal(
      transition.updatedBatch.claimedByEmail,
      'rohan@solarithmdesign.com'
    );
    assert.equal(transition.updatedBatch.claimedByName, 'Rohan Desai');
    assert.equal(transition.updatedBatch.claimedAt, claimTime);

    const assignedInBatch = transition.updatedLeads.filter(
      (l) => l.assignedBatchId === 'BATCH_2026_10_31_01'
    );
    assert.equal(assignedInBatch.length, 3);
    for (const l of assignedInBatch) {
      assert.equal(l.assignedRepEmail, 'rohan@solarithmdesign.com');
      assert.equal(l.assignedRepName, 'Rohan Desai');
    }

    // Lead #4 was not in batch1.leadIds
    const untouchedLead = transition.updatedLeads.find(
      (l) => l.id === 'lead-p3-4'
    );
    assert.equal(untouchedLead?.assignedBatchId, null);

    // Attempting to claim the same batch again by another rep must fail atomically
    assert.throws(() => {
      claimBatchStateTransition(
        'BATCH_2026_10_31_01',
        { email: 'ananya@solarithmdesign.com', name: 'Ananya Sharma' },
        transition.updatedBatches,
        transition.updatedLeads,
        '2026-10-31T04:16:00.000Z'
      );
    }, /no longer AVAILABLE/);
  });

  it('enforces multi-user isolation: claimed batch disappears for other sales reps while remaining visible to claiming rep and Owner', () => {
    const batches: DailyBatchDocument[] = [
      {
        batchId: 'BATCH_2026_10_31_01',
        batchNumber: 1,
        date: '2026-10-31',
        totalLeads: 3000,
        claimedByEmail: 'rohan@solarithmdesign.com',
        claimedByName: 'Rohan Desai',
        claimedAt: '2026-10-31T04:15:00.000Z',
        status: 'IN_PROGRESS',
        completedCallsCount: 42,
        leadIds: [],
      },
      {
        batchId: 'BATCH_2026_10_31_02',
        batchNumber: 2,
        date: '2026-10-31',
        totalLeads: 3000,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        leadIds: [],
      },
      {
        batchId: 'BATCH_2026_10_31_03',
        batchNumber: 3,
        date: '2026-10-31',
        totalLeads: 3000,
        claimedByEmail: 'vikram@solarithmdesign.com',
        claimedByName: 'Vikram Singh',
        claimedAt: '2026-10-31T04:00:00.000Z',
        closedAt: '2026-10-31T18:29:00.000Z',
        status: 'CLOSED',
        completedCallsCount: 150,
        leadIds: [],
      },
    ];

    // Rep A (Rohan) sees his claimed Batch #1 + unclaimed Batch #2
    const rohanVisible = filterBatchesForUser(
      batches,
      { email: 'rohan@solarithmdesign.com', role: 'USER', isOwnerTier: false },
      '2026-10-31'
    );
    assert.deepEqual(
      rohanVisible.map((b) => b.batchId),
      ['BATCH_2026_10_31_01', 'BATCH_2026_10_31_02']
    );

    // Rep B (Ananya) does NOT see Rohan's claimed Batch #1 — only sees unclaimed Batch #2
    const ananyaVisible = filterBatchesForUser(
      batches,
      { email: 'ananya@solarithmdesign.com', role: 'USER', isOwnerTier: false },
      '2026-10-31'
    );
    assert.deepEqual(
      ananyaVisible.map((b) => b.batchId),
      ['BATCH_2026_10_31_02']
    );

    // Owner (Aarav) has full supervisory visibility over all batches (AVAILABLE, IN_PROGRESS, CLOSED)
    const ownerVisible = filterBatchesForUser(
      batches,
      { email: 'aarav@solarithmdesign.com', role: 'OWNER', isOwnerTier: true },
      '2026-10-31'
    );
    assert.equal(ownerVisible.length, 3);
  });
});

describe('Phase 3 Task 3: 11:59 PM Daily Reset & Lead Release Engine', () => {
  it('releases all uncalled FRESH leads back to the global pool and retires IN_PROGRESS and AVAILABLE batches to CLOSED', () => {
    const batches: DailyBatchDocument[] = [
      {
        batchId: 'BATCH_2026_10_31_01',
        batchNumber: 1,
        date: '2026-10-31',
        totalLeads: 3000,
        claimedByEmail: 'rohan@solarithmdesign.com',
        claimedByName: 'Rohan Desai',
        claimedAt: '2026-10-31T04:15:00.000Z',
        status: 'IN_PROGRESS',
        completedCallsCount: 1,
        leadIds: ['lead-p3-1', 'lead-p3-2', 'lead-p3-3'],
      },
      {
        batchId: 'BATCH_2026_10_31_02',
        batchNumber: 2,
        date: '2026-10-31',
        totalLeads: 3000,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        leadIds: ['lead-p3-4'],
      },
    ];

    const leads: LeadRecord[] = [
      // Uncalled FRESH lead in Batch #1 -> must be unlinked and returned to Global Fresh Pool
      makeTestLead(1, {
        status: 'FRESH',
        assignedBatchId: 'BATCH_2026_10_31_01',
        assignedRepEmail: 'rohan@solarithmdesign.com',
        assignedRepName: 'Rohan Desai',
      }),
      // Uncalled FRESH lead in Batch #1 -> must be unlinked and returned to Global Fresh Pool
      makeTestLead(2, {
        status: 'FRESH',
        assignedBatchId: 'BATCH_2026_10_31_01',
        assignedRepEmail: 'rohan@solarithmdesign.com',
        assignedRepName: 'Rohan Desai',
      }),
      // Called lead (PROPOSAL_SHARED) in Batch #1 -> must retain status and rep assignment
      makeTestLead(3, {
        status: 'PROPOSAL_SHARED',
        assignedBatchId: 'BATCH_2026_10_31_01',
        assignedRepEmail: 'rohan@solarithmdesign.com',
        assignedRepName: 'Rohan Desai',
        callAttempts: 1,
      }),
      // Uncalled FRESH lead in Batch #2 -> must be unlinked
      makeTestLead(4, {
        status: 'FRESH',
        assignedBatchId: 'BATCH_2026_10_31_02',
        assignedRepEmail: null,
        assignedRepName: null,
      }),
    ];

    const sweepIso = '2026-10-31T18:29:00.000Z';
    const result = runNightlySweepPure(batches, leads, '2026-10-31', sweepIso);

    // 3 uncalled FRESH leads released
    assert.equal(result.summary.uncalledLeadsReleasedCount, 3);
    // Both today's batches (IN_PROGRESS and AVAILABLE) closed
    assert.equal(result.summary.closedBatchesCount, 2);

    for (const b of result.updatedBatches) {
      assert.equal(b.status, 'CLOSED');
      assert.equal(b.closedAt, sweepIso);
    }

    const releasedLead1 = result.updatedLeads.find((l) => l.id === 'lead-p3-1')!;
    assert.equal(releasedLead1.assignedBatchId, null);
    assert.equal(releasedLead1.assignedRepEmail, null);
    assert.equal(releasedLead1.assignedRepName, null);
    assert.equal(releasedLead1.status, 'FRESH');

    const calledLead3 = result.updatedLeads.find((l) => l.id === 'lead-p3-3')!;
    assert.equal(calledLead3.status, 'PROPOSAL_SHARED');
    assert.equal(calledLead3.assignedRepEmail, 'rohan@solarithmdesign.com');

    // Also verify parity with Cloud Function pure helper `runMidnightResetPure`
    const cfResult = runMidnightResetPure(
      batches,
      leads,
      '2026-10-31',
      sweepIso
    );
    assert.equal(cfResult.summary.uncalledLeadsReleasedCount, 3);
    assert.equal(cfResult.summary.closedBatchesCount, 2);
  });
});
