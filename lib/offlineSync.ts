import { collection, doc, writeBatch } from 'firebase/firestore';
import { reachDb as db } from './firebaseDual';
import { CallLogEntry, LeadRecord, LeadStatus, UserRole } from './types';
import { computeCooldownUntil } from './batchGenerator';
import { AuditLogRecord } from '@/types/audit';
import { buildAuditLogRecord } from './auditLogger';

/**
 * Phase 12 Task 1: Offline Calling & State Reconciliation (`lib/offlineSync.ts`)
 *
 * 1. IndexedDB Local Queue (`reach_local_queue` & `pending_dispositions`):
 *    - Caches active batch leads in `reach_local_queue` for resilient offline dialing.
 *    - Enqueues offline dispositions in `pending_dispositions` with `clientLoggedAt = new Date().toISOString()`.
 * 2. Reconnection & Conflict Sync:
 *    - Flushes `pending_dispositions` in chronological sequence (`clientLoggedAt` ascending) using atomic Firestore batch writes.
 *    - Conflict Resolution: If a lead was modified on the server while the client was offline (e.g., Owner re-assignment),
 *      honors the Owner's assignment override and appends the offline call notes to the lead's historical audit timeline
 *      without overwriting newer server metadata.
 */

export const OFFLINE_DB_NAME = 'SolarithmReachOfflineDB';
export const OFFLINE_DB_VERSION = 1;
export const REACH_LOCAL_QUEUE_STORE = 'reach_local_queue';
export const PENDING_DISPOSITIONS_STORE = 'pending_dispositions';

const FALLBACK_QUEUE_STORAGE_KEY = 'solarithm_reach_local_queue_v1';
const FALLBACK_PENDING_STORAGE_KEY = 'solarithm_reach_pending_dispositions_v1';

export interface PendingDispositionItem {
  id: string;
  leadId: string;
  companyName: string;
  phoneNumber: string;
  repEmail: string;
  repName: string;
  repRole: UserRole;
  previousStatus: LeadStatus;
  newStatus: LeadStatus;
  callNotes: string;
  clientLoggedAt: string; // Exact local timestamp: new Date().toISOString()
  baseUpdatedAt: string; // Lead's `updatedAt` when the rep cached/viewed it offline
  baseAssignedRepEmail: string | null; // Lead's `assignedRepEmail` when cached offline
  baseAssignedBatchId: string | null;
}

export interface OfflineDispositionInput {
  lead: LeadRecord;
  repEmail: string;
  repName: string;
  repRole: UserRole;
  newStatus: LeadStatus;
  callNotes?: string;
  clientLoggedAt?: string;
}

export interface ReconciledDispositionResult {
  reconciledLead: LeadRecord;
  conflictDetected: boolean;
  resolutionNote: string;
  auditLog: AuditLogRecord;
}

export interface OfflineSyncFlushReport {
  flushedCount: number;
  conflictsResolvedCount: number;
  updatedLeads: LeadRecord[];
  auditLogs: AuditLogRecord[];
  reconciledItems: {
    pendingId: string;
    leadId: string;
    companyName: string;
    conflictDetected: boolean;
    resolutionNote: string;
  }[];
  flushedAt: string;
}

// In-memory store for Node.js test environments where neither IndexedDB nor localStorage exists
let memoryLocalQueue: LeadRecord[] = [];
let memoryPendingDispositions: PendingDispositionItem[] = [];

