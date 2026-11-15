import { AuthorizedUser, BatchRecord, LeadRecord } from './types';
import { computeRepTodayCallsFromLeads } from '@/components/settings/TargetSettings';
import { areRepEmailsEquivalentPure } from './dailyStatsService';

export interface OwnerMetricStripData {
  totalFreshPool: number;
  proposalsShared: number;
  interestedOwnerQueue: number;
  futureRequirement: number;
  callsDialedToday: number;
  deadClosedOut: number;
  totalAllLeads?: number;
}

export interface SalesRepMetricStripData {
  batchLeadsRemaining: number;
  myCallsToday: number;
  proposalsPendingFollowUp: number;
  futureRequirementsDue: number;
}

/**
 * Computes the 6 Zerodha Kite-style Status Metric Strip values for the Owner view:
 * 1. Total Fresh Pool (Number of uncalled leads)
 * 2. Proposals Shared (Follow-up pipeline)
 * 3. Interested (Owner Queue) (Highlighted with subtle gold border #E5B842)
 * 4. Future Requirement (Scheduled for next month)
 * 5. Calls Dialed Today (Aggregate team output)
 * 6. Dead / Closed Out (Lost + Dead leads)
 */
import { getTodayIstDateString } from '@/types/batch';

export function computeOwnerMetricStripPure(
  leads: LeadRecord[],
  _authorizedUsers: AuthorizedUser[] = []
): OwnerMetricStripData {
  let totalFreshPool = 0;
  let proposalsShared = 0;
  let interestedOwnerQueue = 0;
  let futureRequirement = 0;
  let deadClosedOut = 0;

  for (const lead of leads) {
    if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') {
      totalFreshPool++;
    } else if (lead.status === 'PROPOSAL_SHARED') {
      proposalsShared++;
    } else if (lead.status === 'INTERESTED') {
      interestedOwnerQueue++;
    } else if (lead.status === 'FUTURE_REQUIREMENT') {
      futureRequirement++;
    } else if (
      lead.status === 'LEAD_LOST' ||
      lead.status === 'NOT_INTERESTED' ||
      lead.status === 'NOT_A_SOLAR_COMPANY' ||
      lead.status === 'SWITCH_OFF_DEAD' ||
      lead.status === 'DIDNT_RECEIVE_DEAD' ||
      lead.status === 'CLOSED_WON'
    ) {
      deadClosedOut++;
    }
  }

  const todayIst = getTodayIstDateString();
  const todayUtc = new Date().toISOString().slice(0, 10);
  let callsDialedToday = 0;
  for (const lead of leads) {
    if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') continue;
    if (
      lead.lastCalledDate &&
      (lead.lastCalledDate.startsWith(todayIst) ||
        lead.lastCalledDate.startsWith(todayUtc))
    ) {
      callsDialedToday += 1;
    }
  }

  return {
    totalFreshPool,
    proposalsShared,
    interestedOwnerQueue,
    futureRequirement,
    callsDialedToday,
    deadClosedOut,
  };
}

/**
 * Computes the 4 Zerodha Kite-style Status Metric Strip values for the Sales Rep view:
 * 1. Batch Leads Remaining (Uncalled FRESH leads remaining in their claimed batch)
 * 2. My Calls Today (Total numbers dialed today)
 * 3. Proposals Pending Follow-up (Due within 48 hours)
 * 4. Future Requirements Due (Due this week)
 */
export function computeSalesRepMetricStripPure(
  leads: LeadRecord[],
  batches: BatchRecord[],
  repEmail: string
): SalesRepMetricStripData {
  const normalizedEmail = (repEmail || '').toLowerCase().trim();

  const claimedBatch = batches.find(
    (b) =>
      b.status === 'IN_PROGRESS' &&
      areRepEmailsEquivalentPure(b.claimedByEmail, normalizedEmail, b.claimedByName)
  );

  let batchLeadsRemaining = 0;
  if (claimedBatch) {
    const totalBatchSize =
      claimedBatch.totalLeads ?? claimedBatch.leadIds?.length ?? 0;
    const completedInBatch = claimedBatch.completedCallsCount || 0;
    const counterRemaining =
      claimedBatch.remainingLeads !== undefined
        ? claimedBatch.remainingLeads
        : Math.max(0, totalBatchSize - completedInBatch);

    const batchLeadIdsSet = new Set(claimedBatch.leadIds || []);
    const liveFreshInBatch = leads.filter(
      (l) =>
        (l.status === 'FRESH' || l.status === 'REVIVED_FRESH') &&
        (l.assignedBatchId === claimedBatch.batchId || batchLeadIdsSet.has(l.id))
    ).length;

    // If all leads for this batch are loaded in memory, prefer liveFreshInBatch; if only 50 rows are paged from Firestore, use counterRemaining
    if (leads.length >= totalBatchSize && totalBatchSize > 0) {
      batchLeadsRemaining = liveFreshInBatch;
    } else {
      batchLeadsRemaining = Math.max(liveFreshInBatch, counterRemaining);
    }
  } else {
    batchLeadsRemaining = leads.filter(
      (l) =>
        l.status === 'FRESH' &&
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName)
    ).length;
  }

  const myCallsToday = computeRepTodayCallsFromLeads(normalizedEmail, leads);

  const proposalsPendingFollowUp = leads.filter(
    (l) =>
      l.status === 'PROPOSAL_SHARED' &&
      (!l.assignedRepEmail ||
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName))
  ).length;

  const futureRequirementsDue = leads.filter(
    (l) =>
      l.status === 'FUTURE_REQUIREMENT' &&
      (!l.assignedRepEmail ||
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName))
  ).length;

  return {
    batchLeadsRemaining,
    myCallsToday,
    proposalsPendingFollowUp,
    futureRequirementsDue,
  };
}

/**
 * Filters batches visible to the current user:
 * - Owner / Admin sees all batches.
 * - Sales Rep: if they have claimed 1 batch today, ONLY sees their claimed batch; otherwise sees unclaimed (`AVAILABLE`) batches.
 */
export function filterVisibleBatchesForUserPure(
  batches: BatchRecord[],
  user: AuthorizedUser
): BatchRecord[] {
  const roleUpper = String(user.role || '').trim().toUpperCase();
  if (user.isOwnerTier || roleUpper === 'OWNER' || roleUpper === 'ADMIN') {
    return batches;
  }
  const emailLower = user.email.toLowerCase().trim();
  const claimedBatch = batches.find(
    (b) =>
      b.status === 'IN_PROGRESS' &&
      areRepEmailsEquivalentPure(
        b.claimedByEmail,
        emailLower,
        b.claimedByName,
        user.name
      )
  );
  if (claimedBatch) {
    return [claimedBatch];
  }
  return batches.filter((b) => b.status === 'AVAILABLE');
}
