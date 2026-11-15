import { collection, deleteDoc, doc, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { BatchRecord, LeadRecord } from '@/lib/types';
import { AuditLogRecord } from '@/types/audit';

export const IMPORT_HISTORY_STORAGE_KEY = 'solarithm_reach_import_history_v1';

export interface PipelineSnapshotPayload {
  schemaVersion: '1.0.0';
  exportedAt: string;
  projectId: string;
  counts: {
    leads: number;
    batches: number;
    audit_logs: number;
  };
  collections: {
    leads: LeadRecord[];
    batches: BatchRecord[];
    audit_logs: AuditLogRecord[];
  };
}

export interface ImportBatchSnapshotRecord {
  importBatchId: string;
  fileName: string;
  importedAt: string;
  importedByEmail: string;
  importedByName: string;
  insertedLeadIds: string[];
  overwrittenLeadCount: number;
  preOverwriteSnapshots: LeadRecord[];
  rolledBackAt?: string | null;
}

export interface ImportRollbackResult {
  importBatchId: string;
  removedInsertedLeadsCount: number;
  restoredOverwrittenLeadsCount: number;
  updatedLeads: LeadRecord[];
  updatedImportHistory: ImportBatchSnapshotRecord[];
}

/**
 * Formats the automated snapshot archive filename: `leads_snapshot_YYYY_MM_DD.json.gz`
 */
export function formatSnapshotFilename(dateInput: Date | string = new Date()): string {
  const iso =
    typeof dateInput === 'string'
      ? dateInput.slice(0, 10)
      : dateInput.toISOString().slice(0, 10);
  const sanitized = iso.replace(/-/g, '_');
  return `leads_snapshot_${sanitized}.json.gz`;
}

/**
 * Builds the complete pipeline JSON snapshot across `leads`, `batches`, and `audit_logs`.
 */
export function buildPipelineSnapshotPayload(
  leads: LeadRecord[],
  batches: BatchRecord[],
  auditLogs: AuditLogRecord[],
  exportedAt: string = new Date().toISOString()
): PipelineSnapshotPayload {
  return {
    schemaVersion: '1.0.0',
    exportedAt,
    projectId: 'solarithm-master',
    counts: {
      leads: leads.length,
      batches: batches.length,
      audit_logs: auditLogs.length,
    },
    collections: {
      leads,
      batches,
      audit_logs: auditLogs,
    },
  };
}

/**
 * Compresses a `PipelineSnapshotPayload` into a GZIP Blob (`application/gzip`) using the standard
 * Web `CompressionStream('gzip')` API (with graceful fallback to UTF-8 JSON blob if unavailable).
 */
export async function compressSnapshotToGzipBlob(
  payload: PipelineSnapshotPayload
): Promise<{ blob: Blob; isGzipCompressed: boolean; byteSize: number }> {
  const jsonString = JSON.stringify(payload, null, 2);
  const rawBytes = new TextEncoder().encode(jsonString);

  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([rawBytes])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
      const compressedResponse = new Response(stream);
      const compressedBlob = await compressedResponse.blob();
      return {
        blob: new Blob([compressedBlob], { type: 'application/gzip' }),
        isGzipCompressed: true,
        byteSize: compressedBlob.size,
      };
    } catch {
      // Fallback to raw JSON blob below
    }
  }

  const fallbackBlob = new Blob([rawBytes], { type: 'application/json' });
  return {
    blob: fallbackBlob,
    isGzipCompressed: false,
    byteSize: fallbackBlob.size,
  };
}

/**
 * Triggers a browser download of `leads_snapshot_YYYY_MM_DD.json.gz`.
 */
export async function downloadPipelineSnapshotGzip(
  leads: LeadRecord[],
  batches: BatchRecord[],
  auditLogs: AuditLogRecord[],
  now: Date = new Date()
): Promise<{ fileName: string; byteSize: number; isGzipCompressed: boolean }> {
  const payload = buildPipelineSnapshotPayload(leads, batches, auditLogs, now.toISOString());
  const fileName = formatSnapshotFilename(now);
  const { blob, isGzipCompressed, byteSize } = await compressSnapshotToGzipBlob(payload);

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return { fileName, byteSize, isGzipCompressed };
}

