import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  clearCloudSyncError,
  hasLiveReachFirebaseConfig,
  reachDb as db,
  reportCloudSyncError,
  withFirestoreNetworkRetry,
} from './firebaseDual';
import { getActiveSalesReps } from './employeeQueries';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import {
  isLegacyMockBatch,
  isLegacyMockOrSyntheticLead,
} from './leadStore';
import { LeadRecord } from './types';
import {
  DailyBatchDocument,
  DailyStateMetaDocument,
  formatBatchId,
  getTodayIstDateString,
} from '@/types/batch';

export const DEFAULT_BATCH_SIZE = 3000;
export const BUCKET_A_RATIO = 0.75;
export const BUCKET_B_RATIO = 0.25;
export const REVIVED_QUOTA_MAX_RATIO = 0.1;
export const COOLDOWN_HOURS = 48;
export const DAILY_STATE_STORAGE_KEY = 'solarithm_reach_daily_state_v1';

let memoryDailyStateMeta: DailyStateMetaDocument | null = null;

export function loadLocalDailyStateMeta(): DailyStateMetaDocument | null {
  return memoryDailyStateMeta;
}

export function saveLocalDailyStateMeta(state: DailyStateMetaDocument): void {
  memoryDailyStateMeta = state;
}

export interface StratifiedBatchResult {
  batchLeads: LeadRecord[];
  bucketACount: number; // Untouched leads selected
  bucketBCount: number; // Cooldown-cleared retry leads selected
  revivedCount: number; // Low-priority REVIVED_FRESH quota selected (max 10%)
  eligibleBucketATotal: number;
  eligibleBucketBTotal: number;
  eligibleRevivedTotal: number;
  excludedOnCooldownCount: number;
}

export interface StaleBatchSweepResult {
  sweptLeads: LeadRecord[];
  sweptBatches: DailyBatchDocument[];
  releasedLeads: LeadRecord[];
  closedPriorBatches: DailyBatchDocument[];
  hadStaleData: boolean;
}

export interface EqualDailyBatchPartitionResult {
  batches: DailyBatchDocument[];
  updatedBatches: DailyBatchDocument[];
  newBatches: DailyBatchDocument[];
  todayBatches: DailyBatchDocument[];
  closedPriorBatches: DailyBatchDocument[];
  deletedBatchIds: string[];
  releasedLeads: LeadRecord[];
  updatedLeads: LeadRecord[];
  changed: boolean;
  totalEligibleFreshLeads: number;
  activeRepCount: number;
  batchSizePerRep: number;
}

export const DIDNT_RECEIVE_COOLDOWN_HOURS = 48;
export const SWITCH_OFF_RETRY_HOURS = 48;

/**
 * Computes the 48-hour cooldown ISO timestamp from a call date.
 */
