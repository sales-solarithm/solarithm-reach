import { CANONICAL_NEXUS_EMPLOYEES } from './authService';
import { ActiveReachSalesRep } from './employeeQueries';
import { computeCooldownUntil } from './batchGenerator';
import { computeOperationalDatesForStatus } from './leadStore';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import { CallLogEntry, LeadRecord, LeadStatus, OwnerSubStatus } from './types';
import {
  DailyRepStatRecord,
  resolveCanonicalRepIdentity,
} from './dailyStatsService';

export type AnalyticsDatePreset =
  | 'TODAY'
  | 'LAST_7_DAYS'
  | 'THIS_MONTH'
  | 'LAST_30_DAYS'
  | 'ALL_TIME'
  | 'CUSTOM';

export interface AnalyticsDateFilter {
  preset: AnalyticsDatePreset;
  customStartDate?: string; // YYYY-MM-DD
  customEndDate?: string; // YYYY-MM-DD
}

export interface ResolvedDateBounds {
  preset: AnalyticsDatePreset;
  startMs: number | null;
  endMs: number | null;
  startDateStr: string;
  endDateStr: string;
  dayBuckets: string[]; // Array of YYYY-MM-DD strings for daily charts
}

export interface SparklinePoint {
  date: string;
  label: string;
  calls: number;
}

export interface RepScorecardRow {
  repEmail: string;
  repName: string;
  shortName: string;
  callsDialed: number;
  newLeadsAdded: number;
  proposalsShared: number;
  interestedGenerated: number;
  convertedToClientsWon: number;
  interestedConversionRate: number; // Interested / Calls Dialed %
  wonConversionRate: number; // Won / Interested %
  sparkline7d: SparklinePoint[]; // 7-Day Mini Smooth Sparkline trajectory
}

export interface DailyRepCallPoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "01 Nov"
  totalCalls: number;
  perRepDailyAverage: number;
  [repKey: string]: string | number;
}

export interface DailyOutcomeSplinePoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "01 Nov"
  interestedGenerated: number;
  newLeadsAdded: number;
  convertedToClientsWon: number;
  teamAvgInterested: number;
}

export interface RepComparisonPoint {
  repEmail: string;
  repName: string;
  shortName: string;
  interestedGenerated: number;
  newLeadsAdded: number;
  proposalsShared: number;
  convertedToClientsWon: number;
}

export interface FunnelStagePoint {
  stage: string;
  shortStage: string;
  count: number;
  teamAverageCount?: number;
  conversionFromPrevPct: number;
  conversionFromTopPct: number;
  color: string;
}

export interface DispositionSlicePoint {
  name: string;
  key: string;
  count: number;
  percentage: number;
  color: string;
}

export type RepFocusMode = 'ALL_TEAM' | 'TOP_5' | 'CUSTOM';

export type ScorecardSortField =
  | 'callsDialed'
  | 'newLeadsAdded'
  | 'proposalsShared'
  | 'interestedGenerated'
  | 'convertedToClientsWon'
  | 'interestedConversionRate';

export type SortDirection = 'asc' | 'desc';

export interface OwnerAnalyticsReport {
  bounds: ResolvedDateBounds;
  repSeriesMeta: { repEmail: string; repName: string; shortName: string; color: string }[];
  scorecardRows: RepScorecardRow[];
  totalsRow: {
    callsDialed: number;
    newLeadsAdded: number;
    proposalsShared: number;
    interestedGenerated: number;
    convertedToClientsWon: number;
    interestedConversionRate: number;
    wonConversionRate: number;
  };
  dailyCallingVolumeByRep: DailyRepCallPoint[];
  dailyOutcomeSplineSeries: DailyOutcomeSplinePoint[];
  interestedVsNewLeadsByRep: RepComparisonPoint[];
  pipelineConversionFunnel: FunnelStagePoint[];
  callDispositionBreakdown: DispositionSlicePoint[];
}

export interface SalesRepKpiStrip {
  myCallsSelectedPeriod: number;
  myCallsToday: number;
  dailyTarget: number;
  newLeadsAddedByMe: number;
  proposalsShared: number;
  convertedToInterested: number;
  interestedConvertedToClients: number;
}

export interface SalesRepDailyTrendPoint {
  date: string;
  label: string;
  callsDialed: number;
  dailyTarget: number;
}

export interface SalesRepDailyActivityPoint {
  date: string;
  label: string;
  callsDialed: number;
  newLeadsAdded: number;
  interestedGenerated: number;
}

export interface SalesRepAnalyticsReport {
  bounds: ResolvedDateBounds;
  repEmail: string;
  repName: string;
  kpiStrip: SalesRepKpiStrip;
  myDailyCallingTrend: SalesRepDailyTrendPoint[];
  myConversionPipeline: FunnelStagePoint[];
  myDailyActivityBreakdown: SalesRepDailyActivityPoint[];
}

export const REP_SERIES_PALETTE = [
  '#D4AF37', // Solarithm Gold
  '#10B981', // Emerald
  '#3B82F6', // Blue
  '#8B5CF6', // Violet
  '#F59E0B', // Amber
  '#06B6D4', // Cyan
] as const;

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatShortDateLabel(ymd: string): string {
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parts[2];
  return `${day} ${MONTH_SHORT[monthIdx] || parts[1]}`;
}

export function extractShortRepName(fullName: string): string {
  const cleaned = String(fullName || '')
    .split(' (')[0]
    .trim();
  if (!cleaned) return 'Sales Rep';
  const tokens = cleaned.split(/\s+/);
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[1]}`;
}

function buildDaySequence(startYmd: string, endYmd: string, maxDays = 366): string[] {
  const start = new Date(`${startYmd}T00:00:00.000Z`);
  const end = new Date(`${endYmd}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [endYmd];
  }
  const days: string[] = [];
  const cursor = new Date(start.getTime());
  let guard = 0;
  while (cursor <= end && guard < maxDays) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return days;
}

function expandBoundsForHistoricalLeads(
  bounds: ResolvedDateBounds,
  leads: LeadRecord[],
  nowIso: string,
  dailyStats?: DailyRepStatRecord[]
): ResolvedDateBounds {
  if (bounds.preset !== 'ALL_TIME') {
    return bounds;
  }
  const todayYmd = new Date(nowIso).toISOString().slice(0, 10);
  let earliestYmd = bounds.dayBuckets[0] || todayYmd;

  if (Array.isArray(dailyStats)) {
    for (const st of dailyStats) {
      if (st?.date && /^\d{4}-\d{2}-\d{2}$/.test(st.date) && st.date < earliestYmd && st.date >= '2020-01-01') {
        earliestYmd = st.date;
      }
    }
  }

  for (const lead of leads) {
    const candidates: (string | null | undefined)[] = [
      lead.lastCalledDate,
      lead.interestedAt,
      lead.closedWonAt,
      !lead.importBatchId ? lead.createdAt : null,
    ];
    if (Array.isArray(lead.callHistory)) {
      for (const h of lead.callHistory) {
        candidates.push(h.timestamp);
      }
    }
    for (const ts of candidates) {
      if (!ts) continue;
      const ymd = String(ts).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd < earliestYmd && ymd >= '2020-01-01') {
        earliestYmd = ymd;
      }
    }
  }

  if (earliestYmd < (bounds.dayBuckets[0] || todayYmd)) {
    return {
      ...bounds,
      dayBuckets: buildDaySequence(earliestYmd, todayYmd, 366),
    };
  }
  return bounds;
}

/**
 * Resolves the date filter preset or custom range into UTC epoch bounds and a daily bucket list.
 */