/**
 * Loads recorded `ImportBatchSnapshotRecord` items from `localStorage`.
 */
export function loadLocalImportHistory(): ImportBatchSnapshotRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(IMPORT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persists `ImportBatchSnapshotRecord` items to `localStorage`.
 */
export function saveLocalImportHistory(records: ImportBatchSnapshotRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(IMPORT_HISTORY_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Pure One-Click Rollback Engine:
 * Rolls back an accidental bulk overwrite or corrupted import by referencing its `importBatchId`.
 * 1. Deletes all newly inserted leads tagged with `importBatchId` (or listed in `insertedLeadIds`).
 * 2. Restores all overwritten existing leads from `preOverwriteSnapshots`.
 */
export function rollbackImportBatchPure(
  leads: LeadRecord[],
  targetImportBatchId: string,
  importHistory: ImportBatchSnapshotRecord[],
  nowIso: string = new Date().toISOString()
): ImportRollbackResult {
  const batchRecord = importHistory.find((r) => r.importBatchId === targetImportBatchId);
  const insertedIdsSet = new Set<string>(batchRecord?.insertedLeadIds || []);
  const restoreMap = new Map<string, LeadRecord>();

  if (batchRecord?.preOverwriteSnapshots) {
    for (const snap of batchRecord.preOverwriteSnapshots) {
      restoreMap.set(snap.id, snap);
    }
  }

  let removedInsertedLeadsCount = 0;
  let restoredOverwrittenLeadsCount = 0;
  const updatedLeads: LeadRecord[] = [];

  for (const lead of leads) {
    const matchesBatchTag =
      lead.importBatchId === targetImportBatchId || insertedIdsSet.has(lead.id);

    // If this lead was an existing lead that got overwritten during this import, restore its snapshot
    if (restoreMap.has(lead.id)) {
      const original = restoreMap.get(lead.id)!;
      updatedLeads.push({
        ...original,
        updatedAt: nowIso,
      });
      restoredOverwrittenLeadsCount++;
      continue;
    }

    // If this lead was newly inserted by this import batch, remove it
    if (matchesBatchTag) {
      removedInsertedLeadsCount++;
      continue;
    }

    updatedLeads.push(lead);
  }

  const updatedImportHistory = importHistory.map((item) =>
    item.importBatchId === targetImportBatchId
      ? { ...item, rolledBackAt: nowIso }
      : item
  );

  return {
    importBatchId: targetImportBatchId,
    removedInsertedLeadsCount,
    restoredOverwrittenLeadsCount,
    updatedLeads,
    updatedImportHistory,
  };
}

/**
 * Executes the One-Click Rollback against Firestore in 500-operation `writeBatch()` chunks.
 */
export async function executeImportBatchRollbackFirestore(
  targetImportBatchId: string,
  importHistory: ImportBatchSnapshotRecord[]
): Promise<void> {
  const batchRecord = importHistory.find((r) => r.importBatchId === targetImportBatchId);
  if (!batchRecord) return;

  const operations: Array<
    | { type: 'delete'; id: string }
    | { type: 'restore'; lead: LeadRecord }
  > = [
    ...batchRecord.insertedLeadIds.map((id) => ({ type: 'delete' as const, id })),
    ...batchRecord.preOverwriteSnapshots.map((lead) => ({
      type: 'restore' as const,
      lead,
    })),
  ];

  const CHUNK_LIMIT = 500;
  for (let i = 0; i < operations.length; i += CHUNK_LIMIT) {
    const slice = operations.slice(i, i + CHUNK_LIMIT);
    try {
      const batch = writeBatch(db);
      for (const op of slice) {
        const docId = op.type === 'delete' ? op.id : op.lead.id;
        const ref = doc(collection(db, 'leads'), docId);
        if (op.type === 'delete') {
          batch.delete(ref);
        } else {
          batch.set(ref, op.lead, { merge: false });
        }
      }
      await Promise.race([
        batch.commit(),
        new Promise((resolve) => setTimeout(resolve, 60)),
      ]);
    } catch {
      // Ignore offline or preview rules errors
    }
  }
}
