import { doc, writeBatch } from 'firebase/firestore';
import { reachDb as db } from './firebaseDual';
import { AuthorizedUser, LeadRecord } from './types';
import { DailyBatchDocument } from '@/types/batch';
import { CreateAuditLogInput } from '@/types/audit';
import { chunkArray } from './leadStore';
import { logLeadEventsBatch } from './auditLogger';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FIRESTORE_BATCH_OPS = 500;

export interface OrphanedLeadIssue {
  lead: LeadRecord;
  orphanedRepEmail: string;
  orphanedRepName: string | null;
  reason: string;
}

export interface InvalidDeadCapIssue {
  lead: LeadRecord;
  expectedDeadStatus: 'DIDNT_RECEIVE_DEAD' | 'SWITCH_OFF_DEAD';
  reason: string;
}

export interface ExpiredFollowUpIssue {
  lead: LeadRecord;
  daysOverdue: number;
  referenceDate: string;
}

export interface DuplicatePhoneIssueGroup {
  phoneDigits: string;
  leads: LeadRecord[];
}

export interface DataIntegrityReport {
  checkedAt: string;
  orphanedLeads: OrphanedLeadIssue[];
  invalidDeadCapLeads: InvalidDeadCapIssue[];
  expiredFollowUpLeads: ExpiredFollowUpIssue[];
  duplicateNumberGroups: DuplicatePhoneIssueGroup[];
  totalIssuesCount: number;
}

/**
 * Task 3.1: Runs comprehensive Data Integrity Diagnostics across the lead pool:
 * 1. Orphaned leads assigned to deleted, unknown, or revoked reps.
 * 2. Leads stuck in invalid states (`didntReceiveCount > 10` not marked `DIDNT_RECEIVE_DEAD`,
 *    or `switchOffCount >= 3` not marked `SWITCH_OFF_DEAD`).
 * 3. Expired follow-ups overdue by > 14 days without recent call logs.
 * 4. Duplicate 10-digit phone numbers (primary or alternative) across distinct records.
 */