export function computeCooldownUntil(callDateIso: string, hours = COOLDOWN_HOURS): string {
  const baseMs = new Date(callDateIso).getTime();
  return new Date(baseMs + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Checks if a lead is currently locked under a mandatory cooldown window
 * (`DIDNT_RECEIVE` >= 48 hours; `SWITCH_OFF` >= configured retry interval).
 */
export function isLeadOnCooldown(
  lead: Pick<
    LeadRecord,
    'cooldownUntil' | 'status' | 'lastCalledDate' | 'lastCalled'
  >,
  now: Date = new Date(),
  switchOffRetryHours: number = SWITCH_OFF_RETRY_HOURS
): boolean {
  const nowMs = now.getTime();
  if (lead.cooldownUntil) {
    const cooldownTime = new Date(lead.cooldownUntil).getTime();
    if (!Number.isNaN(cooldownTime)) {
      return cooldownTime > nowMs;
    }
  }
  const rawLastCalled = lead.lastCalledDate || lead.lastCalled || null;
  if (
    (lead.status === 'DIDNT_RECEIVE' || lead.status === 'SWITCH_OFF') &&
    rawLastCalled
  ) {
    const calledMs = new Date(rawLastCalled).getTime();
    if (!Number.isNaN(calledMs)) {
      const requiredHours =
        lead.status === 'SWITCH_OFF'
          ? switchOffRetryHours
          : DIDNT_RECEIVE_COOLDOWN_HOURS;
      return calledMs + requiredHours * 60 * 60 * 1000 > nowMs;
    }
  }
  return false;
}

/**
 * Priority 1 (Top of Batch): Untouched fresh leads (`status === 'FRESH'` and `callAttempts === 0` and no prior retry counts).
 * Priority 2 (Bottom of Batch / Tail End): Re-entry / retry leads (`DIDNT_RECEIVE` or `SWITCH_OFF` that have cleared cooldown, or leads with `callAttempts > 0`).
 */
export function isUntouchedPriority1LeadPure(
  lead: Pick<
    LeadRecord,
    'status' | 'callAttempts' | 'didntReceiveCount' | 'switchOffCount'
  >
): boolean {
  return (
    lead.status === 'FRESH' &&
    (lead.callAttempts || 0) === 0 &&
    (lead.didntReceiveCount || 0) === 0 &&
    (lead.switchOffCount || 0) === 0
  );
}

/**
 * Sorts a batch's leads so that:
 * 1. Priority 1 (Top of Batch): All untouched fresh leads (`status == 'FRESH'` and `callAttempts == 0`) appear first.
 * 2. Priority 2 (Bottom of Batch / Tail End): All cooled-down re-entry / retry leads (`DIDNT_RECEIVE` / `SWITCH_OFF` / `callAttempts > 0`) appear strictly at the tail end.
 */
export function sortBatchLeadsUntouchedFirstRetriesTailPure(
  leads: LeadRecord[],
  batchLeadIdsOrder?: string[]
): LeadRecord[] {
  const orderMap = new Map<string, number>();
  if (Array.isArray(batchLeadIdsOrder)) {
    for (let i = 0; i < batchLeadIdsOrder.length; i++) {
      orderMap.set(batchLeadIdsOrder[i], i);
    }
  }
  return [...leads].sort((a, b) => {
    const pA = isUntouchedPriority1LeadPure(a) ? 0 : 1;
    const pB = isUntouchedPriority1LeadPure(b) ? 0 : 1;
    if (pA !== pB) return pA - pB;

    const idxA = orderMap.get(a.id);
    const idxB = orderMap.get(b.id);
    if (idxA !== undefined && idxB !== undefined && idxA !== idxB) {
      return idxA - idxB;
    }
    return 0;
  });
}

/**
 * Extracts `YYYY-MM-DD` from a canonical batchId (`BATCH_YYYY_MM_DD_XX`), or returns null.
 */
export function extractDateFromBatchIdPure(batchId: string | null | undefined): string | null {
  if (!batchId) return null;
  const match = String(batchId)
    .trim()
    .match(/^BATCH_(\d{4})_(\d{2})_(\d{2})_/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Checks whether a `batchId` belongs to an active (non-CLOSED) batch for `todayDate` (`YYYY-MM-DD`).
 * Returns `false` ONLY if `batchId` is null/empty, belongs to a strictly past date (`batchDate < todayDate`),
 * or points to a batch that is already `CLOSED`.
 */
export function doesBatchBelongToTodayPure(
  batchId: string | null | undefined,
  todayDate: string = getTodayIstDateString(),
  batches: DailyBatchDocument[] = []
): boolean {
  if (!batchId) return false;
  const trimmed = String(batchId).trim();
  if (!trimmed) return false;

  const matchedBatch = batches.find((b) => b.batchId === trimmed);
  if (matchedBatch) {
    return matchedBatch.date >= todayDate && matchedBatch.status !== 'CLOSED';
  }

  const parsedDate = extractDateFromBatchIdPure(trimmed);
  if (parsedDate) {
    return parsedDate >= todayDate;
  }

  const todayBatchPrefix = `BATCH_${todayDate.replace(/-/g, '_')}_`;
  return trimmed.startsWith(todayBatchPrefix);
}

/**
 * Auto-Sweep Stale Batches, Prior-Day Uncalled FRESH Leads & Cooled-Down Re-Entry Leads:
 * 1. Retention During Current Day:
 *    - Leads marked `DIDNT_RECEIVE` or `SWITCH_OFF` during `todayDate` (`lastCalledDate` starts with `todayDate`)
 *      remain tagged with their current status (`DIDNT_RECEIVE` / `SWITCH_OFF`) so they appear in `Calls Dialed Today`
 *      and are NEVER prematurely pushed back into active circulation before the daily reset cycle.
 * 2. Midnight / Daily Reset Sweep Execution:
 *    - Checks all leads whose status is `DIDNT_RECEIVE` or `SWITCH_OFF` from prior days (`!lastCalledDate.startsWith(todayDate)`)
 *      and whose `lastCalledDate` / `cooldownUntil` satisfies their required cooldown window (`DIDNT_RECEIVE` >= 48h, `SWITCH_OFF` >= retry interval).
 *    - Releases those eligible re-entry leads back into the pool (`status: 'FRESH'`, `cooldownUntil: null`, `assignedBatchId: null`)
 *      with their `callAttempts`, `didntReceiveCount`, and `switchOffCount` preserved so they are placed at the tail end of today's batches.
 * 3. Closes any batch where `batch.date < todayDate` and releases prior-day uncalled `FRESH` leads.
 */
export function autoSweepStaleBatchesAndReleaseLeadsPure(
  allLeads: LeadRecord[],
  existingBatches: DailyBatchDocument[],
  todayDate: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString(),
  switchOffRetryHours: number = SWITCH_OFF_RETRY_HOURS
): StaleBatchSweepResult {
  const releasedCountByBatch = new Map<string, number>();
  const releasedLeads: LeadRecord[] = [];

  const nowDate = new Date(nowIso);
  const sweptLeads = allLeads.map((lead) => {
    const rawLastCalled = lead.lastCalledDate || lead.lastCalled || null;
    const calledDateYmd = rawLastCalled ? rawLastCalled.slice(0, 10) : null;
    const wasCalledToday = Boolean(calledDateYmd && calledDateYmd >= todayDate);
    const hasExplicitExpiredCooldown =
      Boolean(lead.cooldownUntil) &&
      !Number.isNaN(new Date(lead.cooldownUntil!).getTime()) &&
      new Date(lead.cooldownUntil!).getTime() <= nowDate.getTime();

    // Exclude Active Cooldown Leads from Fresh Pool Allocation:
    // Any lead marked DIDNT_RECEIVE or SWITCH_OFF whose cooldownUntil > currentISOString
    // remains in an inactive holding state with assignedBatchId = null until its 48-hour timer expires.
    if (
      (lead.status === 'DIDNT_RECEIVE' || lead.status === 'SWITCH_OFF') &&
      isLeadOnCooldown(lead, nowDate, switchOffRetryHours)
    ) {
      if (lead.assignedBatchId !== null) {
        return {
          ...lead,
          assignedBatchId: null,
          updatedAt: nowIso,
        };
      }
      return lead;
    }

    // Re-Entry After Cooldown Expiry:
    // Once cooldownUntil <= currentISOString, make them eligible to be pulled back into the tail end
    // of daily batch assignments with their attempt counters intact.
    if (
      (!wasCalledToday || hasExplicitExpiredCooldown) &&
      (lead.status === 'DIDNT_RECEIVE' || lead.status === 'SWITCH_OFF') &&
      (lead.didntReceiveCount || 0) < 10 &&
      (lead.switchOffCount || 0) < 3 &&
      Boolean(lead.cooldownUntil || rawLastCalled) &&
      !isLeadOnCooldown(lead, nowDate, switchOffRetryHours)
    ) {
      const preservedAttempts = Math.max(
        1,
        lead.callAttempts ||
          (lead.didntReceiveCount || 0) + (lead.switchOffCount || 0)
      );
      const revived: LeadRecord = {
        ...lead,
        status: 'FRESH',
        callAttempts: preservedAttempts,
        didntReceiveCount: lead.didntReceiveCount || 0,
        switchOffCount: lead.switchOffCount || 0,
        lastCalled: lead.lastCalled || lead.lastCalledDate || null,
        lastCalledDate: lead.lastCalledDate || lead.lastCalled || null,
        lastCalledBy: lead.lastCalledBy || lead.lastCalledByName || null,
        lastCalledByName: lead.lastCalledByName || lead.lastCalledBy || null,
        cooldownUntil: null,
        assignedBatchId: null,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
      releasedLeads.push(revived);
      return revived;
    }

    const isFreshLike = lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH';
    const hasStaleAssignment =
      isFreshLike &&
      Boolean(lead.assignedBatchId) &&
      !doesBatchBelongToTodayPure(lead.assignedBatchId, todayDate, existingBatches);

    if (hasStaleAssignment) {
      if (lead.assignedBatchId) {
        releasedCountByBatch.set(
          lead.assignedBatchId,
          (releasedCountByBatch.get(lead.assignedBatchId) || 0) + 1
        );
      }
      const released: LeadRecord = {
        ...lead,
        assignedBatchId: null,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
      releasedLeads.push(released);
      return released;
    }
    return lead;
  });

  const closedPriorBatches: DailyBatchDocument[] = [];
  const sweptBatches = existingBatches.map((batch) => {
    if (batch.date < todayDate && batch.status !== 'CLOSED') {
      const completedCalls = batch.completedCallsCount || 0;
      const totalAssigned = batch.totalLeadsAssigned ?? batch.totalLeads ?? 0;
      const uncalledReturned =
        releasedCountByBatch.get(batch.batchId) ??
        Math.max(0, totalAssigned - completedCalls);

      const closedBatch: DailyBatchDocument = {
        ...batch,
        status: 'CLOSED',
        totalLeadsAssigned: totalAssigned,
        completedCallsCount: completedCalls,
        uncalledReturnedCount: uncalledReturned,
        closedAt: nowIso,
      };
      closedPriorBatches.push(closedBatch);
      return closedBatch;
    }
    return batch;
  });

  return {
    sweptLeads,
    sweptBatches,
    releasedLeads,
    closedPriorBatches,
    hadStaleData: releasedLeads.length > 0 || closedPriorBatches.length > 0,
  };
}

/**
 * In-place Fisher-Yates shuffle algorithm to distribute untouched and retried leads
 * evenly across the batch and prevent retry clustering at the top.
 */
export function fisherYatesShuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = items[i];
    items[i] = items[j];
    items[j] = temp;
  }
  return items;
}

/**
 * Automatically sweeps any prior-day batches/uncalled FRESH leads and cooled-down `DIDNT_RECEIVE` / `SWITCH_OFF`
 * re-entry leads, deletes any extra/duplicate batches (`batchNumber > N` or `CLOSED` batches for today),
 * and divides all eligible leads equally across strictly `1..N` active Sales Representatives
 * (`BATCH_${todayDate}_01` .. `BATCH_${todayDate}_0N`) with strict tail-end placement for retry leads:
 * - Priority 1 (Top of Batch): Untouched fresh leads (`status == 'FRESH'` and `callAttempts == 0`).
 * - Priority 2 (Bottom of Batch / Tail End): Cooled-down re-entry / retry leads (`DIDNT_RECEIVE` / `SWITCH_OFF` / `callAttempts > 0`).
 */
export function partitionFreshLeadsEquallyForActiveRepsPure(
  allLeads: LeadRecord[],
  existingBatches: DailyBatchDocument[],
  activeRepCount: number = 3,
  todayDate: string = getTodayIstDateString(),
  now: Date | string = new Date(),
  forceFullResetForToday: boolean = false
): EqualDailyBatchPartitionResult {
  const nowDate = typeof now === 'string' ? new Date(now) : now;
  const nowIso = nowDate.toISOString();
  const safeRepCount = Math.max(1, Math.floor(activeRepCount || 3));

  // Step 1: Automatically sweep any stale prior-day batches (date < todayDate), release prior-day uncalled FRESH leads,
  // and release prior-day DIDNT_RECEIVE / SWITCH_OFF leads whose 48h cooldown has cleared.
  const sweep = autoSweepStaleBatchesAndReleaseLeadsPure(
    allLeads,
    existingBatches,
    todayDate,
    nowIso
  );

  // Step 2: Detect any extra/duplicate batches (`batchNumber > safeRepCount` or `< 1`) or `CLOSED` batches on `todayDate`,
  // as well as prior-day batches (`date !== todayDate`) that should be deleted/archived.
  const deletedBatchIdsSet = new Set<string>();
  const extraOrClosedTodayBatchIds = new Set<string>();

  for (const b of existingBatches) {
    if (b.date !== todayDate) {
      deletedBatchIdsSet.add(b.batchId);
    } else if (
      b.batchNumber > safeRepCount ||
      b.batchNumber < 1 ||
      b.status === 'CLOSED'
    ) {
      deletedBatchIdsSet.add(b.batchId);
      extraOrClosedTodayBatchIds.add(b.batchId);
    }
  }

  const hadExtraOrClosedTodayBatches =
    forceFullResetForToday || extraOrClosedTodayBatchIds.size > 0;

  // Release any FRESH leads that were pointing to deleted/extra/closed batches (or if full reset / re-sync triggered)
  const additionalReleasedLeads: LeadRecord[] = [];
  const workingLeads = sweep.sweptLeads.map((lead) => {
    const isFreshLike = lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH';
    if (!isFreshLike) return lead;

    if (
      hadExtraOrClosedTodayBatches ||
      (lead.assignedBatchId && deletedBatchIdsSet.has(lead.assignedBatchId))
    ) {
      const released: LeadRecord = {
        ...lead,
        assignedBatchId: null,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
      if (lead.assignedBatchId !== null) {
        additionalReleasedLeads.push(released);
      }
      return released;
    }
    return lead;
  });

  // Deduplicate today's valid batches (strictly 1 <= batchNumber <= safeRepCount and status !== 'CLOSED')
  const validTodayByNumber = new Map<number, DailyBatchDocument>();
  if (!hadExtraOrClosedTodayBatches) {
    for (const b of sweep.sweptBatches) {
      if (
        b.date === todayDate &&
        b.status !== 'CLOSED' &&
        b.batchNumber >= 1 &&
        b.batchNumber <= safeRepCount
      ) {
        const canonicalId = formatBatchId(todayDate, b.batchNumber);
        if (b.batchId !== canonicalId) {
          deletedBatchIdsSet.add(b.batchId);
        }
        validTodayByNumber.set(b.batchNumber, {
          ...b,
          batchId: canonicalId,
        });
      }
    }
  }

  const todayExisting = Array.from(validTodayByNumber.values()).sort(
    (a, b) => a.batchNumber - b.batchNumber
  );

  const inProgressTodayBatches = todayExisting.filter(
    (b) => b.status === 'IN_PROGRESS'
  );
  const availableTodayBatches = todayExisting.filter(
    (b) => b.status === 'AVAILABLE'
  );
  const availableTodayBatchIds = new Set(
    availableTodayBatches.map((b) => b.batchId)
  );
  const inProgressTodayBatchIds = new Set(
    inProgressTodayBatches.map((b) => b.batchId)
  );

  // Check if there are any newly unassigned eligible FRESH leads
  const unassignedEligibleLeads = workingLeads.filter(
    (l) =>
      (l.status === 'FRESH' || l.status === 'REVIVED_FRESH') &&
      !isLeadOnCooldown(l, nowDate) &&
      (!l.assignedBatchId ||
        (!inProgressTodayBatchIds.has(l.assignedBatchId) &&
          !availableTodayBatchIds.has(l.assignedBatchId)))
  );

  const allReleasedLeads = [...sweep.releasedLeads, ...additionalReleasedLeads];
  const deletedBatchIds = Array.from(deletedBatchIdsSet);

  // If today already has clean 1..N active batches and no unassigned eligible leads exist, preserve today's batches as-is!
  if (
    !hadExtraOrClosedTodayBatches &&
    todayExisting.length > 0 &&
    unassignedEligibleLeads.length === 0
  ) {
    return {
      batches: todayExisting,
      updatedBatches: todayExisting,
      newBatches: [],
      todayBatches: todayExisting,
      closedPriorBatches: sweep.closedPriorBatches,
      deletedBatchIds,
      releasedLeads: allReleasedLeads,
      updatedLeads: workingLeads,
      changed: sweep.hadStaleData || deletedBatchIds.length > 0,
      totalEligibleFreshLeads: 0,
      activeRepCount: safeRepCount,
      batchSizePerRep:
        todayExisting.length > 0 ? todayExisting[0].totalLeads || 0 : 0,
    };
  }

  // Gather all leads eligible to be partitioned into AVAILABLE batches today:
  // Either completely unassigned (`!assignedBatchId`) OR currently sitting in one of today's unclaimed `AVAILABLE` batches
  const poolToPartition: LeadRecord[] = [];
  for (const lead of workingLeads) {
    if (lead.status !== 'FRESH' && lead.status !== 'REVIVED_FRESH') continue;
    if (isLeadOnCooldown(lead, nowDate)) continue;
    if (
      !lead.assignedBatchId ||
      availableTodayBatchIds.has(lead.assignedBatchId) ||
      !inProgressTodayBatchIds.has(lead.assignedBatchId)
    ) {
      poolToPartition.push(lead);
    }
  }

  if (poolToPartition.length === 0) {
    return {
      batches: todayExisting,
      updatedBatches: todayExisting,
      newBatches: [],
      todayBatches: todayExisting,
      closedPriorBatches: sweep.closedPriorBatches,
      deletedBatchIds,
      releasedLeads: allReleasedLeads,
      updatedLeads: workingLeads,
      changed:
        sweep.hadStaleData ||
        deletedBatchIds.length > 0 ||
        hadExtraOrClosedTodayBatches,
      totalEligibleFreshLeads: 0,
      activeRepCount: safeRepCount,
      batchSizePerRep: 0,
    };
  }

  // Requirement 2: Tail-End Batch Sequencing for Re-Entry Leads
  // Priority 1 (Top of Batch): Untouched fresh leads (`status == 'FRESH'` and `callAttempts == 0`).
  // Priority 2 (Bottom of Batch / Tail End): Cooled-down re-entry / retry leads (`DIDNT_RECEIVE` / `SWITCH_OFF` / `callAttempts > 0`).
  const untouched = poolToPartition.filter((l) => isUntouchedPriority1LeadPure(l));
  const retries = poolToPartition.filter((l) => !isUntouchedPriority1LeadPure(l));
  const orderedPool: LeadRecord[] = [...untouched, ...retries];

  // Determine strictly bounded slot numbers within 1..safeRepCount (NEVER > safeRepCount)
  const usedInProgressNumbers = new Set(
    inProgressTodayBatches.map((b) => b.batchNumber)
  );
  const openSlotNumbers: number[] = [];
  for (let num = 1; num <= safeRepCount; num++) {
    if (!usedInProgressNumbers.has(num)) {
      openSlotNumbers.push(num);
    }
  }

  // If all 1..safeRepCount slots are somehow IN_PROGRESS and new leads were imported mid-day,
  // distribute into the existing 1..safeRepCount slots rather than ever creating Batch #(N+1).
  if (openSlotNumbers.length === 0) {
    const slotCount = Math.min(safeRepCount, orderedPool.length);
    const extraSlices: LeadRecord[][] = Array.from(
      { length: slotCount },
      () => []
    );
    for (let i = 0; i < untouched.length; i++) {
      extraSlices[i % slotCount].push(untouched[i]);
    }
    for (let i = 0; i < retries.length; i++) {
      extraSlices[i % slotCount].push(retries[i]);
    }
    const leadToExistingBatch = new Map<string, DailyBatchDocument>();
    const updatedInProgress = inProgressTodayBatches.map((b, idx) => {
      const addChunk = sortBatchLeadsUntouchedFirstRetriesTailPure(extraSlices[idx] || []);
      if (addChunk.length === 0) return b;
      const addedIds = addChunk.map((l) => l.id);
      for (const l of addChunk) {
        leadToExistingBatch.set(l.id, b);
      }
      return sanitizeFirestorePayload({
        ...b,
        totalLeads: (b.totalLeads || 0) + addChunk.length,
        remainingLeads: (b.remainingLeads || 0) + addChunk.length,
        totalLeadsAssigned: (b.totalLeadsAssigned || b.totalLeads || 0) + addChunk.length,
        leadIds: [...(b.leadIds || []), ...addedIds],
      });
    });

    const updatedLeads = sortBatchLeadsUntouchedFirstRetriesTailPure(
      workingLeads.map((lead) => {
        const targetBatch = leadToExistingBatch.get(lead.id);
        if (targetBatch) {
          return {
            ...lead,
            assignedBatchId: targetBatch.batchId,
            assignedRepEmail: targetBatch.claimedByEmail || null,
            assignedRepName: targetBatch.claimedByName || null,
            updatedAt: nowIso,
          };
        }
        return lead;
      })
    );

    return {
      batches: updatedInProgress,
      updatedBatches: updatedInProgress,
      newBatches: updatedInProgress,
      todayBatches: updatedInProgress,
      closedPriorBatches: sweep.closedPriorBatches,
      deletedBatchIds,
      releasedLeads: allReleasedLeads,
      updatedLeads,
      changed: true,
      totalEligibleFreshLeads: orderedPool.length,
      activeRepCount: safeRepCount,
      batchSizePerRep: Math.ceil(orderedPool.length / slotCount),
    };
  }

  const actualBatchCount = Math.min(openSlotNumbers.length, orderedPool.length);
  const availableBatchNumbers = openSlotNumbers.slice(0, actualBatchCount);
  const batchSizePerRep = Math.ceil(orderedPool.length / actualBatchCount);

  // Round-robin equal slice distribution across `actualBatchCount` batches (`1..N`),
  // dealing ALL Priority 1 untouched leads first (indices 0..~1687) and ALL Priority 2 cooled-down retry leads
  // strictly at the tail end of each batch slice (indices ~1688..1698).
  const slices: LeadRecord[][] = Array.from({ length: actualBatchCount }, () => []);
  for (let i = 0; i < untouched.length; i++) {
    slices[i % actualBatchCount].push(untouched[i]);
  }
  for (let i = 0; i < retries.length; i++) {
    slices[i % actualBatchCount].push(retries[i]);
  }

  const leadToNewBatchId = new Map<string, string>();
  const batchSequenceOrder = new Map<string, number>();
  let globalSeq = 0;

  const newAvailableBatches: DailyBatchDocument[] = slices.map((rawChunk, idx) => {
    const chunk = sortBatchLeadsUntouchedFirstRetriesTailPure(rawChunk);
    const batchNumber = availableBatchNumbers[idx];
    const batchId = formatBatchId(todayDate, batchNumber);
    let untouchedInBatch = 0;
    let retryInBatch = 0;
    const leadIds: string[] = [];

    for (const l of chunk) {
      leadIds.push(l.id);
      leadToNewBatchId.set(l.id, batchId);
      batchSequenceOrder.set(l.id, globalSeq++);
      if (isUntouchedPriority1LeadPure(l)) {
        untouchedInBatch++;
      } else {
        retryInBatch++;
      }
    }

    return sanitizeFirestorePayload({
      batchId,
      batchNumber,
      date: todayDate,
      totalLeads: chunk.length,
      remainingLeads: chunk.length,
      totalLeadsAssigned: chunk.length,
      claimedByEmail: null,
      claimedByName: null,
      claimedAt: null,
      status: 'AVAILABLE',
      completedCallsCount: 0,
      untouchedCount: untouchedInBatch,
      retryCount: retryInBatch,
      leadIds,
      createdAt: nowIso,
    });
  });

  const mappedUpdatedLeads = workingLeads.map((lead) => {
    const assignedId = leadToNewBatchId.get(lead.id);
    if (assignedId) {
      return {
        ...lead,
        assignedBatchId: assignedId,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
    }
    return lead;
  });

  const updatedLeads = [...mappedUpdatedLeads].sort((a, b) => {
    const pA = isUntouchedPriority1LeadPure(a) ? 0 : 1;
    const pB = isUntouchedPriority1LeadPure(b) ? 0 : 1;
    if (pA !== pB) return pA - pB;
    const seqA = batchSequenceOrder.get(a.id);
    const seqB = batchSequenceOrder.get(b.id);
    if (seqA !== undefined && seqB !== undefined && seqA !== seqB) {
      return seqA - seqB;
    }
    return 0;
  });

  const mergedTodayBatches = [...inProgressTodayBatches, ...newAvailableBatches].sort(
    (a, b) => a.batchNumber - b.batchNumber
  );

  return {
    batches: mergedTodayBatches,
    updatedBatches: mergedTodayBatches,
    newBatches: newAvailableBatches,
    todayBatches: mergedTodayBatches,
    closedPriorBatches: sweep.closedPriorBatches,
    deletedBatchIds,
    releasedLeads: allReleasedLeads,
    updatedLeads,
    changed: true,
    totalEligibleFreshLeads: orderedPool.length,
    activeRepCount: safeRepCount,
    batchSizePerRep,
  };
}

/**
 * 100% Hands-Free Atomic Daily Reset & Deterministic 1..N Batch Partitioning Engine:
 * - Maintains `doc(reachDb, 'system_meta', 'daily_state')` with `{ activeDate, isProcessing, lastResetAt }`.
 * - Triggered automatically on First Load of a new IST date AND via the 30-second live midnight IST watcher.
 * - Queries `FRESH`, `DIDNT_RECEIVE`, and `SWITCH_OFF` leads so cooled-down retry leads are automatically
 *   released into today's pool and placed strictly at the tail end of each rep's batch (`Batch #1` .. `Batch #N`).
 */
export async function autoSweepStaleBatchesAndGenerateTodayBatchesFirestore(
  todayDate: string = getTodayIstDateString(),
  now: Date = new Date()
): Promise<{
  batches: DailyBatchDocument[];
  todayBatches: DailyBatchDocument[];
  freshLeads: LeadRecord[];
  activeRepCount: number;
  changed: boolean;
} | null> {
  if (!hasLiveReachFirebaseConfig()) return null;

  const nowIso = now.toISOString();
  const dailyStateRef = doc(db, 'system_meta', 'daily_state');

  try {
    const [
      dailyStateSnap,
      activeReps,
      batchesSnap,
      freshLeadsSnap,
      didntReceiveSnap,
      switchOffSnap,
    ] = await withFirestoreNetworkRetry(
      () =>
        Promise.all([
          getDoc(dailyStateRef).catch(() => null),
          getActiveSalesReps().catch(() => []),
          getDocs(collection(db, 'batches')),
          getDocs(
            query(collection(db, 'leads'), where('status', '==', 'FRESH'))
          ),
          getDocs(
            query(
              collection(db, 'leads'),
              where('status', '==', 'DIDNT_RECEIVE')
            )
          ),
          getDocs(
            query(collection(db, 'leads'), where('status', '==', 'SWITCH_OFF'))
          ),
        ]),
      1500
    );

    clearCloudSyncError();

    const activeRepCount = Math.max(1, activeReps.length || 3);

    const remoteDailyState = dailyStateSnap?.exists()
      ? (dailyStateSnap.data() as DailyStateMetaDocument)
      : loadLocalDailyStateMeta();

    const batchMap = new Map<string, DailyBatchDocument>();
    batchesSnap?.forEach((d) => {
      const raw = d.data() as DailyBatchDocument;
      if (raw && (raw.batchId || d.id) && !isLegacyMockBatch(raw)) {
        const normalized: DailyBatchDocument = {
          ...raw,
          batchId: d.id || raw.batchId,
          claimedByEmail:
            raw.status === 'AVAILABLE' ? null : (raw.claimedByEmail ?? null),
          claimedByName:
            raw.status === 'AVAILABLE' ? null : (raw.claimedByName ?? null),
          claimedAt:
            raw.status === 'AVAILABLE' ? null : (raw.claimedAt ?? null),
        };
        batchMap.set(normalized.batchId, normalized);
      }
    });
    const existingBatches = Array.from(batchMap.values());

    const todayValidExisting = existingBatches
      .filter(
        (b) =>
          b.date === todayDate &&
          b.status !== 'CLOSED' &&
          b.batchNumber >= 1
      )
      .sort((a, b) => a.batchNumber - b.batchNumber);

    const isNewIstDay =
      (!remoteDailyState || remoteDailyState.activeDate !== todayDate) &&
      todayValidExisting.length === 0;

    // Prevent concurrent race if another tab is actively processing the reset within the last 10 seconds
    if (
      remoteDailyState?.isProcessing &&
      remoteDailyState.activeDate === todayDate &&
      remoteDailyState.lastResetAt &&
      now.getTime() - new Date(remoteDailyState.lastResetAt).getTime() < 10000
    ) {
      return null;
    }

    const candidateLeadMap = new Map<string, LeadRecord>();
    const collectSnap = (snap: typeof freshLeadsSnap) => {
      snap?.forEach((d) => {
        const l = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
        if (!isLegacyMockOrSyntheticLead(l)) {
          candidateLeadMap.set(l.id, l);
        }
      });
    };
    collectSnap(freshLeadsSnap);
    collectSnap(didntReceiveSnap);
    collectSnap(switchOffSnap);

    const candidateLeads = Array.from(candidateLeadMap.values());

    // If today already has valid active batches (`todayValidExisting.length > 0`),
    // preserve the live Firestore batches as-is so manual Release Batch / Claim changes never get overwritten on refresh.
    if (!isNewIstDay && todayValidExisting.length > 0) {
      return {
        batches: todayValidExisting,
        todayBatches: todayValidExisting,
        freshLeads: candidateLeads,
        activeRepCount,
        changed: false,
      };
    }

    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      candidateLeads,
      existingBatches,
      activeRepCount,
      todayDate,
      now,
      isNewIstDay
    );

    if (!partitioned.changed && !isNewIstDay) {
      return {
        batches: partitioned.todayBatches,
        todayBatches: partitioned.todayBatches,
        freshLeads: partitioned.updatedLeads,
        activeRepCount,
        changed: false,
      };
    }

    // Acquire atomic daily_state lock
    const processingState: DailyStateMetaDocument = {
      activeDate: todayDate,
      isProcessing: true,
      lastResetAt: nowIso,
    };
    saveLocalDailyStateMeta(processingState);
    await setDoc(dailyStateRef, processingState, { merge: true });

    // 1. Delete all prior-date and extra/duplicate/closed batch documents from `batches`
    for (let i = 0; i < partitioned.deletedBatchIds.length; i += 400) {
      const chunkIds = partitioned.deletedBatchIds.slice(i, i + 400);
      const wb = writeBatch(db);
      for (const id of chunkIds) {
        wb.delete(doc(db, 'batches', id));
      }
      await wb.commit();
    }

    // 2. Write deterministic `BATCH_${todayDate}_01` .. `BATCH_${todayDate}_0N` documents (full overwrite so CLOSED/extra state is wiped)
    for (let i = 0; i < partitioned.todayBatches.length; i += 400) {
      const chunk = partitioned.todayBatches.slice(i, i + 400);
      const wb = writeBatch(db);
      for (const b of chunk) {
        wb.set(doc(db, 'batches', b.batchId), sanitizeFirestorePayload(b));
      }
      await wb.commit();
    }

    // 3. Commit updated/re-partitioned FRESH & revived retry leads in 400-op chunks
    const originalById = new Map(candidateLeads.map((l) => [l.id, l]));
    const leadsToWrite = partitioned.updatedLeads.filter((l) => {
      const orig = originalById.get(l.id);
      if (!orig) return true;
      return (
        orig.status !== l.status ||
        orig.cooldownUntil !== l.cooldownUntil ||
        orig.assignedBatchId !== l.assignedBatchId ||
        orig.assignedRepEmail !== l.assignedRepEmail ||
        orig.assignedRepName !== l.assignedRepName
      );
    });

    for (let i = 0; i < leadsToWrite.length; i += 400) {
      const chunk = leadsToWrite.slice(i, i + 400);
      const wb = writeBatch(db);
      for (const lead of chunk) {
        wb.update(doc(db, 'leads', lead.id), {
          status: lead.status,
          callAttempts: lead.callAttempts ?? 0,
          didntReceiveCount: lead.didntReceiveCount ?? 0,
          switchOffCount: lead.switchOffCount ?? 0,
          cooldownUntil: lead.cooldownUntil ?? null,
          assignedBatchId: lead.assignedBatchId ?? null,
          assignedRepEmail: lead.assignedRepEmail ?? null,
          assignedRepName: lead.assignedRepName ?? null,
          updatedAt: lead.updatedAt || nowIso,
        });
      }
      await wb.commit();
    }

    // Release atomic daily_state lock
    const completedState: DailyStateMetaDocument = {
      activeDate: todayDate,
      isProcessing: false,
      lastResetAt: nowIso,
    };
    saveLocalDailyStateMeta(completedState);
    await setDoc(dailyStateRef, completedState, { merge: true });

    return {
      batches: partitioned.todayBatches,
      todayBatches: partitioned.todayBatches,
      freshLeads: partitioned.updatedLeads,
      activeRepCount,
      changed: true,
    };
  } catch (err) {
    reportCloudSyncError(err, 'Daily Batch Reset & Partition Engine');
    return null;
  }
}

/**
 * Extracts eligible leads into stratified daily batches:
 */
export function generateStratifiedBatch(
  allLeads: LeadRecord[],
  targetSize: number = DEFAULT_BATCH_SIZE,
  now: Date = new Date(),
  rng: () => number = Math.random
): StratifiedBatchResult {
  let excludedOnCooldownCount = 0;
  const bucketA: LeadRecord[] = [];
  const bucketB: LeadRecord[] = [];
  const revivedPool: LeadRecord[] = [];

  for (const lead of allLeads) {
    if (lead.assignedBatchId !== null && lead.assignedBatchId !== undefined) {
      continue;
    }

    if (isLeadOnCooldown(lead, now)) {
      if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') {
        excludedOnCooldownCount++;
      }
      continue;
    }

    if (lead.status === 'REVIVED_FRESH') {
      revivedPool.push(lead);
      continue;
    }

    if (lead.status !== 'FRESH') {
      continue;
    }

    if (lead.callAttempts === 0) {
      bucketA.push(lead);
    } else if (lead.didntReceiveCount > 0 || lead.switchOffCount > 0) {
      const clearedCooldown =
        !lead.cooldownUntil || new Date(lead.cooldownUntil).getTime() <= now.getTime();
      if (clearedCooldown) {
        bucketB.push(lead);
      }
    } else {
      bucketB.push(lead);
    }
  }

  const effectiveTarget =
    targetSize > 0 ? targetSize : bucketA.length + bucketB.length + revivedPool.length;

  const maxRevivedQuota = Math.floor(effectiveTarget * REVIVED_QUOTA_MAX_RATIO);
  const takeRevived = Math.min(revivedPool.length, maxRevivedQuota);
  const remainingStandardTarget = Math.max(0, effectiveTarget - takeRevived);

  const targetBucketA = Math.round(remainingStandardTarget * BUCKET_A_RATIO);
  const targetBucketB = remainingStandardTarget - targetBucketA;

  let takeA = Math.min(bucketA.length, targetBucketA);
  let takeB = Math.min(bucketB.length, targetBucketB);

  if (takeA < targetBucketA && bucketB.length > takeB) {
    const shortfallA = targetBucketA - takeA;
    const extraFromB = Math.min(shortfallA, bucketB.length - takeB);
    takeB += extraFromB;
  }

  if (takeB < targetBucketB && bucketA.length > takeA) {
    const shortfallB = targetBucketB - takeB;
    const extraFromA = Math.min(shortfallB, bucketA.length - takeA);
    takeA += extraFromA;
  }

  const selectedA = bucketA.slice(0, takeA);
  const selectedB = bucketB.slice(0, takeB);
  const selectedRevived = revivedPool.slice(0, takeRevived);

  const merged = [...selectedA, ...selectedB, ...selectedRevived];
  fisherYatesShuffle(merged, rng);

  return {
    batchLeads: merged,
    bucketACount: selectedA.length,
    bucketBCount: selectedB.length,
    revivedCount: selectedRevived.length,
    eligibleBucketATotal: bucketA.length,
    eligibleBucketBTotal: bucketB.length,
    eligibleRevivedTotal: revivedPool.length,
    excludedOnCooldownCount,
  };
}

export async function fetchAndGenerateStratifiedBatchFromFirestore(
  fallbackLeads: LeadRecord[] = [],
  targetSize: number = DEFAULT_BATCH_SIZE,
  now: Date = new Date(),
  rng: () => number = Math.random
): Promise<StratifiedBatchResult> {
  const combinedMap = new Map<string, LeadRecord>();
  for (const lead of fallbackLeads) {
    combinedMap.set(lead.id, lead);
  }

  try {
    await Promise.race([
      (async () => {
        const q = query(collection(db, 'leads'), where('status', '==', 'FRESH'));
        const snap = await getDocs(q);
        snap.forEach((docSnap) => {
          combinedMap.set(docSnap.id, {
            id: docSnap.id,
            ...(docSnap.data() as Omit<LeadRecord, 'id'>),
          });
        });
      })().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1200)),
    ]);
  } catch {
    // Fallback to in-memory pool
  }

  return generateStratifiedBatch(Array.from(combinedMap.values()), targetSize, now, rng);
}


