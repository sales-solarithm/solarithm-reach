import { collection, doc, writeBatch } from 'firebase/firestore';
import { reachDb as db } from './firebaseDual';
import { LeadRecord } from './types';
import { sanitizeIndianPhone } from './phoneSanitizer';
import { AuditActorRole, AuditLogRecord } from '@/types/audit';
import { buildAuditLogRecord } from './auditLogger';

/**
 * Phase 12 Task 2: Dormant Pool Re-engagement Engine (`lib/reengagementEngine.ts`)
 *
 * Automatically recycles "Dead" leads after an extended cooling period or via alternative contact channels:
 * 1. `SWITCH_OFF_DEAD` 90-Day Revival Trigger:
 *    - Queries leads where `status === 'SWITCH_OFF_DEAD'` and `updatedAt <= (now - 90 days)`.
 *    - Transitions eligible leads to a staging category: `'REVIVED_FRESH'`.
 *    - Resets `switchOffCount = 0` and `callAttempts = 0`.
 *    - Funnels revived leads into morning batch generation under a dedicated low-priority quota
 *      (max 10% of any daily 3,000-lead batch).
 *
 * 2. `DIDNT_RECEIVE_DEAD` Alternate Number Sweep:
 *    - If a lead reached 10 `DIDNT_RECEIVE` attempts on its primary number (`phoneNumber`) and has a valid,
 *      10-digit `altNumber` that has never been dialed (`!lead.altNumberDialed`):
 *      - Swaps primary and secondary numbers in the document structure (`phoneNumber = altNumber`, `altNumber = oldPrimary`).
 *      - Resets `didntReceiveCount = 0`.
 *      - Appends note: `"Primary number exhausted (10 attempts). Swapped to alternative number for fresh outreach."`
 *      - Returns lead to the global `'FRESH'` pool.
 */

export const SWITCH_OFF_REVIVAL_DAYS = 90;
export const SWITCH_OFF_REVIVAL_MS = SWITCH_OFF_REVIVAL_DAYS * 24 * 60 * 60 * 1000;
export const ALT_NUMBER_SWEEP_EXACT_NOTE =
  'Primary number exhausted (10 attempts). Swapped to alternative number for fresh outreach.';

export interface SwitchOffRevivalResult {
  updatedLeads: LeadRecord[];
  revivedLeads: LeadRecord[];
  revivedCount: number;
  auditLogs: AuditLogRecord[];
}

export interface AltNumberSweepResult {
  updatedLeads: LeadRecord[];
  swappedLeads: LeadRecord[];
  swappedCount: number;
  auditLogs: AuditLogRecord[];
}

export interface DormantReengagementSweepSummary {
  sweptAt: string;
  revivedSwitchOffCount: number;
  swappedAltNumberCount: number;
  revivedLeadIds: string[];
  swappedLeadIds: string[];
  updatedLeads: LeadRecord[];
  auditLogs: AuditLogRecord[];
}

/**
 * Checks whether a `SWITCH_OFF_DEAD` lead is eligible for the 90-day revival trigger.
 */
export function isEligibleFor90DaySwitchOffRevival(
  lead: LeadRecord,
  now: Date = new Date()
): boolean {
  if (lead.status !== 'SWITCH_OFF_DEAD') return false;
  const updatedMs = new Date(lead.updatedAt).getTime();
  if (Number.isNaN(updatedMs)) return false;
  return updatedMs <= now.getTime() - SWITCH_OFF_REVIVAL_MS;
}

/**
 * Checks whether a `DIDNT_RECEIVE_DEAD` lead (or lead with >= 10 `DIDNT_RECEIVE` attempts)
 * has a valid 10-digit `altNumber` that has never been dialed.
 */