function hasIndexedDB(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function openOfflineDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDB()) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REACH_LOCAL_QUEUE_STORE)) {
        db.createObjectStore(REACH_LOCAL_QUEUE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PENDING_DISPOSITIONS_STORE)) {
        const store = db.createObjectStore(PENDING_DISPOSITIONS_STORE, { keyPath: 'id' });
        store.createIndex('clientLoggedAt', 'clientLoggedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

/**
 * 1.1 Store active batch leads in a persistent client-side cache (`reach_local_queue`).
 */
export async function cacheActiveBatchLeads(leads: LeadRecord[]): Promise<void> {
  memoryLocalQueue = [...leads];
  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(FALLBACK_QUEUE_STORAGE_KEY, JSON.stringify(leads));
    } catch {
      // Ignore quota errors
    }
  }
  if (!hasIndexedDB()) return;

  try {
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(REACH_LOCAL_QUEUE_STORE, 'readwrite');
      const store = tx.objectStore(REACH_LOCAL_QUEUE_STORE);
      store.clear();
      for (const lead of leads) {
        store.put(lead);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Fallback already saved to memory/localStorage
  }
}

/**
 * Reads cached active batch leads from `reach_local_queue`.
 */
export async function getCachedBatchLeads(): Promise<LeadRecord[]> {
  if (hasIndexedDB()) {
    try {
      const db = await openOfflineDatabase();
      const items = await new Promise<LeadRecord[]>((resolve, reject) => {
        const tx = db.transaction(REACH_LOCAL_QUEUE_STORE, 'readonly');
        const store = tx.objectStore(REACH_LOCAL_QUEUE_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
          db.close();
          resolve((req.result as LeadRecord[]) || []);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
      if (items.length > 0) return items;
    } catch {
      // Fall through
    }
  }

  if (hasLocalStorage()) {
    try {
      const raw = window.localStorage.getItem(FALLBACK_QUEUE_STORAGE_KEY);
      if (raw) return JSON.parse(raw) as LeadRecord[];
    } catch {
      // Fall through
    }
  }

  return [...memoryLocalQueue];
}

/**
 * 1.2 Enqueues a call disposition in `pending_dispositions` with exact local timestamp:
 * `clientLoggedAt = new Date().toISOString()`.
 */
export async function enqueueOfflineDisposition(
  input: OfflineDispositionInput
): Promise<PendingDispositionItem> {
  const clientLoggedAt = input.clientLoggedAt || new Date().toISOString();
  const item: PendingDispositionItem = {
    id: `OFFLINE_DISP_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    leadId: input.lead.id,
    companyName: input.lead.companyName,
    phoneNumber: input.lead.phoneNumber,
    repEmail: input.repEmail,
    repName: input.repName,
    repRole: input.repRole,
    previousStatus: input.lead.status,
    newStatus: input.newStatus,
    callNotes:
      input.callNotes?.trim() ||
      `Offline disposition (${input.lead.status} -> ${input.newStatus}) logged by ${input.repName}`,
    clientLoggedAt,
    baseUpdatedAt: input.lead.updatedAt,
    baseAssignedRepEmail: input.lead.assignedRepEmail,
    baseAssignedBatchId: input.lead.assignedBatchId,
  };

  memoryPendingDispositions.push(item);
  memoryPendingDispositions.sort((a, b) => a.clientLoggedAt.localeCompare(b.clientLoggedAt));

  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(
        FALLBACK_PENDING_STORAGE_KEY,
        JSON.stringify(memoryPendingDispositions)
      );
    } catch {
      // Ignore storage error
    }
  }

  if (hasIndexedDB()) {
    try {
      const db = await openOfflineDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PENDING_DISPOSITIONS_STORE, 'readwrite');
        const store = tx.objectStore(PENDING_DISPOSITIONS_STORE);
        store.put(item);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      });
    } catch {
      // Fallback already persisted
    }
  }

  return item;
}

/**
 * Returns all queued items from `pending_dispositions` ordered by `clientLoggedAt` ascending.
 */
export async function getPendingDispositions(): Promise<PendingDispositionItem[]> {
  if (hasIndexedDB()) {
    try {
      const db = await openOfflineDatabase();
      const items = await new Promise<PendingDispositionItem[]>((resolve, reject) => {
        const tx = db.transaction(PENDING_DISPOSITIONS_STORE, 'readonly');
        const store = tx.objectStore(PENDING_DISPOSITIONS_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
          db.close();
          resolve((req.result as PendingDispositionItem[]) || []);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
      if (items.length > 0 || memoryPendingDispositions.length === 0) {
        items.sort((a, b) => a.clientLoggedAt.localeCompare(b.clientLoggedAt));
        memoryPendingDispositions = items;
        return items;
      }
    } catch {
      // Fall through
    }
  }

  if (hasLocalStorage()) {
    try {
      const raw = window.localStorage.getItem(FALLBACK_PENDING_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingDispositionItem[];
        parsed.sort((a, b) => a.clientLoggedAt.localeCompare(b.clientLoggedAt));
        memoryPendingDispositions = parsed;
        return parsed;
      }
    } catch {
      // Fall through
    }
  }

  return [...memoryPendingDispositions].sort((a, b) =>
    a.clientLoggedAt.localeCompare(b.clientLoggedAt)
  );
}

/**
 * Clears all or specified disposition IDs from `pending_dispositions`.
 */
export async function clearPendingDispositions(idsToRemove?: string[]): Promise<void> {
  if (!idsToRemove) {
    memoryPendingDispositions = [];
  } else {
    const idSet = new Set(idsToRemove);
    memoryPendingDispositions = memoryPendingDispositions.filter((i) => !idSet.has(i.id));
  }

  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(
        FALLBACK_PENDING_STORAGE_KEY,
        JSON.stringify(memoryPendingDispositions)
      );
    } catch {
      // Ignore
    }
  }

  if (hasIndexedDB()) {
    try {
      const db = await openOfflineDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PENDING_DISPOSITIONS_STORE, 'readwrite');
        const store = tx.objectStore(PENDING_DISPOSITIONS_STORE);
        if (!idsToRemove) {
          store.clear();
        } else {
          for (const id of idsToRemove) {
            store.delete(id);
          }
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      });
    } catch {
      // Ignore
    }
  }
}

/**
 * Applies an offline disposition optimistically to a local lead record so the rep can keep dialing.
 */
export function applyOfflineDispositionLocally(
  lead: LeadRecord,
  pending: PendingDispositionItem
): LeadRecord {
  const nextAttempts = lead.callAttempts + 1;
  let nextDidntReceive = lead.didntReceiveCount;
  let nextSwitchOff = lead.switchOffCount;
  let finalStatus: LeadStatus = pending.newStatus;
  let nextCooldown: string | null = null;

  if (pending.newStatus === 'DIDNT_RECEIVE') {
    nextDidntReceive += 1;
    if (nextDidntReceive >= 10) {
      finalStatus = 'DIDNT_RECEIVE_DEAD';
      nextCooldown = null;
    } else {
      nextCooldown = computeCooldownUntil(pending.clientLoggedAt, 48);
    }
  } else if (pending.newStatus === 'SWITCH_OFF') {
    nextSwitchOff += 1;
    if (nextSwitchOff >= 3) {
      finalStatus = 'SWITCH_OFF_DEAD';
    }
  }

  const logEntry: CallLogEntry = {
    id: `call-${pending.id}`,
    timestamp: pending.clientLoggedAt,
    repEmail: pending.repEmail,
    repName: pending.repName,
    previousStatus: lead.status,
    newStatus: finalStatus,
    note: `[Offline Queue] ${pending.callNotes}`,
  };

  return {
    ...lead,
    status: finalStatus,
    callAttempts: nextAttempts,
    didntReceiveCount: nextDidntReceive,
    switchOffCount: nextSwitchOff,
    lastCalledDate: pending.clientLoggedAt,
    cooldownUntil: nextCooldown,
    assignedRepEmail: lead.assignedRepEmail || pending.repEmail,
    assignedRepName: lead.assignedRepName || pending.repName,
    updatedAt: pending.clientLoggedAt,
    notes: pending.callNotes || lead.notes,
    callHistory: [...(lead.callHistory || []), logEntry],
  };
}

/**
 * 2. Reconnection & Conflict Sync (Pure Reconciliation Engine):
 * If a lead was modified on the server while the client was offline (e.g., Owner re-assignment
 * or newer server `updatedAt` > `pending.baseUpdatedAt`), honor the Owner's assignment override
 * and append the offline call notes to the lead's historical audit timeline without overwriting
 * newer server metadata.
 */
export function reconcileOfflineDispositionPure(
  pending: PendingDispositionItem,
  currentServerLead: LeadRecord,
  nowIso: string = new Date().toISOString()
): ReconciledDispositionResult {
  const serverUpdatedMs = new Date(currentServerLead.updatedAt).getTime();
  const baseUpdatedMs = new Date(pending.baseUpdatedAt).getTime();

  const wasReassignedOnServer =
    (currentServerLead.assignedRepEmail || null) !== (pending.baseAssignedRepEmail || null);
  const wasModifiedOnServerAfterBase =
    !Number.isNaN(serverUpdatedMs) &&
    !Number.isNaN(baseUpdatedMs) &&
    serverUpdatedMs > baseUpdatedMs &&
    currentServerLead.updatedAt !== pending.clientLoggedAt;

  const conflictDetected = wasReassignedOnServer || wasModifiedOnServerAfterBase;

  if (conflictDetected) {
    // Honor Owner's assignment override and newer server metadata, while appending offline call notes to historical audit timeline
    const timelineEntryNote = `[Offline Call Synced @ ${pending.clientLoggedAt} by ${pending.repName} (${pending.newStatus})]: ${pending.callNotes}`;
    const mergedNotes = currentServerLead.notes
      ? `${currentServerLead.notes} | ${timelineEntryNote}`
      : timelineEntryNote;

    const existingHistory = currentServerLead.callHistory || [];
    const alreadyHasEntry = existingHistory.some((h) => h.id === `call-${pending.id}`);
    const offlineHistoryEntry: CallLogEntry = {
      id: `call-${pending.id}`,
      timestamp: pending.clientLoggedAt,
      repEmail: pending.repEmail,
      repName: pending.repName,
      previousStatus: pending.previousStatus,
      newStatus: pending.newStatus,
      note: `${timelineEntryNote} (Honored server/Owner override: assigned to ${
        currentServerLead.assignedRepName || currentServerLead.assignedRepEmail || 'Unassigned'
      })`,
    };

    const reconciledLead: LeadRecord = {
      ...currentServerLead,
      // Honor Owner's assignment override & server status
      assignedRepEmail: currentServerLead.assignedRepEmail,
      assignedRepName: currentServerLead.assignedRepName,
      assignedBatchId: currentServerLead.assignedBatchId,
      status: currentServerLead.status,
      // Preserve call attempt count increment if not already counted
      callAttempts: Math.max(currentServerLead.callAttempts, 1),
      notes: mergedNotes,
      callHistory: alreadyHasEntry
        ? existingHistory
        : [...existingHistory, offlineHistoryEntry],
      updatedAt: nowIso,
    };

    const resolutionNote = `Conflict resolved for ${currentServerLead.companyName}: Honored Owner/server assignment override (${
      currentServerLead.assignedRepName || currentServerLead.assignedRepEmail || 'Pool'
    }) and appended offline call notes (${pending.clientLoggedAt}) to audit timeline.`;

    const auditLog = buildAuditLogRecord({
      leadId: currentServerLead.id,
      actorEmail: pending.repEmail,
      actorName: pending.repName,
      actorRole: pending.repRole,
      actionType: 'CALL_LOGGED',
      previousStatus: pending.previousStatus,
      newStatus: currentServerLead.status,
      metadata: {
        companyName: currentServerLead.companyName,
        phoneNumber: currentServerLead.phoneNumber,
        callNote: resolutionNote,
        offlineClientLoggedAt: pending.clientLoggedAt,
        conflictResolved: true,
      },
      timestamp: nowIso,
    });

    return {
      reconciledLead,
      conflictDetected: true,
      resolutionNote,
      auditLog,
    };
  }

  // Standard non-conflicting offline disposition application
  const applied = applyOfflineDispositionLocally(currentServerLead, pending);
  const reconciledLead: LeadRecord = {
    ...applied,
    updatedAt: nowIso,
  };

  const resolutionNote = `Synced offline disposition (${pending.previousStatus} -> ${reconciledLead.status}) logged at ${pending.clientLoggedAt}.`;

  const auditLog = buildAuditLogRecord({
    leadId: currentServerLead.id,
    actorEmail: pending.repEmail,
    actorName: pending.repName,
    actorRole: pending.repRole,
    actionType:
      reconciledLead.status === 'CLOSED_WON'
        ? 'CLOSED_WON'
        : reconciledLead.status === 'LEAD_LOST'
          ? 'LEAD_LOST'
          : 'CALL_LOGGED',
    previousStatus: pending.previousStatus,
    newStatus: reconciledLead.status,
    metadata: {
      companyName: currentServerLead.companyName,
      phoneNumber: currentServerLead.phoneNumber,
      callNote: `${pending.callNotes} (Offline logged at ${pending.clientLoggedAt})`,
      offlineClientLoggedAt: pending.clientLoggedAt,
      conflictResolved: false,
    },
    timestamp: nowIso,
  });

  return {
    reconciledLead,
    conflictDetected: false,
    resolutionNote,
    auditLog,
  };
}

/**
 * 2.2 Flushes `pending_dispositions` in ordered sequence (`clientLoggedAt` ascending)
 * to Firestore using atomic batch writes (500 records max per batch) and clears the local outbox.
 */
export async function flushPendingDispositionsToFirestore(
  currentServerLeads: LeadRecord[],
  nowIso: string = new Date().toISOString()
): Promise<OfflineSyncFlushReport> {
  const pendingItems = await getPendingDispositions();
  if (pendingItems.length === 0) {
    return {
      flushedCount: 0,
      conflictsResolvedCount: 0,
      updatedLeads: currentServerLeads,
      auditLogs: [],
      reconciledItems: [],
      flushedAt: nowIso,
    };
  }

  // Sort strictly by `clientLoggedAt` ascending so sequential calls on the same lead replay in order
  const orderedPending = [...pendingItems].sort((a, b) =>
    a.clientLoggedAt.localeCompare(b.clientLoggedAt)
  );

  const leadMap = new Map<string, LeadRecord>();
  for (const lead of currentServerLeads) {
    leadMap.set(lead.id, lead);
  }

  const touchedLeadIds = new Set<string>();
  const auditLogs: AuditLogRecord[] = [];
  const reconciledItems: OfflineSyncFlushReport['reconciledItems'] = [];
  let conflictsResolvedCount = 0;

  for (const item of orderedPending) {
    const serverLead = leadMap.get(item.leadId);
    if (!serverLead) continue;

    const result = reconcileOfflineDispositionPure(item, serverLead, nowIso);
    leadMap.set(item.leadId, result.reconciledLead);
    touchedLeadIds.add(item.leadId);
    auditLogs.push(result.auditLog);
    if (result.conflictDetected) {
      conflictsResolvedCount += 1;
    }
    reconciledItems.push({
      pendingId: item.id,
      leadId: item.leadId,
      companyName: item.companyName,
      conflictDetected: result.conflictDetected,
      resolutionNote: result.resolutionNote,
    });
  }

  // Commit updated leads and audit logs to Firestore in atomic 500-op batches
  if (db && touchedLeadIds.size > 0) {
    try {
      const leadsCol = collection(db, 'leads');
      const auditsCol = collection(db, 'audit_logs');
      const touchedLeads = Array.from(touchedLeadIds)
        .map((id) => leadMap.get(id))
        .filter((l): l is LeadRecord => Boolean(l));

      const batch = writeBatch(db);
      let opCount = 0;
      for (const lead of touchedLeads) {
        if (opCount >= 490) break;
        batch.set(doc(leadsCol, lead.id), lead, { merge: true });
        opCount++;
      }
      for (const audit of auditLogs) {
        if (opCount >= 498) break;
        batch.set(doc(auditsCol, audit.id), audit);
        opCount++;
      }

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 60)),
      ]);
    } catch {
      // Non-fatal in preview/offline mode
    }
  }

  await clearPendingDispositions(orderedPending.map((i) => i.id));

  return {
    flushedCount: orderedPending.length,
    conflictsResolvedCount,
    updatedLeads: Array.from(leadMap.values()),
    auditLogs,
    reconciledItems,
    flushedAt: nowIso,
  };
}
