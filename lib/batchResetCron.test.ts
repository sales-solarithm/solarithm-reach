import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBatchId } from '../types/batch';
import {
  claimBatchStateTransition,
  filterBatchesForUser,
  runNightlySweepPure,
} from './batchResetCron';
import { DailyBatchDocument } from '../types/batch';
import { LeadRecord } from './types';

function createSampleBatch(overrides: Partial<DailyBatchDocument> = {}): DailyBatchDocument {
  return {
    batchId: 'BATCH_2026_10_28_01',
    batchNumber: 1,
    date: '2026-10-28',
    totalLeads: 3000,
    claimedByEmail: null,
    claimedByName: null,
    claimedAt: null,
    status: 'AVAILABLE',
    completedCallsCount: 0,
    leadIds: ['lead-1', 'lead-2'],
    ...overrides,
  };
}

function createSampleLead(id: string, overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id,
    companyName: `Solar Co ${id}`,
    companyNameNormalized: `solar co ${id}`,
    phoneNumber: '9825011223',
    formattedPhone: '+91 98250 11223',
    altNumber: null,
    status: 'FRESH',
    assignedBatchId: null,
    assignedRepEmail: null,
    assignedRepName: null,
    callAttempts: 0,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: null,
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-28T04:00:00.000Z',
    updatedAt: '2026-10-28T04:00:00.000Z',
    ...overrides,
  };
}

test('formatBatchId formats BATCH_YYYY_MM_DD_XX accurately', () => {
  assert.equal(formatBatchId('2026-10-28', 1), 'BATCH_2026_10_28_01');
  assert.equal(formatBatchId('2026-10-28', 12), 'BATCH_2026_10_28_12');
});

test('claimBatchStateTransition locks AVAILABLE batch to IN_PROGRESS and assigns constituent leads', () => {
  const batches = [createSampleBatch()];
  const leads = [createSampleLead('lead-1'), createSampleLead('lead-2'), createSampleLead('lead-3')];
  const rep = { email: 'sales@solarithmdesign.com', name: 'Priya Nair' };
  const nowIso = '2026-10-28T04:15:00.000Z';

  const result = claimBatchStateTransition('BATCH_2026_10_28_01', rep, batches, leads, nowIso);
  assert.equal(result.updatedBatch.status, 'IN_PROGRESS');
  assert.equal(result.updatedBatch.claimedByEmail, 'sales@solarithmdesign.com');
  assert.equal(result.updatedBatch.claimedByName, 'Priya Nair');
  assert.equal(result.updatedBatch.claimedAt, nowIso);
  assert.equal(result.assignedLeadCount, 2);

  const l1 = result.updatedLeads.find((l) => l.id === 'lead-1')!;
  const l3 = result.updatedLeads.find((l) => l.id === 'lead-3')!;
  assert.equal(l1.assignedBatchId, 'BATCH_2026_10_28_01');
  assert.equal(l1.assignedRepEmail, 'sales@solarithmdesign.com');
  assert.equal(l3.assignedBatchId, null);

  // Attempting to claim the same batch again must throw an error
  assert.throws(() => {
    claimBatchStateTransition(
      'BATCH_2026_10_28_01',
      { email: 'rohan@solarithmdesign.com', name: 'Rohan Kulkarni' },
      result.updatedBatches,
      result.updatedLeads,
      nowIso
    );
  }, /no longer AVAILABLE/);
});

test('filterBatchesForUser enforces real-time peer isolation for sales reps while giving full visibility to owner', () => {
  const batches: DailyBatchDocument[] = [
    createSampleBatch({ batchId: 'BATCH_2026_10_28_01', batchNumber: 1, status: 'AVAILABLE' }),
    createSampleBatch({
      batchId: 'BATCH_2026_10_28_02',
      batchNumber: 2,
      status: 'IN_PROGRESS',
      claimedByEmail: 'sales@solarithmdesign.com',
      claimedByName: 'Priya Nair',
    }),
    createSampleBatch({
      batchId: 'BATCH_2026_10_28_03',
      batchNumber: 3,
      status: 'CLOSED',
    }),
  ];

  // Priya sees Available (#1) + her own claimed batch (#2), not CLOSED (#3)
  const priyaVisible = filterBatchesForUser(
    batches,
    { email: 'sales@solarithmdesign.com', role: 'sales' },
    '2026-10-28'
  );
  assert.deepEqual(
    priyaVisible.map((b) => b.batchId),
    ['BATCH_2026_10_28_01', 'BATCH_2026_10_28_02']
  );

  // Rohan (peer rep) ONLY sees Available (#1) — Priya's claimed batch (#2) immediately disappears!
  const rohanVisible = filterBatchesForUser(
    batches,
    { email: 'rohan@solarithmdesign.com', role: 'sales' },
    '2026-10-28'
  );
  assert.deepEqual(
    rohanVisible.map((b) => b.batchId),
    ['BATCH_2026_10_28_01']
  );

  // Owner sees all 3 batches (AVAILABLE, IN_PROGRESS, CLOSED)
  const ownerVisible = filterBatchesForUser(
    batches,
    { email: 'jalpaom2004@gmail.com', role: 'owner' },
    '2026-10-28'
  );
  assert.equal(ownerVisible.length, 3);
});

test('runNightlySweepPure releases uncalled FRESH leads back to unassigned pool and marks batches CLOSED', () => {
  const batches: DailyBatchDocument[] = [
    createSampleBatch({
      batchId: 'BATCH_2026_10_28_01',
      status: 'IN_PROGRESS',
      claimedByEmail: 'sales@solarithmdesign.com',
      completedCallsCount: 1,
    }),
    createSampleBatch({
      batchId: 'BATCH_2026_10_28_02',
      batchNumber: 2,
      status: 'AVAILABLE',
      completedCallsCount: 0,
    }),
  ];

  const leads: LeadRecord[] = [
    // Lead 1: Assigned to batch, still FRESH (uncalled) -> MUST be released!
    createSampleLead('lead-1', {
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_10_28_01',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
    }),
    // Lead 2: Assigned to batch, dialed and marked INTERESTED -> MUST preserve rep assignment!
    createSampleLead('lead-2', {
      status: 'INTERESTED',
      assignedBatchId: 'BATCH_2026_10_28_01',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
      callAttempts: 1,
    }),
  ];

  const sweepResult = runNightlySweepPure(
    batches,
    leads,
    '2026-10-28',
    '2026-10-28T18:29:00.000Z'
  );

  // Check summary
  assert.equal(sweepResult.summary.closedBatchesCount, 2);
  assert.equal(sweepResult.summary.uncalledLeadsReleasedCount, 1);
  assert.equal(sweepResult.summary.totalDialedCallsCount, 1);

  // Check batches are now CLOSED
  assert.ok(sweepResult.updatedBatches.every((b) => b.status === 'CLOSED'));
  assert.ok(sweepResult.updatedBatches.every((b) => b.closedAt === '2026-10-28T18:29:00.000Z'));

  // Check Lead 1 was unlinked and returned to pool
  const afterLead1 = sweepResult.updatedLeads.find((l) => l.id === 'lead-1')!;
  assert.equal(afterLead1.assignedBatchId, null);
  assert.equal(afterLead1.assignedRepEmail, null);
  assert.equal(afterLead1.assignedRepName, null);

  // Check Lead 2 (INTERESTED) kept its rep link
  const afterLead2 = sweepResult.updatedLeads.find((l) => l.id === 'lead-2')!;
  assert.equal(afterLead2.assignedRepEmail, 'sales@solarithmdesign.com');
  assert.equal(afterLead2.status, 'INTERESTED');
});
