import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditLogRecord } from '@/lib/auditLogger';
import {
  releaseRepDailyBatchOverridePure,
  remediateDeadStatusCapsPure,
  remediateOrphanedAssignmentsPure,
  runDataIntegrityDiagnostics,
  transferSelectedLeadsPure,
} from '@/lib/integrityChecker';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import { DailyBatchDocument } from '@/types/batch';

const ACTIVE_USERS: AuthorizedUser[] = [
  {
    email: 'jalpaom2004@gmail.com',
    name: 'Om Jalpa (Managing Director)',
    role: 'owner',
    status: 'active',
  },
  {
    email: 'sales@solarithmdesign.com',
    name: 'Priya Nair',
    role: 'sales',
    status: 'active',
  },
  {
    email: 'rohan@solarithmdesign.com',
    name: 'Rohan Kulkarni',
    role: 'sales',
    status: 'active',
  },
];

function createLead(overrides: Partial<LeadRecord>): LeadRecord {
  return {
    id: 'l-1',
    companyName: 'Test C&I Solar Plant',
    companyNameNormalized: 'test c&i solar plant',
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
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('buildAuditLogRecord creates immutable AuditLogRecord with full schema fields', () => {
  const record = buildAuditLogRecord({
    id: 'audit-test-1',
    leadId: 'lead-103',
    actorEmail: 'jalpaom2004@gmail.com',
    actorName: 'Om Jalpa',
    actorRole: 'owner',
    actionType: 'MANUALLY_TRANSFERRED',
    previousStatus: 'PROPOSAL_SHARED',
    newStatus: 'PROPOSAL_SHARED',
    metadata: {
      fromRepEmail: 'sales@solarithmdesign.com',
      toRepEmail: 'rohan@solarithmdesign.com',
    },
    timestamp: '2026-10-28T06:00:00.000Z',
  });

  assert.equal(record.id, 'audit-test-1');
  assert.equal(record.leadId, 'lead-103');
  assert.equal(record.actorRole, 'owner');
  assert.equal(record.actionType, 'MANUALLY_TRANSFERRED');
  assert.equal(record.previousStatus, 'PROPOSAL_SHARED');
  assert.equal(record.newStatus, 'PROPOSAL_SHARED');
  assert.equal(record.metadata.toRepEmail, 'rohan@solarithmdesign.com');
  assert.equal(record.timestamp, '2026-10-28T06:00:00.000Z');
});

test('runDataIntegrityDiagnostics detects orphaned reps, invalid dead caps, >14d overdue follow-ups, and duplicate numbers', () => {
  const now = new Date('2026-10-28T10:00:00.000Z');
  const leads: LeadRecord[] = [
    // Orphaned lead assigned to departed rep + overdue follow-up (>14 days ago)
    createLead({
      id: 'l-orphan',
      phoneNumber: '9825000001',
      assignedRepEmail: 'departed@solarithmdesign.com',
      assignedRepName: 'Departed Rep',
      status: 'FRESH',
      nextFollowUpDate: '2026-10-05T10:00:00.000Z',
    }),
    // Stuck dead-cap lead (didntReceiveCount = 11 but still FRESH) + duplicate phone
    createLead({
      id: 'l-deadcap-dr',
      phoneNumber: '9825099999',
      status: 'FRESH',
      didntReceiveCount: 11,
      assignedRepEmail: 'sales@solarithmdesign.com',
    }),
    // Duplicate phone collision on 9825099999
    createLead({
      id: 'l-dup-2',
      phoneNumber: '9825099999',
      status: 'PROPOSAL_SHARED',
      assignedRepEmail: 'rohan@solarithmdesign.com',
    }),
  ];

  const report = runDataIntegrityDiagnostics(leads, ACTIVE_USERS, now);

  assert.equal(report.orphanedLeads.length, 1);
  assert.equal(report.orphanedLeads[0].lead.id, 'l-orphan');
  assert.equal(report.invalidDeadCapLeads.length, 1);
  assert.equal(report.invalidDeadCapLeads[0].expectedDeadStatus, 'DIDNT_RECEIVE_DEAD');
  assert.equal(report.expiredFollowUpLeads.length, 1);
  assert.equal(report.duplicateNumberGroups.length, 1);
  assert.equal(report.duplicateNumberGroups[0].phoneDigits, '9825099999');
});

test('remediateOrphanedAssignmentsPure and remediateDeadStatusCapsPure fix issues and emit audit events', () => {
  const leads: LeadRecord[] = [
    createLead({
      id: 'l-orphan',
      status: 'FRESH',
      assignedBatchId: 'BATCH-OLD',
      assignedRepEmail: 'departed@solarithmdesign.com',
      assignedRepName: 'Departed Rep',
    }),
    createLead({
      id: 'l-stuck-dr',
      status: 'FRESH',
      didntReceiveCount: 11,
      assignedBatchId: 'BATCH-OLD',
    }),
    createLead({
      id: 'l-stuck-so',
      status: 'SWITCH_OFF',
      switchOffCount: 3,
      assignedBatchId: 'BATCH-OLD',
    }),
  ];

  const actor = {
    email: 'jalpaom2004@gmail.com',
    name: 'Om Jalpa',
    role: 'owner' as const,
  };

  const orphanRes = remediateOrphanedAssignmentsPure(
    leads,
    ACTIVE_USERS,
    actor,
    '2026-10-28T10:00:00.000Z'
  );
  assert.equal(orphanRes.remediatedCount, 1);
  assert.equal(orphanRes.auditEvents.length, 1);
  const fixedOrphan = orphanRes.updatedLeads.find((l) => l.id === 'l-orphan')!;
  assert.equal(fixedOrphan.assignedRepEmail, null);
  assert.equal(fixedOrphan.assignedBatchId, null);

  const capRes = remediateDeadStatusCapsPure(
    orphanRes.updatedLeads,
    actor,
    '2026-10-28T10:00:00.000Z'
  );
  assert.equal(capRes.remediatedCount, 2);
  assert.equal(capRes.auditEvents.length, 2);
  assert.equal(
    capRes.updatedLeads.find((l) => l.id === 'l-stuck-dr')!.status,
    'DIDNT_RECEIVE_DEAD'
  );
  assert.equal(
    capRes.updatedLeads.find((l) => l.id === 'l-stuck-so')!.status,
    'SWITCH_OFF_DEAD'
  );
});

test('transferSelectedLeadsPure and releaseRepDailyBatchOverridePure preserve history and emit audit events', () => {
  const leads: LeadRecord[] = [
    createLead({
      id: 'l-prop-1',
      status: 'PROPOSAL_SHARED',
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
      callAttempts: 3,
      lastCalledDate: '2026-10-26T11:20:00.000Z',
      nextFollowUpDate: '2026-10-29T07:00:00.000Z',
      notes: '2.4 MWp proposal shared',
    }),
    createLead({
      id: 'l-batch-fresh',
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_10_28_03',
      assignedRepEmail: 'rohan@solarithmdesign.com',
      assignedRepName: 'Rohan Kulkarni',
    }),
  ];

  const batches: DailyBatchDocument[] = [
    {
      batchId: 'BATCH_2026_10_28_03',
      batchNumber: 3,
      date: '2026-10-28',
      totalLeads: 3000,
      claimedByEmail: 'rohan@solarithmdesign.com',
      claimedByName: 'Rohan Kulkarni',
      claimedAt: '2026-10-28T04:00:00.000Z',
      status: 'IN_PROGRESS',
      completedCallsCount: 2,
    },
  ];

  const transferRes = transferSelectedLeadsPure(
    leads,
    ['l-prop-1'],
    { email: 'rohan@solarithmdesign.com', name: 'Rohan Kulkarni' },
    { email: 'jalpaom2004@gmail.com', name: 'Om Jalpa', role: 'owner' },
    '2026-10-28T11:00:00.000Z'
  );

  assert.equal(transferRes.transferredCount, 1);
  assert.equal(transferRes.auditEvents[0].actionType, 'MANUALLY_TRANSFERRED');
  const transferredLead = transferRes.updatedLeads.find((l) => l.id === 'l-prop-1')!;
  assert.equal(transferredLead.assignedRepEmail, 'rohan@solarithmdesign.com');
  assert.equal(transferredLead.callAttempts, 3);
  assert.equal(transferredLead.lastCalledDate, '2026-10-26T11:20:00.000Z');
  assert.equal(transferredLead.nextFollowUpDate, '2026-10-29T07:00:00.000Z');
  assert.equal(transferredLead.notes, '2.4 MWp proposal shared');

  const releaseRes = releaseRepDailyBatchOverridePure(
    batches,
    transferRes.updatedLeads,
    'BATCH_2026_10_28_03',
    { email: 'jalpaom2004@gmail.com', name: 'Om Jalpa', role: 'owner' },
    '2026-10-28T11:05:00.000Z'
  );

  assert.equal(releaseRes.releasedLeadsCount, 1);
  assert.equal(releaseRes.auditEvents[0].actionType, 'BATCH_RESET');
  const releasedLead = releaseRes.updatedLeads.find((l) => l.id === 'l-batch-fresh')!;
  assert.equal(releasedLead.assignedBatchId, null);
  assert.equal(releasedLead.assignedRepEmail, null);
  assert.equal(releaseRes.updatedBatches[0].status, 'CLOSED');
});