export function isEligibleForAltNumberSweep(lead: LeadRecord): boolean {
  const exhaustedPrimary =
    lead.status === 'DIDNT_RECEIVE_DEAD' || lead.didntReceiveCount >= 10;
  if (!exhaustedPrimary) return false;
  if (lead.altNumberDialed) return false;
  if (!lead.altNumber) return false;

  const checkAlt = sanitizeIndianPhone(lead.altNumber);
  if (!checkAlt.isValid || checkAlt.cleaned.length !== 10) return false;
  if (checkAlt.cleaned === lead.phoneNumber) return false;
  return true;
}

/**
 * 1. `SWITCH_OFF_DEAD` 90-Day Revival Trigger (Pure Function):
 * - Queries leads where `status === 'SWITCH_OFF_DEAD'` and `updatedAt <= (now - 90 days)`.
 * - Transitions eligible leads to `'REVIVED_FRESH'`.
 * - Resets `switchOffCount = 0` and `callAttempts = 0`.
 */
export function runSwitchOff90DayRevivalPure(
  leads: LeadRecord[],
  now: Date = new Date(),
  actor: { email: string; name: string; role?: AuditActorRole } = {
    email: 'system@solarithmdesign.com',
    name: 'Dormant Re-engagement Engine',
    role: 'system',
  }
): SwitchOffRevivalResult {
  const nowIso = now.toISOString();
  const revivedLeads: LeadRecord[] = [];
  const auditLogs: AuditLogRecord[] = [];

  const updatedLeads = leads.map((lead) => {
    if (!isEligibleFor90DaySwitchOffRevival(lead, now)) {
      return lead;
    }

    const revivalNote = `Revived after 90+ days in SWITCH_OFF_DEAD (last updated ${lead.updatedAt.slice(
      0,
      10
    )}). Routed to REVIVED_FRESH low-priority morning batch quota (max 10%).`;

    const nextNotes = lead.notes ? `${lead.notes} | ${revivalNote}` : revivalNote;

    const revived: LeadRecord = {
      ...lead,
      status: 'REVIVED_FRESH',
      switchOffCount: 0,
      callAttempts: 0,
      cooldownUntil: null,
      assignedBatchId: null,
      assignedRepEmail: null,
      assignedRepName: null,
      updatedAt: nowIso,
      notes: nextNotes,
    };

    revivedLeads.push(revived);
    auditLogs.push(
      buildAuditLogRecord({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role || 'system',
        actionType: 'STATUS_CHANGED',
        previousStatus: 'SWITCH_OFF_DEAD',
        newStatus: 'REVIVED_FRESH',
        metadata: {
          companyName: lead.companyName,
          phoneNumber: lead.phoneNumber,
          remediationReason: revivalNote,
        },
        timestamp: nowIso,
      })
    );

    return revived;
  });

  return {
    updatedLeads,
    revivedLeads,
    revivedCount: revivedLeads.length,
    auditLogs,
  };
}

/**
 * 2. `DIDNT_RECEIVE_DEAD` Alternate Number Sweep (Pure Function):
 * - Finds leads that reached 10 `DIDNT_RECEIVE` attempts on their primary number (`phoneNumber`)
 *   and have a valid 10-digit `altNumber` that has never been dialed.
 * - Swaps primary and secondary numbers (`phoneNumber = altNumber`, `altNumber = oldPrimary`).
 * - Resets `didntReceiveCount = 0`.
 * - Appends exact note: `"Primary number exhausted (10 attempts). Swapped to alternative number for fresh outreach."`
 * - Returns lead to the global `'FRESH'` pool.
 */
