import { collection, doc, setDoc } from 'firebase/firestore';
import { reachDb as db } from './firebaseDual';
import { LeadRecord, UserRole } from './types';
import { AuditLogRecord } from '@/types/audit';
import { buildAuditLogRecord, logLeadEvent } from './auditLogger';

/**
 * Phase 13 Task 3: Outreach Audit & Activity Stamp (`lib/whatsappLogger.ts`)
 *
 * Tracks WhatsApp outreach to prevent over-messaging:
 * 1. Log Dispatch Event:
 *    - Writes an entry to the lead's `audit_logs` subcollection (`leads/{leadId}/audit_logs/{logId}`)
 *      and root `audit_logs` ledger:
 *      - `actionType: 'WHATSAPP_DISPATCHED'`
 *      - `templateName: string`
 *      - `dispatchedByEmail: rep.email`
 *      - `dispatchedAt: new Date().toISOString()`
 * 2. Visual Indicator on Lead Table:
 *    - Checks if a lead received a WhatsApp touchpoint within the past 7 days (`WHATSAPP_TOUCHPOINT_WINDOW_DAYS = 7`).
 */

export const WHATSAPP_TOUCHPOINT_WINDOW_DAYS = 7;
export const WHATSAPP_TOUCHPOINT_WINDOW_MS =
  WHATSAPP_TOUCHPOINT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface WhatsAppAuditSubcollectionEntry {
  id: string;
  leadId: string;
  actionType: 'WHATSAPP_DISPATCHED';
  templateName: string;
  dispatchedByEmail: string;
  dispatchedByName: string;
  dispatchedAt: string;
  compiledMessage: string;
  phoneNumber: string;
}

export interface LogWhatsAppDispatchInput {
  lead: LeadRecord;
  rep: {
    email: string;
    name: string;
    role: UserRole;
  };
  templateName: string;
  compiledMessage: string;
  dispatchedAt?: string;
}

export interface LogWhatsAppDispatchResult {
  updatedLead: LeadRecord;
  subcollectionEntry: WhatsAppAuditSubcollectionEntry;
  auditLogRecord: AuditLogRecord;
}

/**
 * Pure helper to determine whether a lead has received a WhatsApp touchpoint within the past 7 days.
 */
export function hasRecentWhatsAppTouchpoint(
  lead: Pick<LeadRecord, 'lastWhatsAppSentAt'>,
  now: Date = new Date()
): boolean {
  if (!lead.lastWhatsAppSentAt) return false;
  const sentMs = new Date(lead.lastWhatsAppSentAt).getTime();
  if (Number.isNaN(sentMs)) return false;
  const elapsedMs = now.getTime() - sentMs;
  return elapsedMs >= 0 && elapsedMs <= WHATSAPP_TOUCHPOINT_WINDOW_MS;
}

/**
 * Pure state transition & audit record builder when a rep dispatches a WhatsApp message.
 */
export function recordWhatsAppDispatchPure(
  input: LogWhatsAppDispatchInput
): LogWhatsAppDispatchResult {
  const dispatchedAt = input.dispatchedAt || new Date().toISOString();
  const entryId = `wa-audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const subcollectionEntry: WhatsAppAuditSubcollectionEntry = {
    id: entryId,
    leadId: input.lead.id,
    actionType: 'WHATSAPP_DISPATCHED',
    templateName: input.templateName,
    dispatchedByEmail: input.rep.email,
    dispatchedByName: input.rep.name,
    dispatchedAt,
    compiledMessage: input.compiledMessage,
    phoneNumber: input.lead.phoneNumber,
  };

  const updatedLead: LeadRecord = {
    ...input.lead,
    lastWhatsAppSentAt: dispatchedAt,
    lastWhatsAppTemplateName: input.templateName,
    lastWhatsAppSentByEmail: input.rep.email,
    updatedAt: dispatchedAt,
  };

  const auditLogRecord = buildAuditLogRecord({
    id: entryId,
    leadId: input.lead.id,
    actorEmail: input.rep.email,
    actorName: input.rep.name,
    actorRole: input.rep.role,
    actionType: 'WHATSAPP_DISPATCHED',
    previousStatus: input.lead.status,
    newStatus: input.lead.status,
    metadata: {
      companyName: input.lead.companyName,
      phoneNumber: input.lead.phoneNumber,
      batchId: input.lead.assignedBatchId,
      templateName: input.templateName,
      dispatchedByEmail: input.rep.email,
      dispatchedAt,
      compiledMessage: input.compiledMessage,
      callNote: `WhatsApp dispatched (${input.templateName}) to +91 ${input.lead.phoneNumber}`,
    },
    timestamp: dispatchedAt,
  });

  return {
    updatedLead,
    subcollectionEntry,
    auditLogRecord,
  };
}

/**
 * Logs a WhatsApp dispatch event to the lead's `audit_logs` subcollection (`leads/{leadId}/audit_logs/{id}`),
 * updates the lead document, and appends to the global compliance ledger.
 */
export async function logWhatsAppDispatch(
  input: LogWhatsAppDispatchInput
): Promise<LogWhatsAppDispatchResult> {
  const result = recordWhatsAppDispatchPure(input);

  // Append to local + Firestore root audit_logs via logLeadEvent
  await logLeadEvent({
    id: result.auditLogRecord.id,
    leadId: input.lead.id,
    actorEmail: input.rep.email,
    actorName: input.rep.name,
    actorRole: input.rep.role,
    actionType: 'WHATSAPP_DISPATCHED',
    previousStatus: input.lead.status,
    newStatus: input.lead.status,
    metadata: result.auditLogRecord.metadata,
    timestamp: result.subcollectionEntry.dispatchedAt,
  });

  // Also write to the lead's `audit_logs` subcollection: `leads/{leadId}/audit_logs/{entryId}`
  if (db) {
    try {
      const subDocRef = doc(
        collection(db, 'leads', input.lead.id, 'audit_logs'),
        result.subcollectionEntry.id
      );
      const leadDocRef = doc(collection(db, 'leads'), input.lead.id);
      await Promise.race([
        Promise.all([
          setDoc(subDocRef, result.subcollectionEntry),
          setDoc(
            leadDocRef,
            {
              lastWhatsAppSentAt: result.updatedLead.lastWhatsAppSentAt,
              lastWhatsAppTemplateName: result.updatedLead.lastWhatsAppTemplateName,
              lastWhatsAppSentByEmail: result.updatedLead.lastWhatsAppSentByEmail,
              updatedAt: result.updatedLead.updatedAt,
            },
            { merge: true }
          ),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, 60)),
      ]);
    } catch {
      // Non-fatal in preview/offline mode
    }
  }

  return result;
}