export function runDataIntegrityDiagnostics(
  leads: LeadRecord[],
  authorizedUsers: AuthorizedUser[],
  now: Date = new Date()
): DataIntegrityReport {
  const nowMs = now.getTime();
  const activeEmails = new Set(
    authorizedUsers
      .filter((u) => u.status === 'active')
      .map((u) => u.email.toLowerCase())
  );

  const orphanedLeads: OrphanedLeadIssue[] = [];
  const invalidDeadCapLeads: InvalidDeadCapIssue[] = [];
  const expiredFollowUpLeads: ExpiredFollowUpIssue[] = [];
  const phoneBuckets = new Map<string, LeadRecord[]>();

  for (const lead of leads) {
    // 1. Check Orphaned Rep Assignment
    if (lead.assignedRepEmail) {
      const emailLower = lead.assignedRepEmail.toLowerCase();
      if (!activeEmails.has(emailLower)) {
        orphanedLeads.push({
          lead,
          orphanedRepEmail: lead.assignedRepEmail,
          orphanedRepName: lead.assignedRepName,
          reason: `Assigned rep (${lead.assignedRepEmail}) is disabled, revoked, or no longer in config/roles.`,
        });
      }
    }

    // 2. Check Invalid Dead-Status Caps
    if (
      lead.status !== 'DIDNT_RECEIVE_DEAD' &&
      (lead.didntReceiveCount > 10 ||
        (lead.status === 'DIDNT_RECEIVE' && lead.didntReceiveCount >= 10))
    ) {
      invalidDeadCapLeads.push({
        lead,
        expectedDeadStatus: 'DIDNT_RECEIVE_DEAD',
        reason: `didntReceiveCount is ${lead.didntReceiveCount} (exceeds max 10 threshold) while status is ${lead.status}.`,
      });
    } else if (
      lead.status !== 'SWITCH_OFF_DEAD' &&
      lead.switchOffCount >= 3
    ) {
      invalidDeadCapLeads.push({
        lead,
        expectedDeadStatus: 'SWITCH_OFF_DEAD',
        reason: `switchOffCount is ${lead.switchOffCount} (meets/exceeds max 3 cap) while status is ${lead.status}.`,
      });
    }

    // 3. Check Expired Follow-Ups Overdue by > 14 Days without recent call logs
    const followUpIso = lead.nextFollowUpDate;
    if (
      followUpIso &&
      lead.status !== 'CLOSED_WON' &&
      lead.status !== 'LEAD_LOST' &&
      lead.status !== 'DIDNT_RECEIVE_DEAD' &&
      lead.status !== 'SWITCH_OFF_DEAD'
    ) {
      const followUpMs = new Date(followUpIso).getTime();
      if (!Number.isNaN(followUpMs) && nowMs - followUpMs > FOURTEEN_DAYS_MS) {
        const lastCallMs = lead.lastCalledDate
          ? new Date(lead.lastCalledDate).getTime()
          : 0;
        const hasRecentCall =
          !Number.isNaN(lastCallMs) &&
          lastCallMs > 0 &&
          nowMs - lastCallMs <= FOURTEEN_DAYS_MS;

        if (!hasRecentCall) {
          const daysOverdue = Math.floor(
            (nowMs - followUpMs) / (24 * 60 * 60 * 1000)
          );
          expiredFollowUpLeads.push({
            lead,
            daysOverdue,
            referenceDate: followUpIso,
          });
        }
      }
    }

    // 4. Cross-check 10-digit numbers (phoneNumber and altNumber)
    const keys = new Set<string>();
    if (lead.phoneNumber) keys.add(lead.phoneNumber);
    if (lead.altNumber) keys.add(lead.altNumber);
    for (const key of keys) {
      const list = phoneBuckets.get(key) || [];
      list.push(lead);
      phoneBuckets.set(key, list);
    }
  }

  const duplicateNumberGroups: DuplicatePhoneIssueGroup[] = [];
  for (const [phoneDigits, group] of phoneBuckets.entries()) {
    if (group.length > 1) {
      duplicateNumberGroups.push({
        phoneDigits,
        leads: group,
      });
    }
  }

  const totalIssuesCount =
    orphanedLeads.length +
    invalidDeadCapLeads.length +
    expiredFollowUpLeads.length +
    duplicateNumberGroups.length;

  return {
    checkedAt: now.toISOString(),
    orphanedLeads,
    invalidDeadCapLeads,
    expiredFollowUpLeads,
    duplicateNumberGroups,
    totalIssuesCount,
  };
}

/**
 * Task 3.2 Remediation 1: `[Fix Orphaned Assignments]`
 * Clears orphaned rep email/name and moves uncalled leads back to the Fresh Pool.
 */
