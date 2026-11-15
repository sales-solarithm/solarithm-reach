import {
  Transaction,
  WriteBatch,
  collection,
  doc,
  getDocs,
  limit,
  query,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { reachDb as db } from './firebaseDual';
import { AuditLogRecord, CreateAuditLogInput } from '@/types/audit';
import { chunkArray } from './leadStore';

const LOCAL_AUDIT_LOGS_KEY = 'solarithm_reach_audit_logs_v1';
const MAX_FIRESTORE_BATCH_OPS = 500;

export const INITIAL_AUDIT_LOGS: AuditLogRecord[] = [];

/**
 * Pure builder that constructs a deterministic, immutable AuditLogRecord.
 */
export function buildAuditLogRecord(eventData: CreateAuditLogInput): AuditLogRecord {
  const timestamp = eventData.timestamp || new Date().toISOString();
  const id =
    eventData.id ||
    `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    leadId: eventData.leadId,
    actorEmail: eventData.actorEmail,
    actorName: eventData.actorName,
    actorRole: eventData.actorRole,
    actionType: eventData.actionType,
    previousStatus: eventData.previousStatus ?? null,
    newStatus: eventData.newStatus,
    metadata: eventData.metadata ? { ...eventData.metadata } : {},
    timestamp,
  };
}

export function loadLocalAuditLogs(): AuditLogRecord[] {
  if (typeof window === 'undefined') return INITIAL_AUDIT_LOGS;
  try {
    const raw = localStorage.getItem(LOCAL_AUDIT_LOGS_KEY);
    if (!raw) {
      localStorage.setItem(LOCAL_AUDIT_LOGS_KEY, JSON.stringify(INITIAL_AUDIT_LOGS));
      return INITIAL_AUDIT_LOGS;
    }
    const parsed = JSON.parse(raw) as AuditLogRecord[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : INITIAL_AUDIT_LOGS;
  } catch {
    return INITIAL_AUDIT_LOGS;
  }
}

export function saveLocalAuditLogs(logs: AuditLogRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_AUDIT_LOGS_KEY, JSON.stringify(logs));
  } catch {
    // Ignore quota errors
  }
}

export function appendLocalAuditLogs(newRecords: AuditLogRecord[]): AuditLogRecord[] {
  const existing = loadLocalAuditLogs();
  const combined = [...newRecords, ...existing].slice(0, 1000);
  saveLocalAuditLogs(combined);
  return combined;
}

/**
 * Task 1.2: Centralized audit logging hook `logLeadEvent(eventData)`
 * Can run standalone or concurrently inside a Firestore WriteBatch or Transaction
 * whenever a lead status updates, a deal closes, or an uncalled lead is swept.
 */
export async function logLeadEvent(
  eventData: CreateAuditLogInput,
  firestoreContext?: { batch?: WriteBatch; transaction?: Transaction }
): Promise<AuditLogRecord> {
  const record = buildAuditLogRecord(eventData);
  appendLocalAuditLogs([record]);

  try {
    const auditRef = doc(collection(db, 'audit_logs'), record.id);
    if (firestoreContext?.batch) {
      firestoreContext.batch.set(auditRef, record);
    } else if (firestoreContext?.transaction) {
      firestoreContext.transaction.set(auditRef, record);
    } else {
      await setDoc(auditRef, record);
    }
  } catch {
    // Non-blocking fallback when offline or under restricted preview rules
  }

  return record;
}

/**
 * Batch helper that commits multiple immutable audit log records concurrently
 * in 500-op Firestore chunks and updates local audit state.
 */
export async function logLeadEventsBatch(
  events: CreateAuditLogInput[]
): Promise<AuditLogRecord[]> {
  if (events.length === 0) return [];
  const records = events.map((ev) => buildAuditLogRecord(ev));
  appendLocalAuditLogs(records);

  try {
    const chunks = chunkArray(records, MAX_FIRESTORE_BATCH_OPS);
    for (const chunk of chunks) {
      const wb = writeBatch(db);
      for (const rec of chunk) {
        wb.set(doc(collection(db, 'audit_logs'), rec.id), rec);
      }
      await wb.commit();
    }
  } catch {
    // Non-blocking fallback
  }

  return records;
}

/**
 * Fetches latest audit logs from Firestore `audit_logs` collection if available.
 */
export async function fetchAuditLogsFromFirestore(maxEntries = 100): Promise<AuditLogRecord[]> {
  const local = loadLocalAuditLogs();
  try {
    const q = query(
      collection(db, 'audit_logs'),
      limit(maxEntries)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const remote: AuditLogRecord[] = [];
      snap.forEach((d) => remote.push(d.data() as AuditLogRecord));
      const byId = new Map<string, AuditLogRecord>();
      for (const r of [...remote, ...local]) {
        byId.set(r.id, r);
      }
      const merged = Array.from(byId.values()).sort((a, b) =>
        b.timestamp.localeCompare(a.timestamp)
      );
      saveLocalAuditLogs(merged);
      return merged;
    }
  } catch {
    // Use local audit logs fallback
  }
  return local;
}
