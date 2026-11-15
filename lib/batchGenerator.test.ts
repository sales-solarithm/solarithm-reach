import test from 'node:test';
import assert from 'node:assert/strict';
import { generateStratifiedBatch, isLeadOnCooldown, computeCooldownUntil } from './batchGenerator';
import { LeadRecord } from './types';

function makeMockLead(id: string, overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id,
    companyName: `Solar Co ${id}`,
    companyNameNormalized: `solar co ${id}`,
    phoneNumber: '9429360746',
    formattedPhone: '+91 94293 60746',
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

test('computeCooldownUntil and isLeadOnCooldown enforce 48-hour lock', () => {
  const callTime = '2026-10-25T10:00:00.000Z';
  const cooldownUntil = computeCooldownUntil(callTime, 48);
  assert.equal(cooldownUntil, '2026-10-27T10:00:00.000Z');

  // 24 hours later -> still on cooldown
  assert.equal(
    isLeadOnCooldown({ cooldownUntil }, new Date('2026-10-26T10:00:00.000Z')),
    true
  );

  // 49 hours later -> cooldown expired
  assert.equal(
    isLeadOnCooldown({ cooldownUntil }, new Date('2026-10-27T11:00:00.000Z')),
    false
  );
});

test('generateStratifiedBatch allocates 75/25 ratio (2,250 untouched + 750 retries for 3,000 batch)', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const leads: LeadRecord[] = [];

  // 2,500 untouched leads (Bucket A)
  for (let i = 0; i < 2500; i++) {
    leads.push(makeMockLead(`A-${i}`, { callAttempts: 0, didntReceiveCount: 0 }));
  }

  // 1,000 retry leads cleared from cooldown (Bucket B)
  for (let i = 0; i < 1000; i++) {
    leads.push(
      makeMockLead(`B-${i}`, {
        callAttempts: 2,
        didntReceiveCount: 2,
        cooldownUntil: '2026-10-26T12:00:00.000Z', // expired
      })
    );
  }

  // 200 leads currently locked on cooldown (should be excluded)
  for (let i = 0; i < 200; i++) {
    leads.push(
      makeMockLead(`C-${i}`, {
        callAttempts: 1,
        didntReceiveCount: 1,
        cooldownUntil: '2026-10-28T12:00:00.000Z', // active cooldown
      })
    );
  }

  let seed = 42;
  const deterministicRng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const result = generateStratifiedBatch(leads, 3000, now, deterministicRng);
  assert.equal(result.batchLeads.length, 3000);
  assert.equal(result.bucketACount, 2250);
  assert.equal(result.bucketBCount, 750);
  assert.equal(result.excludedOnCooldownCount, 200);

  // Verify Fisher-Yates interleaved distribution (first 100 leads contain both A and B)
  const first100 = result.batchLeads.slice(0, 100);
  const aInFirst100 = first100.filter((l) => l.id.startsWith('A-')).length;
  const bInFirst100 = first100.filter((l) => l.id.startsWith('B-')).length;
  assert.ok(aInFirst100 > 0 && bInFirst100 > 0, 'Expected interleaved Bucket A and Bucket B leads');
});

test('generateStratifiedBatch fills shortfall from Bucket B when Bucket A has fewer than 75%', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const leads: LeadRecord[] = [];

  // Only 50 untouched leads
  for (let i = 0; i < 50; i++) {
    leads.push(makeMockLead(`A-${i}`, { callAttempts: 0 }));
  }
  // 150 retry leads
  for (let i = 0; i < 150; i++) {
    leads.push(
      makeMockLead(`B-${i}`, {
        callAttempts: 1,
        didntReceiveCount: 1,
        cooldownUntil: '2026-10-25T00:00:00.000Z',
      })
    );
  }

  const result = generateStratifiedBatch(leads, 100, now);
  assert.equal(result.batchLeads.length, 100);
  assert.equal(result.bucketACount, 50);
  assert.equal(result.bucketBCount, 50);
});