export function resolveDateRangeBounds(
  filter: AnalyticsDateFilter,
  nowIso: string = new Date().toISOString()
): ResolvedDateBounds {
  const nowDate = new Date(nowIso);
  const todayYmd = nowDate.toISOString().slice(0, 10);
  const endOfTodayMs = new Date(`${todayYmd}T23:59:59.999Z`).getTime();

  const shiftDaysYmd = (baseYmd: string, deltaDays: number): string => {
    const d = new Date(`${baseYmd}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  };

  if (filter.preset === 'TODAY') {
    const startMs = new Date(`${todayYmd}T00:00:00.000Z`).getTime();
    const chartStartYmd = shiftDaysYmd(todayYmd, -6);
    return {
      preset: 'TODAY',
      startMs,
      endMs: endOfTodayMs,
      startDateStr: todayYmd,
      endDateStr: todayYmd,
      dayBuckets: buildDaySequence(chartStartYmd, todayYmd),
    };
  }

  if (filter.preset === 'LAST_7_DAYS') {
    const startYmd = shiftDaysYmd(todayYmd, -6);
    const startMs = new Date(`${startYmd}T00:00:00.000Z`).getTime();
    return {
      preset: 'LAST_7_DAYS',
      startMs,
      endMs: endOfTodayMs,
      startDateStr: startYmd,
      endDateStr: todayYmd,
      dayBuckets: buildDaySequence(startYmd, todayYmd),
    };
  }

  if (filter.preset === 'THIS_MONTH') {
    const startYmd = `${todayYmd.slice(0, 7)}-01`;
    const startMs = new Date(`${startYmd}T00:00:00.000Z`).getTime();
    return {
      preset: 'THIS_MONTH',
      startMs,
      endMs: endOfTodayMs,
      startDateStr: startYmd,
      endDateStr: todayYmd,
      dayBuckets: buildDaySequence(startYmd, todayYmd),
    };
  }

  if (filter.preset === 'LAST_30_DAYS') {
    const startYmd = shiftDaysYmd(todayYmd, -29);
    const startMs = new Date(`${startYmd}T00:00:00.000Z`).getTime();
    return {
      preset: 'LAST_30_DAYS',
      startMs,
      endMs: endOfTodayMs,
      startDateStr: startYmd,
      endDateStr: todayYmd,
      dayBuckets: buildDaySequence(startYmd, todayYmd),
    };
  }

  if (filter.preset === 'CUSTOM') {
    const startYmd = filter.customStartDate || shiftDaysYmd(todayYmd, -6);
    const endYmd = filter.customEndDate || todayYmd;
    const startMs = new Date(`${startYmd}T00:00:00.000Z`).getTime();
    const endMs = new Date(`${endYmd}T23:59:59.999Z`).getTime();
    return {
      preset: 'CUSTOM',
      startMs: Number.isNaN(startMs) ? null : startMs,
      endMs: Number.isNaN(endMs) ? null : endMs,
      startDateStr: startYmd,
      endDateStr: endYmd,
      dayBuckets: buildDaySequence(startYmd, endYmd),
    };
  }

  // ALL_TIME
  const defaultChartStart = shiftDaysYmd(todayYmd, -13);
  return {
    preset: 'ALL_TIME',
    startMs: null,
    endMs: null,
    startDateStr: 'All Time',
    endDateStr: todayYmd,
    dayBuckets: buildDaySequence(defaultChartStart, todayYmd),
  };
}

export function isIsoTimestampWithinBounds(
  iso: string | null | undefined,
  bounds: ResolvedDateBounds
): boolean {
  if (!iso) return false;
  if (bounds.startMs === null && bounds.endMs === null) return true;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    const ymd = String(iso).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      const ymdMs = new Date(`${ymd}T12:00:00.000Z`).getTime();
      if (bounds.startMs !== null && ymdMs < bounds.startMs) return false;
      if (bounds.endMs !== null && ymdMs > bounds.endMs) return false;
      return true;
    }
    return false;
  }
  if (bounds.startMs !== null && ms < bounds.startMs) return false;
  if (bounds.endMs !== null && ms > bounds.endMs) return false;
  return true;
}

/**
 * Pure state transition when a Sales Rep or Owner logs a call disposition or converts an Interested lead
 * to `CLOSED_WON` / `LEAD_LOST`.
 */
export function applyCallDispositionUpdatePure(
  lead: LeadRecord,
  params: {
    newStatus: LeadStatus;
    ownerSubStatus?: OwnerSubStatus;
    callDate?: string; // YYYY-MM-DD or ISO
    notes?: string;
    editedCompanyName?: string;
    actorUser: {
      email: string;
      name: string;
      isOwnerTier?: boolean;
      role?: string;
    };
    nowIso?: string;
  }
): LeadRecord {
  const nowIso = params.nowIso || new Date().toISOString();
  const actorEmail = params.actorUser.email.toLowerCase().trim();
  const actorName = params.actorUser.name.split(' (')[0].trim();

  const trimmedEditedName =
    params.editedCompanyName !== undefined
      ? params.editedCompanyName.trim()
      : '';
  const hasCompanyNameEdit =
    Boolean(trimmedEditedName) && trimmedEditedName !== lead.companyName;

  let callDateIso = nowIso;
  if (params.callDate) {
    const trimmed = params.callDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      callDateIso =
        trimmed === nowIso.slice(0, 10)
          ? nowIso
          : new Date(`${trimmed}T10:00:00.000Z`).toISOString();
    } else {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        callDateIso = parsed.toISOString();
      }
    }
  }

  const isExistingInterestedLead = lead.status === 'INTERESTED';
  let finalStatus: LeadStatus = params.newStatus;
  let nextDidntReceive = lead.didntReceiveCount || 0;
  let nextSwitchOff = lead.switchOffCount || 0;
  let nextCooldown: string | null = lead.cooldownUntil || null;
  let nextFollowUp: string | null = lead.nextFollowUpDate || null;
  let nextOwnerSubStatus: OwnerSubStatus | null | undefined =
    lead.ownerSubStatus ?? null;
  let nextOwnerCallAttempts: number = lead.ownerCallAttempts || 0;
  let nextLastOwnerCalledDate: string | null = lead.lastOwnerCalledDate || null;

  // Rule: Once a lead reaches `INTERESTED` (Owner Closing Queue), it must NEVER return to `FRESH`, `REVIVED_FRESH`, `DIDNT_RECEIVE`, or `SWITCH_OFF`.
  if (isExistingInterestedLead || params.ownerSubStatus !== undefined) {
    if (params.newStatus === 'CLOSED_WON') {
      finalStatus = 'CLOSED_WON';
      nextOwnerSubStatus = 'WON';
      nextOwnerCallAttempts += 1;
      nextLastOwnerCalledDate = callDateIso;
      nextCooldown = null;
      nextFollowUp = null;
    } else if (params.newStatus === 'LEAD_LOST') {
      finalStatus = 'LEAD_LOST';
      nextOwnerSubStatus = 'LOST';
      nextOwnerCallAttempts += 1;
      nextLastOwnerCalledDate = callDateIso;
      nextCooldown = null;
      nextFollowUp = null;
    } else {
      // Lock lead in INTERESTED (Owner Closing Pipeline)
      finalStatus = 'INTERESTED';
      const resolvedSubStatus: OwnerSubStatus =
        params.ownerSubStatus ||
        (lead.ownerSubStatus &&
        lead.ownerSubStatus !== 'WON' &&
        lead.ownerSubStatus !== 'LOST'
          ? lead.ownerSubStatus
          : 'PENDING_FIRST_CALL');
      nextOwnerSubStatus = resolvedSubStatus;
      nextOwnerCallAttempts += 1;
      nextLastOwnerCalledDate = callDateIso;
      nextCooldown = null;
      if (resolvedSubStatus === 'QUOTE_SHARED') {
        nextFollowUp = computeOperationalDatesForStatus(
          'PROPOSAL_SHARED',
          callDateIso
        ).nextFollowUpDate;
      } else if (resolvedSubStatus === 'FUTURE_PROJECT') {
        nextFollowUp = computeOperationalDatesForStatus(
          'FUTURE_REQUIREMENT',
          callDateIso
        ).nextFollowUpDate;
      } else {
        nextFollowUp = lead.nextFollowUpDate || null;
      }
    }
  } else {
    // Standard Sales Rep cold-calling / follow-up state machine
    if (params.newStatus === 'DIDNT_RECEIVE') {
      nextDidntReceive += 1;
      if (nextDidntReceive >= 10) {
        finalStatus = 'DIDNT_RECEIVE_DEAD';
        nextCooldown = null;
      } else {
        nextCooldown = computeCooldownUntil(callDateIso);
      }
      nextFollowUp = null;
    } else if (params.newStatus === 'SWITCH_OFF') {
      nextSwitchOff += 1;
      if (nextSwitchOff >= 3) {
        finalStatus = 'SWITCH_OFF_DEAD';
      }
      nextCooldown = null;
      nextFollowUp = null;
    } else if (
      params.newStatus === 'PROPOSAL_SHARED' ||
      params.newStatus === 'FUTURE_REQUIREMENT'
    ) {
      const opDates = computeOperationalDatesForStatus(
        params.newStatus,
        callDateIso
      );
      nextCooldown = opDates.cooldownUntil;
      nextFollowUp = opDates.nextFollowUpDate;
    } else if (params.newStatus === 'INTERESTED') {
      nextOwnerSubStatus = lead.ownerSubStatus || 'PENDING_FIRST_CALL';
      nextOwnerCallAttempts = lead.ownerCallAttempts || 0;
      nextCooldown = null;
      nextFollowUp = null;
    } else if (params.newStatus === 'CLOSED_WON') {
      nextOwnerSubStatus = 'WON';
      nextCooldown = null;
      nextFollowUp = null;
    } else if (params.newStatus === 'LEAD_LOST') {
      nextOwnerSubStatus = 'LOST';
      nextCooldown = null;
      nextFollowUp = null;
    } else {
      nextCooldown = null;
      nextFollowUp = null;
    }
  }

  const nextInterestedAt =
    finalStatus === 'INTERESTED' || finalStatus === 'CLOSED_WON'
      ? lead.interestedAt || callDateIso
      : lead.interestedAt || null;

  const nextClosedWonAt =
    finalStatus === 'CLOSED_WON'
      ? lead.closedWonAt || nowIso
      : lead.closedWonAt || null;

  const nextLeadLostAt =
    finalStatus === 'LEAD_LOST'
      ? lead.leadLostAt || nowIso
      : lead.leadLostAt || null;

  const preservedRepEmail = lead.assignedRepEmail
    ? lead.assignedRepEmail.toLowerCase().trim()
    : actorEmail;
  const preservedRepName = lead.assignedRepName
    ? lead.assignedRepName.split(' (')[0].trim()
    : actorName;

  const statusNoteSummary =
    finalStatus === 'INTERESTED' && nextOwnerSubStatus
      ? `INTERESTED (${nextOwnerSubStatus})`
      : finalStatus;

  const newLogEntry: CallLogEntry = {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: callDateIso,
    repEmail: actorEmail,
    repName: actorName,
    previousStatus: lead.status,
    newStatus: finalStatus,
    note: params.notes?.trim() || `Status updated to ${statusNoteSummary}`,
  };

  const existingHistory = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  const existingCleanNotes =
    lead.notes &&
    !lead.notes.startsWith('Ingested via Excel/CSV Pre-Flight Pipeline') &&
    !lead.notes.startsWith('Historical status (')
      ? lead.notes.trim()
      : '';
  const incomingNoteTrimmed = params.notes?.trim() || '';
  const nextNotes = incomingNoteTrimmed
    ? existingCleanNotes
      ? `${existingCleanNotes} | ${incomingNoteTrimmed}`
      : incomingNoteTrimmed
    : existingCleanNotes;

  // Single-Field Trick: Whenever a lead is called and its status changes from 'FRESH' to anything else,
  // set assignedBatchId = null on the lead so every lead with assignedBatchId == myBatch.batchId is guaranteed FRESH.
  const nextAssignedBatchId =
    finalStatus === 'FRESH' || finalStatus === 'REVIVED_FRESH'
      ? lead.assignedBatchId || null
      : null;

  const isOwnerPipelineUpdate =
    isExistingInterestedLead || params.ownerSubStatus !== undefined;
  const wasFreshBeforeUpdate =
    lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH';
  const callDateYmd = callDateIso.slice(0, 10);
  const alreadyCalledToday =
    !wasFreshBeforeUpdate &&
    Boolean(lead.lastCalledDate && lead.lastCalledDate.slice(0, 10) === callDateYmd);

  // Only increment sales rep cold-call attempt counters when transitioning away from FRESH
  // or when logging a genuinely new day follow-up call (never on Owner pipeline sub-status edits
  // or same-day repeat edits on an already-called lead).
  const shouldIncrementRepCallCount =
    !isOwnerPipelineUpdate && (wasFreshBeforeUpdate || !alreadyCalledToday);

  return sanitizeFirestorePayload({
    ...lead,
    companyName: hasCompanyNameEdit ? trimmedEditedName : lead.companyName,
    companyNameNormalized: hasCompanyNameEdit
      ? trimmedEditedName.toLowerCase()
      : lead.companyNameNormalized,
    isNameManuallyEdited: hasCompanyNameEdit
      ? true
      : Boolean(lead.isNameManuallyEdited),
    status: finalStatus,
    ownerSubStatus: nextOwnerSubStatus ?? null,
    ownerCallAttempts: nextOwnerCallAttempts,
    lastOwnerCalledDate: nextLastOwnerCalledDate,
    assignedBatchId: nextAssignedBatchId,
    callAttempts: shouldIncrementRepCallCount
      ? (lead.callAttempts || 0) + 1
      : Math.max(1, lead.callAttempts || 1),
    callCount: shouldIncrementRepCallCount
      ? (lead.callCount ?? lead.callAttempts ?? 0) + 1
      : Math.max(1, lead.callCount ?? lead.callAttempts ?? 1),
    didntReceiveCount: nextDidntReceive,
    switchOffCount: nextSwitchOff,
    lastCalledDate: isOwnerPipelineUpdate
      ? lead.lastCalledDate || callDateIso
      : callDateIso,
    lastCalledByEmail: isOwnerPipelineUpdate
      ? lead.lastCalledByEmail || preservedRepEmail
      : actorEmail,
    lastCalledByName: isOwnerPipelineUpdate
      ? lead.lastCalledByName || preservedRepName
      : actorName,
    interestedAt: nextInterestedAt,
    closedWonAt: nextClosedWonAt,
    leadLostAt: nextLeadLostAt,
    cooldownUntil: nextCooldown,
    nextFollowUpDate: nextFollowUp,
    notes: nextNotes,
    lastCallNotes: incomingNoteTrimmed || lead.lastCallNotes || null,
    assignedRepEmail: preservedRepEmail,
    assignedRepName: preservedRepName,
    callHistory: [...existingHistory, newLogEntry],
    updatedAt: nowIso,
  });
}

function normalizeRepIdentityEmail(
  email?: string | null,
  name?: string | null
): string | null {
  const resolved = resolveCanonicalRepIdentity(email, name);
  if (resolved?.email) return resolved.email.toLowerCase().trim();
  if (email && email.trim() && email.toLowerCase().trim() !== 'historical@solarithmdesign.com') {
    return email.toLowerCase().trim();
  }
  return null;
}

function resolveAttributedRepEmailForLead(lead: LeadRecord): string | null {
  const fromAssigned = normalizeRepIdentityEmail(lead.assignedRepEmail, lead.assignedRepName);
  if (fromAssigned) return fromAssigned;
  const fromLastCalled = normalizeRepIdentityEmail(
    lead.lastCalledByEmail,
    lead.lastCalledByName
  );
  if (fromLastCalled) return fromLastCalled;
  if (lead.createdByEmail && lead.createdByRole === 'SALES') {
    return normalizeRepIdentityEmail(lead.createdByEmail, lead.createdByName);
  }
  return null;
}

function getRepCallDatesOnLead(
  lead: LeadRecord,
  repEmailLower: string,
  bounds: ResolvedDateBounds
): string[] {
  const targetCanonical = normalizeRepIdentityEmail(repEmailLower, null) || repEmailLower;
  const matchedDates: string[] = [];
  const attributedRep = resolveAttributedRepEmailForLead(lead);

  if (Array.isArray(lead.callHistory) && lead.callHistory.length > 0) {
    for (const entry of lead.callHistory) {
      const entryRaw = entry.repEmail?.toLowerCase().trim();
      const entryCanonical = normalizeRepIdentityEmail(entry.repEmail, entry.repName);
      if (
        (entryCanonical === targetCanonical ||
          entryRaw === repEmailLower ||
          (entryRaw === 'historical@solarithmdesign.com' &&
            attributedRep === targetCanonical)) &&
        isIsoTimestampWithinBounds(entry.timestamp, bounds)
      ) {
        matchedDates.push(entry.timestamp.slice(0, 10));
      }
    }
    if (matchedDates.length > 0) {
      return matchedDates;
    }
  }

  const isCalled = (lead.callAttempts || 0) > 0 || Boolean(lead.lastCalledDate);
  if (!isCalled) return [];

  const callerCanonical =
    normalizeRepIdentityEmail(
      lead.lastCalledByEmail || lead.assignedRepEmail,
      lead.lastCalledByName || lead.assignedRepName
    ) || attributedRep;

  if (callerCanonical !== targetCanonical) return [];

  const effectiveTimestamp = lead.lastCalledDate || lead.updatedAt || lead.createdAt;
  if (isIsoTimestampWithinBounds(effectiveTimestamp, bounds)) {
    return [effectiveTimestamp.slice(0, 10)];
  }
  return [];
}

/**
 * Determines the default Rep Focus Mode based on total active reps:
 * - When > 5 active reps, defaults to `'TOP_5'` so the multi-line chart never renders > 5 lines at once.
 * - Otherwise defaults to `'TOP_5'` (which shows up to 5 active reps cleanly).
 */
export function resolveDefaultRepFocusMode(activeRepCount: number): RepFocusMode {
  return activeRepCount > 5 ? 'TOP_5' : 'TOP_5';
}

/**
 * Filters and sorts the Daily Sales Rep Scorecard Table for 30+ reps.
 */
export function filterAndSortScorecardRows(
  rows: RepScorecardRow[],
  searchQuery: string,
  sortField: ScorecardSortField = 'callsDialed',
  sortDirection: SortDirection = 'desc'
): RepScorecardRow[] {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.repName.toLowerCase().includes(q) ||
          r.repEmail.toLowerCase().includes(q) ||
          r.shortName.toLowerCase().includes(q)
      )
    : [...rows];

  const dir = sortDirection === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const valA = a[sortField];
    const valB = b[sortField];
    if (valA !== valB) {
      return (valA - valB) * dir;
    }
    return b.callsDialed - a.callsDialed || a.repName.localeCompare(b.repName);
  });

  return filtered;
}

/**
 * 3. Owner Analytics Dashboard Pure Calculation Engine
 */
export function computeOwnerAnalyticsPure(
  leads: LeadRecord[],
  activeReps: ActiveReachSalesRep[],
  filter: AnalyticsDateFilter,
  nowIso: string = new Date().toISOString(),
  dailyStats?: DailyRepStatRecord[]
): OwnerAnalyticsReport {
  const baseBounds = resolveDateRangeBounds(filter, nowIso);
  const bounds = expandBoundsForHistoricalLeads(baseBounds, leads, nowIso, dailyStats);
  const sparklineBounds = resolveDateRangeBounds({ preset: 'LAST_7_DAYS' }, nowIso);

  // Build set of known Owner/Admin emails so Owners are never listed as Sales Reps in the Rep Scorecard
  const ownerEmailSet = new Set<string>();
  for (const emp of CANONICAL_NEXUS_EMPLOYEES) {
    const rUpper = String(emp.role || emp.assignedRole || '').toUpperCase();
    if (rUpper === 'OWNER' || rUpper === 'ADMIN') {
      for (const e of [
        emp.email,
        emp.officialEmail,
        emp.personalEmail,
        emp.personalEmailAddress,
      ]) {
        if (e) ownerEmailSet.add(e.toLowerCase().trim());
      }
    }
  }
  for (const rep of activeReps) {
    const rUpper = String(rep.role || '').toUpperCase();
    if (rUpper === 'OWNER' || rUpper === 'ADMIN') {
      ownerEmailSet.add(rep.email.toLowerCase().trim());
    }
  }

  // Build canonical list of Sales Reps
  const repMap = new Map<string, { repEmail: string; repName: string; shortName: string }>();

  for (const emp of CANONICAL_NEXUS_EMPLOYEES) {
    const rUpper = String(emp.role || emp.assignedRole || '').toUpperCase();
    const statusUpper = String(emp.status || 'ACTIVE').toUpperCase();
    if (statusUpper === 'ACTIVE' && (rUpper === 'SALES' || rUpper === 'LEAD_SALES')) {
      const emailLower = (emp.officialEmail || emp.email).toLowerCase().trim();
      repMap.set(emailLower, {
        repEmail: emailLower,
        repName: emp.name.split(' (')[0].trim(),
        shortName: extractShortRepName(emp.name),
      });
    }
  }

  for (const rep of activeReps) {
    const canonical = normalizeRepIdentityEmail(rep.email, rep.name) || rep.email.toLowerCase().trim();
    const roleUpper = String(rep.role || '').toUpperCase();
    if (
      (roleUpper === 'SALES' || roleUpper === 'LEAD_SALES') &&
      !ownerEmailSet.has(canonical) &&
      !ownerEmailSet.has(rep.email.toLowerCase().trim())
    ) {
      if (!repMap.has(canonical)) {
        repMap.set(canonical, {
          repEmail: canonical,
          repName: rep.name.split(' (')[0].trim(),
          shortName: extractShortRepName(rep.name),
        });
      }
    }
  }

  if (Array.isArray(dailyStats)) {
    for (const st of dailyStats) {
      const emailLower = normalizeRepIdentityEmail(st.repEmail, st.repName);
      if (!emailLower || ownerEmailSet.has(emailLower)) continue;
      if (!repMap.has(emailLower)) {
        const resolvedName = (st.repName || emailLower).split(' (')[0].trim();
        repMap.set(emailLower, {
          repEmail: emailLower,
          repName: resolvedName,
          shortName: extractShortRepName(resolvedName),
        });
      }
    }
  }

  for (const lead of leads) {
    const candidates: { email?: string | null; name?: string | null }[] = [
      { email: lead.assignedRepEmail, name: lead.assignedRepName },
      { email: lead.lastCalledByEmail, name: lead.lastCalledByName },
      {
        email: lead.createdByRole === 'SALES' ? lead.createdByEmail : null,
        name: lead.createdByName,
      },
    ];
    for (const c of candidates) {
      const emailLower = normalizeRepIdentityEmail(c.email, c.name);
      if (
        !emailLower ||
        emailLower === 'historical@solarithmdesign.com' ||
        ownerEmailSet.has(emailLower)
      ) {
        continue;
      }
      if (!repMap.has(emailLower)) {
        const resolvedName = (c.name || emailLower).split(' (')[0].trim();
        repMap.set(emailLower, {
          repEmail: emailLower,
          repName: resolvedName,
          shortName: extractShortRepName(resolvedName),
        });
      }
    }
  }

  const repList = Array.from(repMap.values());
  const activeRepCount = Math.max(repList.length, 1);

  const allRangeBounds: ResolvedDateBounds = {
    ...bounds,
    startMs: new Date(`${bounds.dayBuckets[0]}T00:00:00.000Z`).getTime(),
    endMs: new Date(
      `${bounds.dayBuckets[bounds.dayBuckets.length - 1]}T23:59:59.999Z`
    ).getTime(),
  };

  const dailyBucketMap = new Map<string, DailyRepCallPoint>();
  const dailyOutcomeMap = new Map<string, DailyOutcomeSplinePoint>();

  for (const ymd of bounds.dayBuckets) {
    const label = formatShortDateLabel(ymd);
    const point: DailyRepCallPoint = {
      date: ymd,
      label,
      totalCalls: 0,
      perRepDailyAverage: 0,
    };
    for (const r of repList) {
      point[r.repEmail] = 0;
    }
    dailyBucketMap.set(ymd, point);
    dailyOutcomeMap.set(ymd, {
      date: ymd,
      label,
      interestedGenerated: 0,
      newLeadsAdded: 0,
      convertedToClientsWon: 0,
      teamAvgInterested: 0,
    });
  }

  const scorecardRows: RepScorecardRow[] = repList.map((rep) => {
    let callsDialed = 0;
    let newLeadsAdded = 0;
    let proposalsShared = 0;
    let interestedGenerated = 0;
    let convertedToClientsWon = 0;

    const sparkMap = new Map<string, number>();
    for (const ymd of sparklineBounds.dayBuckets) {
      sparkMap.set(ymd, 0);
    }

    for (const lead of leads) {
      // 1. Calls Dialed in selected period
      const callDatesInPeriod = getRepCallDatesOnLead(lead, rep.repEmail, bounds);
      if (callDatesInPeriod.length > 0) {
        callsDialed += 1;
      }

      // Populate daily chart buckets for this rep
      const callDatesForChart = getRepCallDatesOnLead(lead, rep.repEmail, allRangeBounds);
      for (const ymd of callDatesForChart) {
        const bucket = dailyBucketMap.get(ymd);
        if (bucket) {
          bucket[rep.repEmail] = Number(bucket[rep.repEmail] || 0) + 1;
          bucket.totalCalls += 1;
        }
      }

      // Populate 7-day sparkline buckets for this rep
      const callDatesForSpark = getRepCallDatesOnLead(lead, rep.repEmail, sparklineBounds);
      for (const ymd of callDatesForSpark) {
        if (sparkMap.has(ymd)) {
          sparkMap.set(ymd, (sparkMap.get(ymd) || 0) + 1);
        }
      }

      // 2. New Leads Added manually via "+ Add Lead" by this rep in selected period
      const createdByLower = lead.createdByEmail?.toLowerCase().trim();
      if (
        createdByLower === rep.repEmail &&
        !lead.importBatchId &&
        isIsoTimestampWithinBounds(lead.createdAt, bounds)
      ) {
        newLeadsAdded += 1;
      }

      if (createdByLower === rep.repEmail && !lead.importBatchId && lead.createdAt) {
        const createdYmd = lead.createdAt.slice(0, 10);
        const outBucket = dailyOutcomeMap.get(createdYmd);
        if (outBucket) {
          outBucket.newLeadsAdded += 1;
        }
      }

      // Attribution for pipeline milestones
      const attributedRep = resolveAttributedRepEmailForLead(lead);
      if (attributedRep === rep.repEmail) {
        if (
          lead.status === 'PROPOSAL_SHARED' &&
          isIsoTimestampWithinBounds(
            lead.lastCalledDate || lead.updatedAt || lead.createdAt,
            bounds
          )
        ) {
          proposalsShared += 1;
        }

        const wasInterested =
          lead.status === 'INTERESTED' ||
          lead.status === 'CLOSED_WON' ||
          Boolean(lead.interestedAt);
        const interestedTimestamp =
          lead.interestedAt || lead.lastCalledDate || lead.updatedAt || lead.createdAt;
        if (wasInterested && isIsoTimestampWithinBounds(interestedTimestamp, bounds)) {
          interestedGenerated += 1;
        }
        if (wasInterested && interestedTimestamp) {
          const intYmd = interestedTimestamp.slice(0, 10);
          const outBucket = dailyOutcomeMap.get(intYmd);
          if (outBucket) {
            outBucket.interestedGenerated += 1;
          }
        }

        const wonTimestamp =
          lead.closedWonAt || lead.updatedAt || lead.lastCalledDate || lead.createdAt;
        if (
          lead.status === 'CLOSED_WON' &&
          isIsoTimestampWithinBounds(wonTimestamp, bounds)
        ) {
          convertedToClientsWon += 1;
        }
        if (lead.status === 'CLOSED_WON' && wonTimestamp) {
          const wonYmd = wonTimestamp.slice(0, 10);
          const outBucket = dailyOutcomeMap.get(wonYmd);
          if (outBucket) {
            outBucket.convertedToClientsWon += 1;
          }
        }
      }
    }

    // Reconcile with lightweight daily_stats summary records when present (50,000+ lead mode)
    if (Array.isArray(dailyStats) && dailyStats.length > 0) {
      let statsCallsInPeriod = 0;
      let statsNewLeadsInPeriod = 0;
      let statsProposalsInPeriod = 0;
      let statsInterestedInPeriod = 0;
      let statsWonInPeriod = 0;

      for (const st of dailyStats) {
        const stEmail = normalizeRepIdentityEmail(st.repEmail, st.repName);
        if (stEmail !== rep.repEmail) continue;

        if (isIsoTimestampWithinBounds(st.date, bounds)) {
          statsCallsInPeriod += st.callsCount || 0;
          statsNewLeadsInPeriod += st.newLeadsAdded || 0;
          statsProposalsInPeriod += st.proposalsCount || 0;
          statsInterestedInPeriod += st.interestedCount || 0;
          statsWonInPeriod += st.wonCount || 0;
        }

        const bucket = dailyBucketMap.get(st.date);
        if (bucket) {
          const prevRepCalls = Number(bucket[rep.repEmail] || 0);
          const nextRepCalls = Math.max(prevRepCalls, st.callsCount || 0);
          bucket[rep.repEmail] = nextRepCalls;
        }

        if (sparkMap.has(st.date)) {
          sparkMap.set(
            st.date,
            Math.max(sparkMap.get(st.date) || 0, st.callsCount || 0)
          );
        }
      }

      callsDialed = Math.max(callsDialed, statsCallsInPeriod);
      newLeadsAdded = Math.max(newLeadsAdded, statsNewLeadsInPeriod);
      proposalsShared = Math.max(proposalsShared, statsProposalsInPeriod);
      interestedGenerated = Math.max(interestedGenerated, statsInterestedInPeriod);
      convertedToClientsWon = Math.max(convertedToClientsWon, statsWonInPeriod);
    }

    const interestedConversionRate =
      callsDialed > 0 ? Number(((interestedGenerated / callsDialed) * 100).toFixed(1)) : 0;
    const wonConversionRate =
      interestedGenerated > 0
        ? Number(((convertedToClientsWon / interestedGenerated) * 100).toFixed(1))
        : convertedToClientsWon > 0
          ? 100
          : 0;

    const sparkline7d: SparklinePoint[] = sparklineBounds.dayBuckets.map((ymd) => ({
      date: ymd,
      label: formatShortDateLabel(ymd),
      calls: sparkMap.get(ymd) || 0,
    }));

    return {
      repEmail: rep.repEmail,
      repName: rep.repName,
      shortName: rep.shortName,
      callsDialed,
      newLeadsAdded,
      proposalsShared,
      interestedGenerated,
      convertedToClientsWon,
      interestedConversionRate,
      wonConversionRate,
      sparkline7d,
    };
  });

  if (Array.isArray(dailyStats) && dailyStats.length > 0) {
    // Recompute totalCalls per day bucket from reconciled rep values and outcome buckets from dailyStats
    const statsOutcomeByDay = new Map<
      string,
      { interested: number; newLeads: number; won: number }
    >();
    for (const st of dailyStats) {
      const cur = statsOutcomeByDay.get(st.date) || {
        interested: 0,
        newLeads: 0,
        won: 0,
      };
      cur.interested += st.interestedCount || 0;
      cur.newLeads += st.newLeadsAdded || 0;
      cur.won += st.wonCount || 0;
      statsOutcomeByDay.set(st.date, cur);
    }

    for (const [ymd, point] of dailyBucketMap.entries()) {
      let sumRepCalls = 0;
      for (const r of repList) {
        sumRepCalls += Number(point[r.repEmail] || 0);
      }
      point.totalCalls = Math.max(point.totalCalls, sumRepCalls);
    }

    for (const [ymd, outPoint] of dailyOutcomeMap.entries()) {
      const stDay = statsOutcomeByDay.get(ymd);
      if (stDay) {
        outPoint.interestedGenerated = Math.max(
          outPoint.interestedGenerated,
          stDay.interested
        );
        outPoint.newLeadsAdded = Math.max(outPoint.newLeadsAdded, stDay.newLeads);
        outPoint.convertedToClientsWon = Math.max(
          outPoint.convertedToClientsWon,
          stDay.won
        );
      }
    }
  }

  // Sort scorecard rows by Calls Dialed desc, then Interested desc
  scorecardRows.sort(
    (a, b) =>
      b.callsDialed - a.callsDialed ||
      b.interestedGenerated - a.interestedGenerated ||
      a.repName.localeCompare(b.repName)
  );

  // Order repSeriesMeta in the exact performance rank order so Top 5 is deterministic
  const repSeriesMeta = scorecardRows.map((r, idx) => ({
    repEmail: r.repEmail,
    repName: r.repName,
    shortName: r.shortName,
    color: REP_SERIES_PALETTE[idx % REP_SERIES_PALETTE.length],
  }));

  // Compute perRepDailyAverage for each daily bucket
  for (const point of dailyBucketMap.values()) {
    point.perRepDailyAverage = Number((point.totalCalls / activeRepCount).toFixed(1));
  }
  for (const outPoint of dailyOutcomeMap.values()) {
    outPoint.teamAvgInterested = Number(
      (outPoint.interestedGenerated / activeRepCount).toFixed(1)
    );
  }

  let totalDialedGlobal = 0;
  let totalProposalsGlobal = 0;
  let totalInterestedGlobal = 0;
  let totalClosedWonGlobal = 0;

  let dispDidntReceive = 0;
  let dispProposalShared = 0;
  let dispFutureReq = 0;
  let dispInterested = 0;
  let dispNotInterested = 0;
  let dispSwitchOff = 0;

  for (const lead of leads) {
    const callTs = lead.lastCalledDate || lead.updatedAt || lead.createdAt;
    const isCalledInPeriod =
      ((lead.callAttempts || 0) > 0 || Boolean(lead.lastCalledDate)) &&
      isIsoTimestampWithinBounds(callTs, bounds);

    if (isCalledInPeriod) {
      totalDialedGlobal += 1;

      if (lead.status === 'PROPOSAL_SHARED') {
        dispProposalShared += 1;
      } else if (lead.status === 'FUTURE_REQUIREMENT') {
        dispFutureReq += 1;
      } else if (lead.status === 'INTERESTED' || lead.status === 'CLOSED_WON') {
        dispInterested += 1;
      } else if (
        lead.status === 'NOT_INTERESTED' ||
        lead.status === 'NOT_A_SOLAR_COMPANY' ||
        lead.status === 'LEAD_LOST'
      ) {
        dispNotInterested += 1;
      } else if (
        lead.status === 'SWITCH_OFF' ||
        lead.status === 'SWITCH_OFF_DEAD' ||
        (lead.status === 'FRESH' && (lead.switchOffCount || 0) > 0)
      ) {
        dispSwitchOff += 1;
      } else if (
        lead.status === 'DIDNT_RECEIVE' ||
        lead.status === 'DIDNT_RECEIVE_DEAD' ||
        (lead.status === 'FRESH' && (lead.didntReceiveCount || 0) > 0)
      ) {
        dispDidntReceive += 1;
      }
    }

    if (
      (lead.status === 'PROPOSAL_SHARED' ||
        lead.status === 'INTERESTED' ||
        lead.status === 'CLOSED_WON') &&
      isIsoTimestampWithinBounds(callTs, bounds)
    ) {
      if (lead.status === 'PROPOSAL_SHARED') {
        totalProposalsGlobal += 1;
      }
    }

    const wasInterested =
      lead.status === 'INTERESTED' ||
      lead.status === 'CLOSED_WON' ||
      Boolean(lead.interestedAt);
    if (
      wasInterested &&
      isIsoTimestampWithinBounds(lead.interestedAt || callTs, bounds)
    ) {
      totalInterestedGlobal += 1;
    }

    if (
      lead.status === 'CLOSED_WON' &&
      isIsoTimestampWithinBounds(lead.closedWonAt || callTs, bounds)
    ) {
      totalClosedWonGlobal += 1;
    }
  }

  const sumScorecardCalls = scorecardRows.reduce((acc, r) => acc + r.callsDialed, 0);
  const sumScorecardNewLeads = scorecardRows.reduce((acc, r) => acc + r.newLeadsAdded, 0);
  const sumScorecardProposals = scorecardRows.reduce((acc, r) => acc + r.proposalsShared, 0);
  const sumScorecardInterested = scorecardRows.reduce(
    (acc, r) => acc + r.interestedGenerated,
    0
  );
  const sumScorecardWon = scorecardRows.reduce(
    (acc, r) => acc + r.convertedToClientsWon,
    0
  );

  const effectiveTotalDialed = Math.max(totalDialedGlobal, sumScorecardCalls);
  const effectiveTotalProposals = Math.max(totalProposalsGlobal, sumScorecardProposals);
  const effectiveTotalInterested = Math.max(totalInterestedGlobal, sumScorecardInterested);
  const effectiveTotalWon = Math.max(totalClosedWonGlobal, sumScorecardWon);

  const totalsRow = {
    callsDialed: effectiveTotalDialed,
    newLeadsAdded: sumScorecardNewLeads,
    proposalsShared: effectiveTotalProposals,
    interestedGenerated: effectiveTotalInterested,
    convertedToClientsWon: effectiveTotalWon,
    interestedConversionRate:
      effectiveTotalDialed > 0
        ? Number(((effectiveTotalInterested / effectiveTotalDialed) * 100).toFixed(1))
        : 0,
    wonConversionRate:
      effectiveTotalInterested > 0
        ? Number(((effectiveTotalWon / effectiveTotalInterested) * 100).toFixed(1))
        : effectiveTotalWon > 0
          ? 100
          : 0,
  };

  const interestedVsNewLeadsByRep: RepComparisonPoint[] = scorecardRows.map((r) => ({
    repEmail: r.repEmail,
    repName: r.repName,
    shortName: r.shortName,
    interestedGenerated: r.interestedGenerated,
    newLeadsAdded: r.newLeadsAdded,
    proposalsShared: r.proposalsShared,
    convertedToClientsWon: r.convertedToClientsWon,
  }));

  const pipelineConversionFunnel: FunnelStagePoint[] = [
    {
      stage: 'Total Dialed',
      shortStage: 'Total Dialed',
      count: effectiveTotalDialed,
      teamAverageCount: Number((effectiveTotalDialed / activeRepCount).toFixed(1)),
      conversionFromPrevPct: effectiveTotalDialed > 0 ? 100 : 0,
      conversionFromTopPct: effectiveTotalDialed > 0 ? 100 : 0,
      color: '#64748B',
    },
    {
      stage: 'Proposals Shared',
      shortStage: 'Proposals Shared',
      count: effectiveTotalProposals,
      teamAverageCount: Number((effectiveTotalProposals / activeRepCount).toFixed(1)),
      conversionFromPrevPct:
        effectiveTotalDialed > 0
          ? Number(((effectiveTotalProposals / effectiveTotalDialed) * 100).toFixed(1))
          : 0,
      conversionFromTopPct:
        effectiveTotalDialed > 0
          ? Number(((effectiveTotalProposals / effectiveTotalDialed) * 100).toFixed(1))
          : 0,
      color: '#3B82F6',
    },
    {
      stage: 'Interested (Owner Queue)',
      shortStage: 'Interested',
      count: effectiveTotalInterested,
      teamAverageCount: Number((effectiveTotalInterested / activeRepCount).toFixed(1)),
      conversionFromPrevPct:
        effectiveTotalProposals > 0
          ? Number(((effectiveTotalInterested / effectiveTotalProposals) * 100).toFixed(1))
          : effectiveTotalDialed > 0
            ? Number(((effectiveTotalInterested / effectiveTotalDialed) * 100).toFixed(1))
            : 0,
      conversionFromTopPct:
        effectiveTotalDialed > 0
          ? Number(((effectiveTotalInterested / effectiveTotalDialed) * 100).toFixed(1))
          : 0,
      color: '#D4AF37',
    },
    {
      stage: 'Converted to Client (Closed Won)',
      shortStage: 'Closed Won',
      count: effectiveTotalWon,
      teamAverageCount: Number((effectiveTotalWon / activeRepCount).toFixed(1)),
      conversionFromPrevPct:
        effectiveTotalInterested > 0
          ? Number(((effectiveTotalWon / effectiveTotalInterested) * 100).toFixed(1))
          : 0,
      conversionFromTopPct:
        effectiveTotalDialed > 0
          ? Number(((effectiveTotalWon / effectiveTotalDialed) * 100).toFixed(1))
          : 0,
      color: '#10B981',
    },
  ];

  const totalDispositions =
    dispDidntReceive +
    dispProposalShared +
    dispFutureReq +
    dispInterested +
    dispNotInterested +
    dispSwitchOff;

  const pct = (val: number) =>
    totalDispositions > 0 ? Number(((val / totalDispositions) * 100).toFixed(1)) : 0;

  const callDispositionBreakdown: DispositionSlicePoint[] = [
    {
      name: "Didn't Receive",
      key: 'DIDNT_RECEIVE',
      count: dispDidntReceive,
      percentage: pct(dispDidntReceive),
      color: '#64748B',
    },
    {
      name: 'Proposal Shared',
      key: 'PROPOSAL_SHARED',
      count: dispProposalShared,
      percentage: pct(dispProposalShared),
      color: '#3B82F6',
    },
    {
      name: 'Future Requirement',
      key: 'FUTURE_REQUIREMENT',
      count: dispFutureReq,
      percentage: pct(dispFutureReq),
      color: '#6366F1',
    },
    {
      name: 'Interested',
      key: 'INTERESTED',
      count: dispInterested,
      percentage: pct(dispInterested),
      color: '#D4AF37',
    },
    {
      name: 'Not Interested',
      key: 'NOT_INTERESTED',
      count: dispNotInterested,
      percentage: pct(dispNotInterested),
      color: '#EF4444',
    },
    {
      name: 'Switch Off',
      key: 'SWITCH_OFF',
      count: dispSwitchOff,
      percentage: pct(dispSwitchOff),
      color: '#F59E0B',
    },
  ];

  return {
    bounds,
    repSeriesMeta,
    scorecardRows,
    totalsRow,
    dailyCallingVolumeByRep: Array.from(dailyBucketMap.values()),
    dailyOutcomeSplineSeries: Array.from(dailyOutcomeMap.values()),
    interestedVsNewLeadsByRep,
    pipelineConversionFunnel,
    callDispositionBreakdown,
  };
}

/**
 * Computes day-by-day smooth spline series for Chart 02:
 * - Gold Curve (#D4AF37): Interested Generated
 * - Blue Curve (#3B82F6): New Leads Added (+ Add Lead)
 * - Emerald Curve (#10B981): Converted to Clients (Closed Won)
 * Filtered optionally to a specific set of rep emails while preserving teamAvgInterested.
 */
export function computeDailyOutcomeSplineSeriesForRepsPure(
  leads: LeadRecord[],
  bounds: ResolvedDateBounds,
  targetRepEmails: Set<string> | null,
  activeRepCount: number
): DailyOutcomeSplinePoint[] {
  const safeRepCount = Math.max(activeRepCount, 1);
  const bucketMap = new Map<
    string,
    {
      interestedGenerated: number;
      newLeadsAdded: number;
      convertedToClientsWon: number;
      teamTotalInterested: number;
    }
  >();

  for (const ymd of bounds.dayBuckets) {
    bucketMap.set(ymd, {
      interestedGenerated: 0,
      newLeadsAdded: 0,
      convertedToClientsWon: 0,
      teamTotalInterested: 0,
    });
  }

  for (const lead of leads) {
    const createdByLower = lead.createdByEmail?.toLowerCase().trim() || '';
    const attributedRep = resolveAttributedRepEmailForLead(lead) || '';

    const matchesFilterForCreated =
      !targetRepEmails || targetRepEmails.has(createdByLower);
    const matchesFilterForAttributed =
      !targetRepEmails || targetRepEmails.has(attributedRep);

    if (!lead.importBatchId && lead.createdAt && matchesFilterForCreated) {
      const createdYmd = lead.createdAt.slice(0, 10);
      const b = bucketMap.get(createdYmd);
      if (b) {
        b.newLeadsAdded += 1;
      }
    }

    const wasInterested =
      lead.status === 'INTERESTED' ||
      lead.status === 'CLOSED_WON' ||
      Boolean(lead.interestedAt);
    const interestedTs =
      lead.interestedAt || lead.lastCalledDate || lead.updatedAt || lead.createdAt;

    if (wasInterested && interestedTs) {
      const intYmd = interestedTs.slice(0, 10);
      const b = bucketMap.get(intYmd);
      if (b) {
        b.teamTotalInterested += 1;
        if (matchesFilterForAttributed) {
          b.interestedGenerated += 1;
        }
      }
    }

    const wonTs =
      lead.closedWonAt || lead.updatedAt || lead.lastCalledDate || lead.createdAt;
    if (lead.status === 'CLOSED_WON' && wonTs && matchesFilterForAttributed) {
      const wonYmd = wonTs.slice(0, 10);
      const b = bucketMap.get(wonYmd);
      if (b) {
        b.convertedToClientsWon += 1;
      }
    }
  }

  return bounds.dayBuckets.map((ymd) => {
    const item = bucketMap.get(ymd)!;
    return {
      date: ymd,
      label: formatShortDateLabel(ymd),
      interestedGenerated: item.interestedGenerated,
      newLeadsAdded: item.newLeadsAdded,
      convertedToClientsWon: item.convertedToClientsWon,
      teamAvgInterested: Number((item.teamTotalInterested / safeRepCount).toFixed(1)),
    };
  });
}

/**
 * Pure helper that resolves the active subset of reps and recomputes focused series
 * for Charts 01, 02, and 03 when the Owner uses:
 * - `ALL_TEAM` (All Team Aggregate + Per-Rep Daily Average)
 * - `TOP_5` (Top 5 Performers by volume — never renders > 5 lines)
 * - `CUSTOM` (Compare 1 to 6 Checked Reps)
 * - `isolatedRepEmail` (Click-to-Isolate from Scorecard Table against Team Average)
 */
export function resolveFocusedOwnerChartViewPure(
  report: OwnerAnalyticsReport,
  options: {
    focusMode: RepFocusMode;
    customSelectedEmails: string[];
    isolatedRepEmail: string | null;
    leads?: LeadRecord[];
  }
): {
  effectiveMode: 'ALL_TEAM' | 'TOP_5' | 'CUSTOM' | 'ISOLATED_REP';
  visibleRepSeries: { repEmail: string; repName: string; shortName: string; color: string }[];
  focusedComparisonPoints: RepComparisonPoint[];
  focusedDailyOutcomeSplineSeries: DailyOutcomeSplinePoint[];
  focusedPipelineFunnel: FunnelStagePoint[];
  focusedTotals: {
    interestedGenerated: number;
    newLeadsAdded: number;
    convertedToClientsWon: number;
  };
} {
  const { focusMode, customSelectedEmails, isolatedRepEmail, leads } = options;
  const activeRepCount = Math.max(report.scorecardRows.length, 1);

  if (isolatedRepEmail) {
    const cleanIso = isolatedRepEmail.toLowerCase().trim();
    const visibleRepSeries = report.repSeriesMeta.filter(
      (r) => r.repEmail === cleanIso
    );
    const isoRow = report.scorecardRows.find((r) => r.repEmail === cleanIso);
    const focusedComparisonPoints = report.interestedVsNewLeadsByRep.filter(
      (r) => r.repEmail === cleanIso
    );

    const focusedDailyOutcomeSplineSeries = leads
      ? computeDailyOutcomeSplineSeriesForRepsPure(
          leads,
          report.bounds,
          new Set([cleanIso]),
          activeRepCount
        )
      : report.dailyOutcomeSplineSeries;

    const dialed = isoRow?.callsDialed || 0;
    const proposals = isoRow?.proposalsShared || 0;
    const interested = isoRow?.interestedGenerated || 0;
    const won = isoRow?.convertedToClientsWon || 0;

    const focusedPipelineFunnel: FunnelStagePoint[] = [
      {
        stage: 'Total Dialed',
        shortStage: 'Total Dialed',
        count: dialed,
        teamAverageCount: Number((report.totalsRow.callsDialed / activeRepCount).toFixed(1)),
        conversionFromPrevPct: dialed > 0 ? 100 : 0,
        conversionFromTopPct: dialed > 0 ? 100 : 0,
        color: '#64748B',
      },
      {
        stage: 'Proposals Shared',
        shortStage: 'Proposals Shared',
        count: proposals,
        teamAverageCount: Number(
          (report.totalsRow.proposalsShared / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          dialed > 0 ? Number(((proposals / dialed) * 100).toFixed(1)) : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((proposals / dialed) * 100).toFixed(1)) : 0,
        color: '#3B82F6',
      },
      {
        stage: 'Interested (Owner Queue)',
        shortStage: 'Interested',
        count: interested,
        teamAverageCount: Number(
          (report.totalsRow.interestedGenerated / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          proposals > 0
            ? Number(((interested / proposals) * 100).toFixed(1))
            : dialed > 0
              ? Number(((interested / dialed) * 100).toFixed(1))
              : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((interested / dialed) * 100).toFixed(1)) : 0,
        color: '#D4AF37',
      },
      {
        stage: 'Converted to Client (Closed Won)',
        shortStage: 'Closed Won',
        count: won,
        teamAverageCount: Number(
          (report.totalsRow.convertedToClientsWon / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          interested > 0 ? Number(((won / interested) * 100).toFixed(1)) : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((won / dialed) * 100).toFixed(1)) : 0,
        color: '#10B981',
      },
    ];

    return {
      effectiveMode: 'ISOLATED_REP',
      visibleRepSeries,
      focusedComparisonPoints,
      focusedDailyOutcomeSplineSeries,
      focusedPipelineFunnel,
      focusedTotals: {
        interestedGenerated: interested,
        newLeadsAdded: isoRow?.newLeadsAdded || 0,
        convertedToClientsWon: won,
      },
    };
  }

  if (focusMode === 'ALL_TEAM') {
    return {
      effectiveMode: 'ALL_TEAM',
      visibleRepSeries: report.repSeriesMeta.slice(0, 5),
      focusedComparisonPoints: report.interestedVsNewLeadsByRep.slice(0, 10),
      focusedDailyOutcomeSplineSeries: report.dailyOutcomeSplineSeries,
      focusedPipelineFunnel: report.pipelineConversionFunnel,
      focusedTotals: {
        interestedGenerated: report.totalsRow.interestedGenerated,
        newLeadsAdded: report.totalsRow.newLeadsAdded,
        convertedToClientsWon: report.totalsRow.convertedToClientsWon,
      },
    };
  }

  if (focusMode === 'CUSTOM' && customSelectedEmails.length > 0) {
    const selectedSet = new Set(
      customSelectedEmails.slice(0, 6).map((e) => e.toLowerCase().trim())
    );
    const visibleRepSeries = report.repSeriesMeta
      .filter((r) => selectedSet.has(r.repEmail))
      .map((r, idx) => ({
        ...r,
        color: REP_SERIES_PALETTE[idx % REP_SERIES_PALETTE.length],
      }));
    const focusedComparisonPoints = report.interestedVsNewLeadsByRep.filter((r) =>
      selectedSet.has(r.repEmail)
    );
    const focusedDailyOutcomeSplineSeries = leads
      ? computeDailyOutcomeSplineSeriesForRepsPure(
          leads,
          report.bounds,
          selectedSet,
          activeRepCount
        )
      : report.dailyOutcomeSplineSeries;

    const matchingRows = report.scorecardRows.filter((r) =>
      selectedSet.has(r.repEmail)
    );
    const dialed = matchingRows.reduce((s, r) => s + r.callsDialed, 0);
    const proposals = matchingRows.reduce((s, r) => s + r.proposalsShared, 0);
    const interested = matchingRows.reduce((s, r) => s + r.interestedGenerated, 0);
    const won = matchingRows.reduce((s, r) => s + r.convertedToClientsWon, 0);
    const added = matchingRows.reduce((s, r) => s + r.newLeadsAdded, 0);

    const focusedPipelineFunnel: FunnelStagePoint[] = [
      {
        stage: 'Total Dialed',
        shortStage: 'Total Dialed',
        count: dialed,
        teamAverageCount: Number((report.totalsRow.callsDialed / activeRepCount).toFixed(1)),
        conversionFromPrevPct: dialed > 0 ? 100 : 0,
        conversionFromTopPct: dialed > 0 ? 100 : 0,
        color: '#64748B',
      },
      {
        stage: 'Proposals Shared',
        shortStage: 'Proposals Shared',
        count: proposals,
        teamAverageCount: Number(
          (report.totalsRow.proposalsShared / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          dialed > 0 ? Number(((proposals / dialed) * 100).toFixed(1)) : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((proposals / dialed) * 100).toFixed(1)) : 0,
        color: '#3B82F6',
      },
      {
        stage: 'Interested (Owner Queue)',
        shortStage: 'Interested',
        count: interested,
        teamAverageCount: Number(
          (report.totalsRow.interestedGenerated / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          proposals > 0
            ? Number(((interested / proposals) * 100).toFixed(1))
            : dialed > 0
              ? Number(((interested / dialed) * 100).toFixed(1))
              : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((interested / dialed) * 100).toFixed(1)) : 0,
        color: '#D4AF37',
      },
      {
        stage: 'Converted to Client (Closed Won)',
        shortStage: 'Closed Won',
        count: won,
        teamAverageCount: Number(
          (report.totalsRow.convertedToClientsWon / activeRepCount).toFixed(1)
        ),
        conversionFromPrevPct:
          interested > 0 ? Number(((won / interested) * 100).toFixed(1)) : 0,
        conversionFromTopPct:
          dialed > 0 ? Number(((won / dialed) * 100).toFixed(1)) : 0,
        color: '#10B981',
      },
    ];

    return {
      effectiveMode: 'CUSTOM',
      visibleRepSeries,
      focusedComparisonPoints,
      focusedDailyOutcomeSplineSeries,
      focusedPipelineFunnel,
      focusedTotals: {
        interestedGenerated: interested,
        newLeadsAdded: added,
        convertedToClientsWon: won,
      },
    };
  }

  // Default: TOP_5 Performers (automatically caps at 5 lines max)
  const top5Series = report.repSeriesMeta.slice(0, 5);
  const top5Comparison = report.interestedVsNewLeadsByRep.slice(0, 5);
  const top5Emails = new Set(top5Series.map((r) => r.repEmail));
  const focusedDailyOutcomeSplineSeries =
    leads && report.repSeriesMeta.length > 5
      ? computeDailyOutcomeSplineSeriesForRepsPure(
          leads,
          report.bounds,
          top5Emails,
          activeRepCount
        )
      : report.dailyOutcomeSplineSeries;

  return {
    effectiveMode: 'TOP_5',
    visibleRepSeries: top5Series,
    focusedComparisonPoints: top5Comparison,
    focusedDailyOutcomeSplineSeries,
    focusedPipelineFunnel: report.pipelineConversionFunnel,
    focusedTotals: {
      interestedGenerated: report.totalsRow.interestedGenerated,
      newLeadsAdded: report.totalsRow.newLeadsAdded,
      convertedToClientsWon: report.totalsRow.convertedToClientsWon,
    },
  };
}

/**
 * 4. Sales Representative Personal Analytics Dashboard Pure Calculation Engine
 */
export function computeSalesRepAnalyticsPure(
  leads: LeadRecord[],
  repEmail: string,
  repName: string,
  filter: AnalyticsDateFilter,
  dailyTarget: number = 120,
  nowIso: string = new Date().toISOString(),
  dailyStats?: DailyRepStatRecord[]
): SalesRepAnalyticsReport {
  const baseBounds = resolveDateRangeBounds(filter, nowIso);
  const bounds = expandBoundsForHistoricalLeads(baseBounds, leads, nowIso, dailyStats);
  const repEmailLower = repEmail.toLowerCase().trim();
  const repCanonicalEmail = normalizeRepIdentityEmail(repEmailLower, repName) || repEmailLower;
  const todayYmd = nowIso.slice(0, 10);
  const todayBounds = resolveDateRangeBounds({ preset: 'TODAY' }, nowIso);

  const chartRangeBounds: ResolvedDateBounds = {
    ...bounds,
    startMs: new Date(`${bounds.dayBuckets[0]}T00:00:00.000Z`).getTime(),
    endMs: new Date(
      `${bounds.dayBuckets[bounds.dayBuckets.length - 1]}T23:59:59.999Z`
    ).getTime(),
  };

  const dailyMap = new Map<
    string,
    { callsDialed: number; newLeadsAdded: number; interestedGenerated: number }
  >();
  for (const ymd of bounds.dayBuckets) {
    dailyMap.set(ymd, {
      callsDialed: 0,
      newLeadsAdded: 0,
      interestedGenerated: 0,
    });
  }

  let myCallsSelectedPeriod = 0;
  let myCallsToday = 0;
  let newLeadsAddedByMe = 0;
  let proposalsShared = 0;
  let convertedToInterested = 0;
  let interestedConvertedToClients = 0;

  for (const lead of leads) {
    const callDatesPeriod = getRepCallDatesOnLead(lead, repCanonicalEmail, bounds);
    if (callDatesPeriod.length > 0) {
      myCallsSelectedPeriod += 1;
    }

    const callDatesToday = getRepCallDatesOnLead(lead, repCanonicalEmail, todayBounds);
    if (callDatesToday.includes(todayYmd)) {
      myCallsToday += 1;
    }

    const callDatesChart = getRepCallDatesOnLead(lead, repCanonicalEmail, chartRangeBounds);
    for (const ymd of callDatesChart) {
      const bucket = dailyMap.get(ymd);
      if (bucket) {
        bucket.callsDialed += 1;
      }
    }

    const createdByCanonical = normalizeRepIdentityEmail(
      lead.createdByEmail,
      lead.createdByName
    );
    if (createdByCanonical === repCanonicalEmail && !lead.importBatchId) {
      if (isIsoTimestampWithinBounds(lead.createdAt, bounds)) {
        newLeadsAddedByMe += 1;
      }
      const createdYmd = (lead.createdAt || '').slice(0, 10);
      const bucket = dailyMap.get(createdYmd);
      if (bucket) {
        bucket.newLeadsAdded += 1;
      }
    }

    const attributedRep = resolveAttributedRepEmailForLead(lead);
    if (attributedRep === repCanonicalEmail) {
      const callTs = lead.lastCalledDate || lead.updatedAt || lead.createdAt;

      if (
        lead.status === 'PROPOSAL_SHARED' &&
        isIsoTimestampWithinBounds(callTs, bounds)
      ) {
        proposalsShared += 1;
      }

      const wasInterested =
        lead.status === 'INTERESTED' ||
        lead.status === 'CLOSED_WON' ||
        Boolean(lead.interestedAt);
      const interestedTs = lead.interestedAt || callTs;

      if (wasInterested && isIsoTimestampWithinBounds(interestedTs, bounds)) {
        convertedToInterested += 1;
      }

      if (wasInterested && interestedTs) {
        const intYmd = interestedTs.slice(0, 10);
        const bucket = dailyMap.get(intYmd);
        if (bucket) {
          bucket.interestedGenerated += 1;
        }
      }

      const wonTs = lead.closedWonAt || lead.updatedAt || callTs;
      if (
        lead.status === 'CLOSED_WON' &&
        isIsoTimestampWithinBounds(wonTs, bounds)
      ) {
        interestedConvertedToClients += 1;
      }
    }
  }

  // Reconcile with lightweight daily_stats summary records when present (50,000+ lead mode)
  if (Array.isArray(dailyStats) && dailyStats.length > 0) {
    let statsCallsPeriod = 0;
    let statsCallsToday = 0;
    let statsNewLeads = 0;
    let statsProposals = 0;
    let statsInterested = 0;
    let statsWon = 0;

    for (const st of dailyStats) {
      const stEmail = normalizeRepIdentityEmail(st.repEmail, st.repName);
      if (stEmail !== repCanonicalEmail) continue;

      if (st.date === todayYmd) {
        statsCallsToday += st.callsCount || 0;
      }

      if (isIsoTimestampWithinBounds(st.date, bounds)) {
        statsCallsPeriod += st.callsCount || 0;
        statsNewLeads += st.newLeadsAdded || 0;
        statsProposals += st.proposalsCount || 0;
        statsInterested += st.interestedCount || 0;
        statsWon += st.wonCount || 0;
      }

      const bucket = dailyMap.get(st.date);
      if (bucket) {
        bucket.callsDialed = Math.max(bucket.callsDialed, st.callsCount || 0);
        bucket.newLeadsAdded = Math.max(bucket.newLeadsAdded, st.newLeadsAdded || 0);
        bucket.interestedGenerated = Math.max(
          bucket.interestedGenerated,
          st.interestedCount || 0
        );
      }
    }

    myCallsSelectedPeriod = Math.max(myCallsSelectedPeriod, statsCallsPeriod);
    myCallsToday = Math.max(myCallsToday, statsCallsToday);
    newLeadsAddedByMe = Math.max(newLeadsAddedByMe, statsNewLeads);
    proposalsShared = Math.max(proposalsShared, statsProposals);
    convertedToInterested = Math.max(convertedToInterested, statsInterested);
    interestedConvertedToClients = Math.max(
      interestedConvertedToClients,
      statsWon
    );
  }

  const myDailyCallingTrend: SalesRepDailyTrendPoint[] = bounds.dayBuckets.map((ymd) => {
    const item = dailyMap.get(ymd)!;
    return {
      date: ymd,
      label: formatShortDateLabel(ymd),
      callsDialed: item.callsDialed,
      dailyTarget,
    };
  });

  const myDailyActivityBreakdown: SalesRepDailyActivityPoint[] = bounds.dayBuckets.map(
    (ymd) => {
      const item = dailyMap.get(ymd)!;
      return {
        date: ymd,
        label: formatShortDateLabel(ymd),
        callsDialed: item.callsDialed,
        newLeadsAdded: item.newLeadsAdded,
        interestedGenerated: item.interestedGenerated,
      };
    }
  );

  const myConversionPipeline: FunnelStagePoint[] = [
    {
      stage: 'Calls Made',
      shortStage: 'Calls Made',
      count: myCallsSelectedPeriod,
      conversionFromPrevPct: myCallsSelectedPeriod > 0 ? 100 : 0,
      conversionFromTopPct: myCallsSelectedPeriod > 0 ? 100 : 0,
      color: '#64748B',
    },
    {
      stage: 'Proposals Shared',
      shortStage: 'Proposals Shared',
      count: proposalsShared,
      conversionFromPrevPct:
        myCallsSelectedPeriod > 0
          ? Number(((proposalsShared / myCallsSelectedPeriod) * 100).toFixed(1))
          : 0,
      conversionFromTopPct:
        myCallsSelectedPeriod > 0
          ? Number(((proposalsShared / myCallsSelectedPeriod) * 100).toFixed(1))
          : 0,
      color: '#3B82F6',
    },
    {
      stage: 'Clients Converted to Interested',
      shortStage: 'Interested',
      count: convertedToInterested,
      conversionFromPrevPct:
        proposalsShared > 0
          ? Number(((convertedToInterested / proposalsShared) * 100).toFixed(1))
          : myCallsSelectedPeriod > 0
            ? Number(((convertedToInterested / myCallsSelectedPeriod) * 100).toFixed(1))
            : 0,
      conversionFromTopPct:
        myCallsSelectedPeriod > 0
          ? Number(((convertedToInterested / myCallsSelectedPeriod) * 100).toFixed(1))
          : 0,
      color: '#D4AF37',
    },
    {
      stage: 'Interested Converted to Final Clients (Won)',
      shortStage: 'Final Clients (Won)',
      count: interestedConvertedToClients,
      conversionFromPrevPct:
        convertedToInterested > 0
          ? Number(
              ((interestedConvertedToClients / convertedToInterested) * 100).toFixed(1)
            )
          : interestedConvertedToClients > 0
            ? 100
            : 0,
      conversionFromTopPct:
        myCallsSelectedPeriod > 0
          ? Number(
              ((interestedConvertedToClients / myCallsSelectedPeriod) * 100).toFixed(1)
            )
          : 0,
      color: '#10B981',
    },
  ];

  return {
    bounds,
    repEmail: repEmailLower,
    repName: repName.split(' (')[0].trim(),
    kpiStrip: {
      myCallsSelectedPeriod,
      myCallsToday,
      dailyTarget,
      newLeadsAddedByMe,
      proposalsShared,
      convertedToInterested,
      interestedConvertedToClients,
    },
    myDailyCallingTrend,
    myConversionPipeline,
    myDailyActivityBreakdown,
  };
}
