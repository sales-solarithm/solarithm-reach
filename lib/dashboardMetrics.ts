import { AuthorizedUser, BatchRecord, LeadRecord } from './types';
import { computeRepTodayCallsFromLeads } from '@/components/settings/TargetSettings';
import { areRepEmailsEquivalentPure } from './dailyStatsService';
import { AnalyticsDateFilter, resolveDateRangeBounds } from './performanceAnalytics';
import { getTodayIstDateString } from '@/types/batch';

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
  interestedCount?: number;
}

/**
 * Evaluates whether a lead matches the active global Workspace Date Range Filter
 * (`TODAY`, `LAST_7_DAYS`, `THIS_MONTH`, `LAST_30_DAYS`, `ALL_TIME`, `CUSTOM`).
 * - When `TODAY` is selected, matches leads where `lastCalledDate`, `updatedAt`, `interestedAt`, or `closedWonAt`
 *   matches today's `YYYY-MM-DD` date string.
 * - When `LAST_7_DAYS`, `THIS_MONTH`, `LAST_30_DAYS`, or `CUSTOM` is selected, calculates dynamic `[startDateStr, endDateStr]`
 *   bounds against `nowIso` and checks whether the lead's activity date falls within that window.
 */
export function doesLeadMatchWorkspaceDateFilterPure(
  lead: LeadRecord,
  dateFilter?: AnalyticsDateFilter | null,
  nowIso: string = new Date().toISOString()
): boolean {
  if (!dateFilter || dateFilter.preset === 'ALL_TIME') {
    return true;
  }

  const nowDate = new Date(nowIso);
  const todayIst = getTodayIstDateString(nowDate);
  const todayUtc = nowDate.toISOString().slice(0, 10);

  const candidateYmds = new Set<string>();
  const addYmd = (raw?: string | null) => {
    if (!raw) return;
    const ymd = String(raw).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      candidateYmds.add(ymd);
    }
  };

  addYmd(lead.lastCalledDate);
  addYmd(lead.interestedAt);
  addYmd(lead.closedWonAt);
  if (!lead.lastCalledDate || lead.updatedAt !== lead.createdAt) {
    addYmd(lead.updatedAt);
  }
  if (candidateYmds.size === 0) {
    addYmd(lead.updatedAt);
    addYmd(lead.createdAt);
  }

  if (candidateYmds.size === 0) {
    return false;
  }

  if (dateFilter.preset === 'TODAY') {
    return candidateYmds.has(todayIst) || candidateYmds.has(todayUtc);
  }

  const bounds = resolveDateRangeBounds(dateFilter, nowIso);
  const startYmd = bounds.startDateStr;
  const endYmd = bounds.endDateStr >= todayIst ? bounds.endDateStr : todayIst;

  for (const ymd of candidateYmds) {
    if (ymd >= startYmd && ymd <= endYmd) {
      return true;
    }
  }
  return false;
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
export function computeOwnerMetricStripPure(
  leads: LeadRecord[],
  _authorizedUsers: AuthorizedUser[] = [],
  batches: BatchRecord[] = [],
  dateFilter?: AnalyticsDateFilter | null,
  nowIso: string = new Date().toISOString()
): OwnerMetricStripData {
  let totalFreshPool = 0;
  let proposalsShared = 0;
  let interestedOwnerQueue = 0;
  let futureRequirement = 0;
  let deadClosedOut = 0;

  for (const lead of leads) {
    if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') {
      totalFreshPool++;
      continue;
    }

    if (!doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)) {
      continue;
    }

    if (lead.status === 'PROPOSAL_SHARED') {
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

  const nowDate = new Date(nowIso);
  const todayIst = getTodayIstDateString(nowDate);
  const todayUtc = nowDate.toISOString().slice(0, 10);
  let callsDialedToday = 0;

  const isRangePreset =
    dateFilter &&
    dateFilter.preset !== 'TODAY' &&
    dateFilter.preset !== 'ALL_TIME';

  for (const lead of leads) {
    if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') continue;
    if (isRangePreset) {
      if (
        lead.lastCalledDate &&
        doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)
      ) {
        callsDialedToday += 1;
      }
    } else if (
      lead.lastCalledDate &&
      (lead.lastCalledDate.startsWith(todayIst) ||
        lead.lastCalledDate.startsWith(todayUtc))
    ) {
      callsDialedToday += 1;
    }
  }

  // Requirement 2: Prevent drift between batch completedCallsCount and global Calls Dialed Today
  let batchCompletedCallsToday = 0;
  for (const b of batches) {
    if (b.date === todayIst || b.date === todayUtc) {
      batchCompletedCallsToday += b.completedCallsCount || 0;
    }
  }
  callsDialedToday = Math.max(callsDialedToday, batchCompletedCallsToday);

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
 * Computes the Status Metric Strip values for the Sales Rep view:
 * 1. Batch Leads Remaining (Uncalled FRESH leads remaining in their claimed batch)
 * 2. My Calls Today (Total numbers dialed today / selected period)
 * 3. Proposals Pending Follow-up (Due within 48 hours)
 * 4. Interested (Owner Queue) (Leads converted to Interested by this rep)
 * 5. Future Requirements Due (Due this week)
 */
export function computeSalesRepMetricStripPure(
  leads: LeadRecord[],
  batches: BatchRecord[],
  repEmail: string,
  dateFilter?: AnalyticsDateFilter | null,
  nowIso: string = new Date().toISOString()
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

  const isRangePreset =
    dateFilter &&
    dateFilter.preset !== 'TODAY' &&
    dateFilter.preset !== 'ALL_TIME';

  const myCallsToday = isRangePreset
    ? leads.filter(
        (l) =>
          l.status !== 'FRESH' &&
          l.status !== 'REVIVED_FRESH' &&
          Boolean(l.lastCalledDate) &&
          areRepEmailsEquivalentPure(
            l.lastCalledByEmail || l.assignedRepEmail,
            normalizedEmail,
            l.lastCalledByName || l.assignedRepName
          ) &&
          doesLeadMatchWorkspaceDateFilterPure(l, dateFilter, nowIso)
      ).length
    : computeRepTodayCallsFromLeads(normalizedEmail, leads);

  const proposalsPendingFollowUp = leads.filter(
    (l) =>
      l.status === 'PROPOSAL_SHARED' &&
      (!l.assignedRepEmail ||
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName)) &&
      doesLeadMatchWorkspaceDateFilterPure(l, dateFilter, nowIso)
  ).length;

  const futureRequirementsDue = leads.filter(
    (l) =>
      l.status === 'FUTURE_REQUIREMENT' &&
      (!l.assignedRepEmail ||
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName)) &&
      doesLeadMatchWorkspaceDateFilterPure(l, dateFilter, nowIso)
  ).length;

  const interestedCount = leads.filter(
    (l) =>
      l.status === 'INTERESTED' &&
      (!l.assignedRepEmail ||
        areRepEmailsEquivalentPure(l.assignedRepEmail, normalizedEmail, l.assignedRepName) ||
        areRepEmailsEquivalentPure(l.escalatedByEmail, normalizedEmail, l.escalatedByName) ||
        areRepEmailsEquivalentPure(l.lastCalledByEmail, normalizedEmail, l.lastCalledByName)) &&
      doesLeadMatchWorkspaceDateFilterPure(l, dateFilter, nowIso)
  ).length;

  return {
    batchLeadsRemaining,
    myCallsToday,
    proposalsPendingFollowUp,
    futureRequirementsDue,
    interestedCount,
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