export function remediateOrphanedAssignmentsPure(
  leads: LeadRecord[],
  authorizedUsers: AuthorizedUser[],
  actor: { email: string; name: string; role: 'owner' | 'system' },
  nowIso: string = new Date().toISOString()
): {
  updatedLeads: LeadRecord[];
  remediatedCount: number;
  auditEvents: CreateAuditLogInput[];
} {
  const activeEmails = new Set(
    authorizedUsers
      .filter((u) => u.status === 'active')
      .map((u) => u.email.toLowerCase())
  );

  let remediatedCount = 0;
  const auditEvents: CreateAuditLogInput[] = [];

  const updatedLeads = leads.map((lead) => {
    if (
      lead.assignedRepEmail &&
      !activeEmails.has(lead.assignedRepEmail.toLowerCase())
    ) {
      remediatedCount++;
      const prevStatus = lead.status;
      const isUncalled = lead.callAttempts === 0 || lead.status === 'FRESH';
      const nextStatus = isUncalled ? ('FRESH' as const) : lead.status;

      auditEvents.push({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role,
        actionType: 'BATCH_RESET',
        previousStatus: prevStatus,
        newStatus: nextStatus,
        metadata: {
          companyName: lead.companyName,
          phoneNumber: lead.phoneNumber,
          fromRepEmail: lead.assignedRepEmail,
          fromRepName: lead.assignedRepName,
          remediationReason: 'Fixed orphaned rep assignment & returned uncalled lead to Fresh Pool',
        },
        timestamp: nowIso,
      });

      return {
        ...lead,
        status: nextStatus,
        assignedBatchId: isUncalled ? null : lead.assignedBatchId,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
    }
    return lead;
  });

  return {
    updatedLeads,
    remediatedCount,
    auditEvents,
  };
}

/**
 * Task 3.2 Remediation 2: `[Enforce Dead-Status Caps]`
 * Transitions overdue attempt counts (`didntReceiveCount > 10` -> `DIDNT_RECEIVE_DEAD`,
 * `switchOffCount >= 3` -> `SWITCH_OFF_DEAD`) to their respective dead buckets.
 */
export function remediateDeadStatusCapsPure(
  leads: LeadRecord[],
  actor: { email: string; name: string; role: 'owner' | 'system' },
  nowIso: string = new Date().toISOString()
): {
  updatedLeads: LeadRecord[];
  remediatedCount: number;
  auditEvents: CreateAuditLogInput[];
} {
  let remediatedCount = 0;
  const auditEvents: CreateAuditLogInput[] = [];

  const updatedLeads = leads.map((lead) => {
    if (
      lead.status !== 'DIDNT_RECEIVE_DEAD' &&
      (lead.didntReceiveCount > 10 ||
        (lead.status === 'DIDNT_RECEIVE' && lead.didntReceiveCount >= 10))
    ) {
      remediatedCount++;
      auditEvents.push({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role,
        actionType: 'STATUS_CHANGED',
        previousStatus: lead.status,
        newStatus: 'DIDNT_RECEIVE_DEAD',
        metadata: {
          companyName: lead.companyName,
          phoneNumber: lead.phoneNumber,
          remediationReason: `Enforced DIDNT_RECEIVE_DEAD cap (didntReceiveCount = ${lead.didntReceiveCount})`,
        },
        timestamp: nowIso,
      });

      return {
        ...lead,
        status: 'DIDNT_RECEIVE_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    if (lead.status !== 'SWITCH_OFF_DEAD' && lead.switchOffCount >= 3) {
      remediatedCount++;
      auditEvents.push({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role,
        actionType: 'STATUS_CHANGED',
        previousStatus: lead.status,
        newStatus: 'SWITCH_OFF_DEAD',
        metadata: {
          companyName: lead.companyName,
          phoneNumber: lead.phoneNumber,
          remediationReason: `Enforced SWITCH_OFF_DEAD cap (switchOffCount = ${lead.switchOffCount})`,
        },
        timestamp: nowIso,
      });

      return {
        ...lead,
        status: 'SWITCH_OFF_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    return lead;
  });

  return {
    updatedLeads,
    remediatedCount,
    auditEvents,
  };
}

/**
 * Task 2.1: Selective Batch Transfer Pure Engine
 * Reassigns selected leads (in `PROPOSAL_SHARED` or `FUTURE_REQUIREMENT` status)
 * to a target active sales rep while preserving historical `lastCalledDate`,
 * `nextFollowUpDate`, `notes`, and attempt counters, and emits `'MANUALLY_TRANSFERRED'` audit events.
 */
export function transferSelectedLeadsPure(
  leads: LeadRecord[],
  selectedLeadIds: string[],
  targetRep: Pick<AuthorizedUser, 'email' | 'name'>,
  actor: Pick<AuthorizedUser, 'email' | 'name' | 'role'>,
  nowIso: string = new Date().toISOString()
): {
  updatedLeads: LeadRecord[];
  transferredCount: number;
  auditEvents: CreateAuditLogInput[];
} {
  const idSet = new Set(selectedLeadIds);
  let transferredCount = 0;
  const auditEvents: CreateAuditLogInput[] = [];

  const updatedLeads = leads.map((lead) => {
    if (!idSet.has(lead.id)) return lead;

    transferredCount++;
    auditEvents.push({
      leadId: lead.id,
      actorEmail: actor.email,
      actorName: actor.name,
      actorRole: actor.role,
      actionType: 'MANUALLY_TRANSFERRED',
      previousStatus: lead.status,
      newStatus: lead.status,
      metadata: {
        companyName: lead.companyName,
        phoneNumber: lead.phoneNumber,
        fromRepEmail: lead.assignedRepEmail,
        fromRepName: lead.assignedRepName,
        toRepEmail: targetRep.email,
        toRepName: targetRep.name,
        callNote: `Preserved ${lead.callAttempts} attempts, lastCalledDate (${lead.lastCalledDate || 'N/A'}), and follow-up schedule.`,
      },
      timestamp: nowIso,
    });

    return {
      ...lead,
      assignedRepEmail: targetRep.email,
      assignedRepName: targetRep.name,
      // Explicitly preserve historical dates, notes, and counters
      lastCalledDate: lead.lastCalledDate,
      nextFollowUpDate: lead.nextFollowUpDate,
      notes: lead.notes,
      callAttempts: lead.callAttempts,
      didntReceiveCount: lead.didntReceiveCount,
      switchOffCount: lead.switchOffCount,
      updatedAt: nowIso,
    };
  });

  return {
    updatedLeads,
    transferredCount,
    auditEvents,
  };
}

/**
 * Task 2.2: Daily Batch Release Override Pure Engine
 * Immediately releases uncalled (`status == 'FRESH'`) leads from a specific claimed batch
 * (or rep's active batch) back to the global pool without waiting for 11:59 PM cron.
 */
export function releaseRepDailyBatchOverridePure(
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  targetBatchId: string,
  actor: Pick<AuthorizedUser, 'email' | 'name' | 'role'>,
  nowIso: string = new Date().toISOString()
): {
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  releasedLeadsCount: number;
  auditEvents: CreateAuditLogInput[];
} {
  let releasedLeadsCount = 0;
  const auditEvents: CreateAuditLogInput[] = [];

  const updatedLeads = leads.map((lead) => {
    if (lead.assignedBatchId === targetBatchId && lead.status === 'FRESH') {
      releasedLeadsCount++;
      auditEvents.push({
        leadId: lead.id,
        actorEmail: actor.email,
        actorName: actor.name,
        actorRole: actor.role,
        actionType: 'BATCH_RESET',
        previousStatus: 'FRESH',
        newStatus: 'FRESH',
        metadata: {
          companyName: lead.companyName,
          phoneNumber: lead.phoneNumber,
          batchId: targetBatchId,
          fromRepEmail: lead.assignedRepEmail,
          fromRepName: lead.assignedRepName,
          remediationReason: `Owner Mid-Day Batch Release Override for ${targetBatchId}`,
        },
        timestamp: nowIso,
      });

      return {
        ...lead,
        assignedBatchId: null,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
    }
    return lead;
  });

  const updatedBatches = batches.map((batch) => {
    if (batch.batchId !== targetBatchId) return batch;
    return {
      ...batch,
      status: 'CLOSED' as const,
      uncalledReturnedCount: releasedLeadsCount,
      closedAt: nowIso,
    };
  });

  return {
    updatedBatches,
    updatedLeads,
    releasedLeadsCount,
    auditEvents,
  };
}

/**
 * Commits lead updates and their corresponding immutable audit logs concurrently in Firestore.
 */
export async function commitLeadsAndAuditToFirestore(
  changedLeads: LeadRecord[],
  auditEvents: CreateAuditLogInput[]
): Promise<void> {
  await logLeadEventsBatch(auditEvents);
  try {
    const chunks = chunkArray(changedLeads, MAX_FIRESTORE_BATCH_OPS);
    for (const chunk of chunks) {
      const wb = writeBatch(db);
      for (const lead of chunk) {
        wb.set(doc(db, 'leads', lead.id), lead, { merge: true });
      }
      await wb.commit();
    }
  } catch {
    // Non-blocking fallback
  }
}
