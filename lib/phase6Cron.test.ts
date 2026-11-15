import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMidnightResetPure,
  runCooldownSweeperPure,
} from '@/lib/batchResetCron';
import { LeadRecord } from '@/lib/types';
import { DailyBatchDocument } from '@/types/batch';

function createTestLead(overrides: Partial<LeadRecord>): LeadRecord {
  return {
    id: 'lead-1',
    companyName: 'Test Solar Corp',
    companyNameNormalized: 'test solar corp',
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
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

test('runMidnightResetPure resets assignedBatchId, assignedRepEmail, assignedRepName on FRESH leads and closes batches with day-end metrics', () => {
  const batches: DailyBatchDocument[] = [
    {
      batchId: 'BATCH_2026_10_28_01',
      batchNumber: 1,
      date: '2026-10-28',
      totalLeads: 3000,
      claimedByEmail: 'sales@solarithmdesign.com',
      claimedByName: 'Priya Nair',
      claimedAt: '2026-10-28T03:30:00.000Z',
      status: 'IN_PROGRESS',
      completedCallsCount: 1,
    },
    {
      batchId: 'BATCH_2026_10_28_02',
      batchNumber: 2,
      date: '2026-10-28',
      totalLeads: 3000,
      claimedByEmail: null,
      claimedByName: null,
      claimedAt: null,
      status: 'AVAILABLE',
      completedCallsCount: 0,
    },
  ];

  const leads: LeadRecord[] = [
    createTestLead({
      id: 'l-uncalled-1',
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_10_28_01',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
    }),
    createTestLead({
      id: 'l-uncalled-2',
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_10_28_01',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
    }),
    createTestLead({
      id: 'l-called-interested',
      status: 'INTERESTED',
      assignedBatchId: 'BATCH_2026_10_28_01',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
      callAttempts: 1,
    }),
  ];

  const nowIso = '2026-10-28T18:29:00.000Z';
  const result = runMidnightResetPure(batches, leads, '2026-10-28', nowIso);

  assert.equal(result.summary.uncalledLeadsReleasedCount, 2);
  assert.equal(result.summary.closedBatchesCount, 2);

  // Verify FRESH leads were unlinked and updatedAt updated
  const l1 = result.updatedLeads.find((l) => l.id === 'l-uncalled-1')!;
  assert.equal(l1.assignedBatchId, null);
  assert.equal(l1.assignedRepEmail, null);
  assert.equal(l1.assignedRepName, null);
  assert.equal(l1.updatedAt, nowIso);

  // Verify INTERESTED lead kept its rep assignment
  const lInterested = result.updatedLeads.find((l) => l.id === 'l-called-interested')!;
  assert.equal(lInterested.assignedRepEmail, 'sales@solarithmdesign.com');

  // Verify Batch Document Retirement day-end metrics
  const b1 = result.updatedBatches.find((b) => b.batchId === 'BATCH_2026_10_28_01')!;
  assert.equal(b1.status, 'CLOSED');
  assert.equal(b1.totalLeadsAssigned, 3000);
  assert.equal(b1.completedCallsCount, 1);
  assert.equal(b1.uncalledReturnedCount, 2);
  assert.equal(b1.closedAt, nowIso);
});

test('runCooldownSweeperPure clears expired 48h cooldowns, enforces didntReceiveCount > 10 -> DIDNT_RECEIVE_DEAD, and audits SWITCH_OFF >= 3 -> SWITCH_OFF_DEAD', () => {
  const now = new Date('2026-10-28T10:00:00.000Z');

  const leads: LeadRecord[] = [
    // 1. Expired 48h cooldown on FRESH / DIDNT_RECEIVE lead with didntReceiveCount <= 10
    createTestLead({
      id: 'l-cooldown-expired-fresh',
      status: 'FRESH',
      didntReceiveCount: 3,
      cooldownUntil: '2026-10-28T08:00:00.000Z', // 2 hours ago
    }),
    createTestLead({
      id: 'l-cooldown-expired-dr',
      status: 'DIDNT_RECEIVE',
      didntReceiveCount: 4,
      cooldownUntil: '2026-10-28T09:00:00.000Z', // 1 hour ago
    }),
    // 2. Active cooldown in the future — must remain locked
    createTestLead({
      id: 'l-cooldown-active',
      status: 'DIDNT_RECEIVE',
      didntReceiveCount: 2,
      cooldownUntil: '2026-10-29T10:00:00.000Z', // tomorrow
    }),
    // 3. Lead that exceeded 10 DIDNT_RECEIVE attempts without retiring -> DIDNT_RECEIVE_DEAD
    createTestLead({
      id: 'l-exceeded-10-dr',
      status: 'FRESH',
      didntReceiveCount: 11,
      assignedBatchId: 'BATCH_2026_10_28_01',
      cooldownUntil: '2026-10-28T05:00:00.000Z',
    }),
    // 4. SWITCH_OFF lead with switchOffCount >= 3 -> SWITCH_OFF_DEAD and assignedBatchId = null
    createTestLead({
      id: 'l-switch-off-3',
      status: 'SWITCH_OFF',
      switchOffCount: 3,
      assignedBatchId: 'BATCH_2026_10_28_01',
    }),
  ];

  const result = runCooldownSweeperPure(leads, now);

  assert.equal(result.summary.cooldownClearedCount, 2);
  assert.equal(result.summary.didntReceiveDeadCount, 1);
  assert.equal(result.summary.switchOffDeadCount, 1);

  const expiredFresh = result.updatedLeads.find((l) => l.id === 'l-cooldown-expired-fresh')!;
  assert.equal(expiredFresh.status, 'FRESH');
  assert.equal(expiredFresh.cooldownUntil, null);

  const expiredDr = result.updatedLeads.find((l) => l.id === 'l-cooldown-expired-dr')!;
  assert.equal(expiredDr.status, 'FRESH');
  assert.equal(expiredDr.cooldownUntil, null);

  const activeDr = result.updatedLeads.find((l) => l.id === 'l-cooldown-active')!;
  assert.equal(activeDr.status, 'DIDNT_RECEIVE');
  assert.equal(activeDr.cooldownUntil, '2026-10-29T10:00:00.000Z');

  const deadDr = result.updatedLeads.find((l) => l.id === 'l-exceeded-10-dr')!;
  assert.equal(deadDr.status, 'DIDNT_RECEIVE_DEAD');
  assert.equal(deadDr.assignedBatchId, null);
  assert.equal(deadDr.cooldownUntil, null);

  const deadSo = result.updatedLeads.find((l) => l.id === 'l-switch-off-3')!;
  assert.equal(deadSo.status, 'SWITCH_OFF_DEAD');
  assert.equal(deadSo.assignedBatchId, null);
});
