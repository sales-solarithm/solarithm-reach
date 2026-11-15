import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXCEL_STREAM_CHUNK_SIZE,
  ExcelWorkerProgressEvent,
  commitIngestionIn500OpBatches,
  generateHighVolumeStreamRows,
  streamSanitizeAndAuditRows,
} from './workers/excelProcessor.worker';
import {
  SOFT_LOCK_TTL_MS,
  acquireLeadSoftLockPure,
  evaluateLeadSoftLockCollision,
  releaseLeadSoftLockPure,
} from '../hooks/useLeadLock';
import {
  ImportBatchSnapshotRecord,
  buildPipelineSnapshotPayload,
  compressSnapshotToGzipBlob,
  formatSnapshotFilename,
  rollbackImportBatchPure,
} from '../scripts/firestoreBackup';
import { LeadRecord } from './types';

function createMockLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  const nowIso = '2026-10-28T10:00:00.000Z';
  return {
    id: 'lead-100',
    companyName: 'Sanand Solar Wafer Hub Pvt Ltd',
    companyNameNormalized: 'sanand solar wafer hub pvt ltd',
    phoneNumber: '9825011223',
    formattedPhone: '+91 98250 11223',
    altNumber: null,
    state: 'Gujarat',
    city: 'Ahmedabad',
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
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

test('Task 1: streamSanitizeAndAuditRows streams 2,500 rows in 500-row chunks and emits live progress', async () => {
  const existingLead = createMockLead({
    id: 'existing-dup-1',
    companyName: 'Existing Duplicate Solar Co',
    companyNameNormalized: 'existing duplicate solar co',
    phoneNumber: '9825011223',
  });

  const rows = generateHighVolumeStreamRows(2500);
  const progressEvents: ExcelWorkerProgressEvent[] = [];

  const result = await streamSanitizeAndAuditRows(
    rows,
    [existingLead],
    (ev) => progressEvents.push(ev),
    0
  );

  assert.equal(EXCEL_STREAM_CHUNK_SIZE, 500);
  // 2500 rows / 500 = 5 chunk events
  assert.equal(progressEvents.length, 5);
  const finalEvent = progressEvents[progressEvents.length - 1];
  assert.equal(finalEvent.percentComplete, 100);
  assert.equal(finalEvent.processedRows, 2500);
  assert.equal(finalEvent.totalChunks, 5);
  assert.equal(
    result.validFreshLeads.length +
      result.duplicatesDetected.length +
      result.malformedRows.length,
    2500
  );
  assert.ok(result.malformedRows.length > 0);
  assert.ok(result.duplicatesDetected.length > 0);
});

test('Task 1.2: commitIngestionIn500OpBatches enforces atomic 500-op boundaries and exports partial-failure log', async () => {
  const leadsToCommit: LeadRecord[] = Array.from({ length: 1200 }, (_, i) =>
    createMockLead({
      id: `bulk-${i + 1}`,
      companyName: `Bulk Solar Industry #${i + 1}`,
      companyNameNormalized: `bulk solar industry #${i + 1}`,
      phoneNumber: String(9200000000 + i),
    })
  );

  // Simulate failure at chunk index 1 (chunk 0 with 500 records commits, remaining 700 fail midway)
  const partialRes = await commitIngestionIn500OpBatches(
    leadsToCommit,
    'IMP_2026_10_28_TEST',
    { simulateFailureAtChunkIndex: 1 }
  );

  assert.equal(partialRes.totalRequestedRecords, 1200);
  assert.equal(partialRes.committedChunksCount, 1);
  assert.equal(partialRes.committedRecordsCount, 500);
  assert.equal(partialRes.failedAtChunkIndex, 1);
  assert.equal(partialRes.unprocessedRecords.length, 700);
  assert.equal(partialRes.unprocessedRecords[0].id, 'bulk-501');
});

test('Task 2: useLeadLock pure helpers enforce 10-minute soft-lock collision and Owner override', () => {
  const baseLead = createMockLead();
  const repA = { email: 'sales@solarithmdesign.com', name: 'Priya Nair (Sales Rep)' };
  const repB = { email: 'sales2@solarithmdesign.com', name: 'Rohan Kulkarni (Sales Rep)' };
  const t0 = '2026-10-28T10:00:00.000Z';

  // Rep A opens drawer -> acquires soft lock
  const lockA = acquireLeadSoftLockPure(baseLead, repA, t0);
  assert.equal(lockA.acquired, true);
  assert.equal(lockA.updatedLead.currentCallerEmail, repA.email);

  // 3 minutes later, Rep B attempts to open the same lead -> collision detected
  const t3Min = new Date(new Date(t0).getTime() + 3 * 60 * 1000);
  const collisionForRepB = evaluateLeadSoftLockCollision(
    lockA.updatedLead,
    repB.email,
    t3Min
  );
  assert.equal(collisionForRepB.isLockedByAnotherRep, true);
  assert.equal(
    collisionForRepB.bannerMessage,
    'Rep Priya Nair is currently viewing/calling this lead.'
  );

  // Rep B cannot acquire without override
  const lockAttemptB = acquireLeadSoftLockPure(
    lockA.updatedLead,
    repB,
    t3Min.toISOString(),
    false
  );
  assert.equal(lockAttemptB.acquired, false);

  // After 10 minutes + 1 second of inactivity, the soft lock expires automatically
  const tExpired = new Date(new Date(t0).getTime() + SOFT_LOCK_TTL_MS + 1000);
  const expiredCheck = evaluateLeadSoftLockCollision(
    lockA.updatedLead,
    repB.email,
    tExpired
  );
  assert.equal(expiredCheck.isLockedByAnotherRep, false);

  // Owner override can forcibly claim an active lock immediately
  const ownerOverride = acquireLeadSoftLockPure(
    lockA.updatedLead,
    { email: 'pranav@solarithmdesign.com', name: 'Pranav (Owner)' },
    t3Min.toISOString(),
    true
  );
  assert.equal(ownerOverride.acquired, true);
  assert.equal(ownerOverride.updatedLead.currentCallerEmail, 'pranav@solarithmdesign.com');

  // Releasing lock clears caller fields
  const unlocked = releaseLeadSoftLockPure(ownerOverride.updatedLead, t3Min.toISOString());
  assert.equal(unlocked.currentCallerEmail, null);
  assert.equal(unlocked.lockedAt, null);
});

test('Task 3: firestoreBackup builds gzip snapshot and rolls back importBatchId in one click', async () => {
  assert.equal(
    formatSnapshotFilename('2026-10-28T12:00:00.000Z'),
    'leads_snapshot_2026_10_28.json.gz'
  );

  const originalProtectedLead = createMockLead({
    id: 'existing-lead-1',
    companyName: 'Original Arvind Textiles Ltd',
    status: 'PROPOSAL_SHARED',
    callAttempts: 4,
  });

  const overwrittenLead: LeadRecord = {
    ...originalProtectedLead,
    companyName: 'Corrupted Sheet Overwrite Name',
  };

  const newlyInsertedLead = createMockLead({
    id: 'ingested-bad-1',
    companyName: 'Accidental Bulk Row #1',
    importBatchId: 'IMP_2026_10_28_99999',
  });

  const currentLeads = [newlyInsertedLead, overwrittenLead];
  const importHistory: ImportBatchSnapshotRecord[] = [
    {
      importBatchId: 'IMP_2026_10_28_99999',
      fileName: 'Bad_Bulk_Upload.xlsx',
      importedAt: '2026-10-28T11:00:00.000Z',
      importedByEmail: 'pranav@solarithmdesign.com',
      importedByName: 'Pranav',
      insertedLeadIds: ['ingested-bad-1'],
      overwrittenLeadCount: 1,
      preOverwriteSnapshots: [originalProtectedLead],
      rolledBackAt: null,
    },
  ];

  // Verify snapshot payload + gzip compression
  const snapshotPayload = buildPipelineSnapshotPayload(currentLeads, [], []);
  assert.equal(snapshotPayload.counts.leads, 2);
  const compressed = await compressSnapshotToGzipBlob(snapshotPayload);
  assert.ok(compressed.byteSize > 0);

  // Execute One-Click Rollback by importBatchId
  const rollbackRes = rollbackImportBatchPure(
    currentLeads,
    'IMP_2026_10_28_99999',
    importHistory,
    '2026-10-28T11:05:00.000Z'
  );

  assert.equal(rollbackRes.removedInsertedLeadsCount, 1);
  assert.equal(rollbackRes.restoredOverwrittenLeadsCount, 1);
  assert.equal(rollbackRes.updatedLeads.length, 1);
  assert.equal(rollbackRes.updatedLeads[0].companyName, 'Original Arvind Textiles Ltd');
  assert.equal(rollbackRes.updatedLeads[0].status, 'PROPOSAL_SHARED');
  assert.ok(rollbackRes.updatedImportHistory[0].rolledBackAt);
});