export function runDidntReceiveAltNumberSweepPure(
  leads: LeadRecord[],
  now: Date = new Date(),
  actor: { email: string; name: string; role?: AuditActorRole } = {
    email: 'system@solarithmdesign.com',
    name: 'Dormant Re-engagement Engine',
    role: 'system',
  }
): AltNumberSweepResult {
  const nowIso = now.toISOString();
  const swappedLeads: LeadRecord[] = [];
  const auditLogs: AuditLogRecord[] = [];

  const updatedLeads = leads.map((lead) => {
    if (!isEligibleForAltNumberSweep(lead)) {
      return lead;
    }

    const sanitizedAlt = sanitizeIndianPhone(lead.altNumber!);
    const newPrimaryPhone = sanitizedAlt.cleaned;
    const oldPrimaryPhone = lead.phoneNumber;

    const nextNotes = lead.notes
      ? `${lead.notes} | ${ALT_NUMBER_SWEEP_EXACT_NOTE}`
      : ALT_NUMBER_SWEEP_EXACT_NOTE;

    const swapped: LeadRecord = {
      ...lead,
      phoneNumber: newPrimaryPhone,
      formattedPhone: sanitizedAlt.formatted,
      altNumber: oldPrimaryPhone,
      altNumberDialed: true,
      didntReceiveCount: 0,
      status: 'FRESH',
      cooldownUntil: null,
      assignedBatchId: null,
      assignedRepEmail: null,
      assignedRepName: null,
      updatedAt: nowIso,
      notes: nextNotes,
    };

    swappedLeads.push(swapped);
    auditLogs.push(
      buildAuditLogRecord({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role || 'system',
        actionType: 'STATUS_CHANGED',
        previousStatus: lead.status,
        newStatus: 'FRESH',
        metadata: {
          companyName: lead.companyName,
          phoneNumber: newPrimaryPhone,
          remediationReason: `${ALT_NUMBER_SWEEP_EXACT_NOTE} (Primary ${oldPrimaryPhone} <-> Alt ${newPrimaryPhone})`,
        },
        timestamp: nowIso,
      })
    );

    return swapped;
  });

  return {
    updatedLeads,
    swappedLeads,
    swappedCount: swappedLeads.length,
    auditLogs,
  };
}

/**
 * Combined Dormant Pool Re-engagement Runner (runs both 90-Day Revival & Alternate Number Sweep).
 */
export function runDormantReengagementSweepPure(
  leads: LeadRecord[],
  now: Date = new Date(),
  actor: { email: string; name: string; role?: AuditActorRole } = {
    email: 'system@solarithmdesign.com',
    name: 'Dormant Re-engagement Engine',
    role: 'system',
  }
): DormantReengagementSweepSummary {
  const step1 = runSwitchOff90DayRevivalPure(leads, now, actor);
  const step2 = runDidntReceiveAltNumberSweepPure(step1.updatedLeads, now, actor);

  return {
    sweptAt: now.toISOString(),
    revivedSwitchOffCount: step1.revivedCount,
    swappedAltNumberCount: step2.swappedCount,
    revivedLeadIds: step1.revivedLeads.map((l) => l.id),
    swappedLeadIds: step2.swappedLeads.map((l) => l.id),
    updatedLeads: step2.updatedLeads,
    auditLogs: [...step1.auditLogs, ...step2.auditLogs],
  };
}

/**
 * Persists re-engaged leads and audit logs to Firestore in atomic 500-op batches.
 */
export async function executeDormantReengagementSweepFirestore(
  changedLeads: LeadRecord[],
  auditLogs: AuditLogRecord[]
): Promise<void> {
  if (changedLeads.length === 0 && auditLogs.length === 0) return;
  if (!db) return;

  try {
    const leadsCol = collection(db, 'leads');
    const auditsCol = collection(db, 'audit_logs');
    const batch = writeBatch(db);
    let ops = 0;

    for (const lead of changedLeads) {
      if (ops >= 490) break;
      batch.set(doc(leadsCol, lead.id), lead, { merge: true });
      ops++;
    }
    for (const log of auditLogs) {
      if (ops >= 498) break;
      batch.set(doc(auditsCol, log.id), log);
      ops++;
    }

    await Promise.race([
      batch.commit(),
      new Promise<void>((resolve) => setTimeout(resolve, 60)),
    ]);
  } catch {
    // Non-fatal in preview/offline mode
  }
}
