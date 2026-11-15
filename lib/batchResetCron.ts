import {
  doc,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { hasLiveReachFirebaseConfig, reachDb as db } from './firebaseDual';
import { AuthorizedUser, LeadRecord } from './types';
import {
  DailyBatchDocument,
  NightlySweepSummary,
  formatBatchId,
  getTodayIstDateString,
} from '@/types/batch';
import {
  DEFAULT_BATCH_SIZE,
  EqualDailyBatchPartitionResult,
  StratifiedBatchResult,
  generateStratifiedBatch,
  partitionFreshLeadsEquallyForActiveRepsPure,
} from './batchGenerator';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import {
  areRepEmailsEquivalentPure,
  resolveCanonicalRepIdentity,
} from './dailyStatsService';
import { CooldownSweepSummary } from '@/types/batch';

export const MIDNIGHT_RESET_CRON_SCHEDULE = {
  schedule: '59 23 * * *',
  timeZone: 'Asia/Kolkata',
  description: 'Daily 11:59 PM IST Midnight Batch Reset & Uncalled Lead Release',
};

export const COOLDOWN_SWEEPER_CRON_SCHEDULE = {
  schedule: '0 * * * *',
  timeZone: 'Asia/Kolkata',
  description: 'Hourly 48-Hour Cooldown & Dead-Lead Sweeper',
};

export function runMidnightResetPure(
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  targetDate: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): {
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  summary: NightlySweepSummary;
} {
  const releasedByBatch = new Map<string, number>();
  let uncalledLeadsReleasedCount = 0;

  const updatedLeads = leads.map((lead) => {
    if (lead.status === 'FRESH' && lead.assignedBatchId !== null && lead.assignedBatchId !== undefined) {
      uncalledLeadsReleasedCount++;
      releasedByBatch.set(
        lead.assignedBatchId,
        (releasedByBatch.get(lead.assignedBatchId) || 0) + 1
      );
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

  let closedBatchesCount = 0;
  let totalDialedCallsCount = 0;

  const updatedBatches = batches.map((batch) => {
    if (
      batch.date <= targetDate &&
      (batch.status === 'AVAILABLE' || batch.status === 'IN_PROGRESS')
    ) {
      closedBatchesCount++;
      const completedCalls = batch.completedCallsCount || 0;
      totalDialedCallsCount += completedCalls;
      const totalAssigned = batch.totalLeadsAssigned ?? batch.totalLeads ?? 0;
      const uncalledReturned =
        releasedByBatch.get(batch.batchId) ??
        Math.max(0, totalAssigned - completedCalls);

      return {
        ...batch,
        status: 'CLOSED' as const,
        totalLeadsAssigned: totalAssigned,
        completedCallsCount: completedCalls,
        uncalledReturnedCount: uncalledReturned,
        closedAt: nowIso,
      };
    }
    return batch;
  });

  const totalWriteOps = uncalledLeadsReleasedCount + closedBatchesCount;
  const chunkWriteOperations = totalWriteOps > 0 ? Math.ceil(totalWriteOps / 500) : 0;

  return {
    updatedBatches,
    updatedLeads,
    summary: {
      sweptAt: nowIso,
      targetDate,
      closedBatchesCount,
      uncalledLeadsReleasedCount,
      totalDialedCallsCount,
      chunkWriteOperations,
    },
  };
}

export async function executeMidnightResetFirestore(
  _targetDate: string = getTodayIstDateString(),
  _nowIso: string = new Date().toISOString()
): Promise<void> {
  // Handled by autoSweepStaleBatchesAndGenerateTodayBatchesFirestore
}

export function runCooldownSweeperPure(
  leads: LeadRecord[],
  now: Date = new Date()
): {
  updatedLeads: LeadRecord[];
  summary: CooldownSweepSummary;
} {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  let cooldownClearedCount = 0;
  let didntReceiveDeadCount = 0;
  let switchOffDeadCount = 0;

  const updatedLeads = leads.map((lead) => {
    if (
      lead.didntReceiveCount > 10 &&
      lead.status !== 'DIDNT_RECEIVE_DEAD' &&
      lead.status !== 'CLOSED_WON' &&
      lead.status !== 'INTERESTED'
    ) {
      didntReceiveDeadCount++;
      return {
        ...lead,
        status: 'DIDNT_RECEIVE_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    if (lead.status === 'SWITCH_OFF' && lead.switchOffCount >= 3) {
      switchOffDeadCount++;
      return {
        ...lead,
        status: 'SWITCH_OFF_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    if (lead.cooldownUntil) {
      const cooldownMs = new Date(lead.cooldownUntil).getTime();
      if (!Number.isNaN(cooldownMs) && cooldownMs <= nowMs) {
        if (lead.status === 'FRESH' || lead.status === 'DIDNT_RECEIVE') {
          cooldownClearedCount++;
          return {
            ...lead,
            status: 'FRESH' as const,
            cooldownUntil: null,
            updatedAt: nowIso,
          };
        }
      }
    }

    return lead;
  });

  const totalChanged = cooldownClearedCount + didntReceiveDeadCount + switchOffDeadCount;

  return {
    updatedLeads,
    summary: {
      sweptAt: nowIso,
      cooldownClearedCount,
      didntReceiveDeadCount,
      switchOffDeadCount,
      chunkWriteOperations: totalChanged > 0 ? Math.ceil(totalChanged / 500) : 0,
    },
  };
}

export async function executeCooldownSweeperFirestore(
  _now: Date = new Date()
): Promise<void> {
  // Handled by client-side Dual-Firebase engine
}

export { partitionFreshLeadsEquallyForActiveRepsPure };
export type { EqualDailyBatchPartitionResult };

export const NIGHTLY_SWEEP_CRON_CONFIG = {
  schedule: '59 23 * * *',
  timeZone: 'Asia/Kolkata',
  description: 'Daily 11:59 PM IST Sweep & Lead Release Engine',
};

/**
 * Multi-User Isolation & Strict 1-Batch-Per-Day Filter:
 * - Owners / Admins (`isOwnerTier` or `OWNER` / `ADMIN` / `owner`) see ALL batches (`AVAILABLE`, `IN_PROGRESS`, `CLOSED`) for supervisory visibility.
 * - Sales Reps (`SALES` / `LEAD_SALES` / `sales`):
 *   1. If they HAVE already claimed 1 batch for today (`status === 'IN_PROGRESS'` and `claimedByEmail` matches `user.email`),
 *      return ONLY that single claimed batch and HIDE all other `AVAILABLE` / unclaimed batch cards (`Batch #2`, `Batch #3`, etc.) immediately.
 *   2. If they have NOT claimed a batch today yet, return all `AVAILABLE` batches for today so they can claim one;
 *      peer-claimed batches (`status === 'IN_PROGRESS'` and `claimedByEmail !== user.email`) are hidden.
 */
export function filterBatchesForUser(
  batches: DailyBatchDocument[],
  user: Pick<AuthorizedUser, 'email' | 'role' | 'isOwnerTier'> & { name?: string },
  targetDate?: string
): DailyBatchDocument[] {
  const userEmailLower = (user.email || '').toLowerCase().trim();
  const isOwnerUser = Boolean(
    user.isOwnerTier ||
      user.role === 'owner' ||
      user.role === 'OWNER' ||
      user.role === 'ADMIN'
  );

  const dateFiltered = batches.filter((b) => {
    if (targetDate && targetDate !== 'ALL' && b.date !== targetDate) {
      return false;
    }
    return true;
  });

  if (isOwnerUser) {
    return dateFiltered;
  }

  // Check if Sales Rep has already claimed 1 batch for the target date
  const alreadyClaimedBatch = dateFiltered.find(
    (b) =>
      b.status === 'IN_PROGRESS' &&
      b.claimedByEmail &&
      areRepEmailsEquivalentPure(
        b.claimedByEmail,
        userEmailLower,
        b.claimedByName,
        user.name
      )
  );

  // Strict 1 Batch Per Day Rule: Once a Sales Rep claims 1 batch for today, hide all other available/unclaimed batches
  if (alreadyClaimedBatch) {
    return [alreadyClaimedBatch];
  }

  // Sales Rep has not claimed a batch yet today -> show only AVAILABLE batches
  return dateFiltered.filter((b) => b.status === 'AVAILABLE');
}

export interface CreateDailyBatchResult {
  newBatch: DailyBatchDocument;
  updatedBatches: DailyBatchDocument[];
  stratification: StratifiedBatchResult;
}

/**
 * Generates a new daily stratified batch document (`BATCH_YYYY_MM_DD_XX`) with sequential `batchNumber`.
 */
export function createDailyBatchPure(
  allLeads: LeadRecord[],
  existingBatches: DailyBatchDocument[],
  targetSize: number = DEFAULT_BATCH_SIZE,
  todayDate: string = getTodayIstDateString(),
  now: Date = new Date(),
  rng: () => number = Math.random
): CreateDailyBatchResult {
  const stratification = generateStratifiedBatch(allLeads, targetSize, now, rng);
  const todayBatches = existingBatches.filter((b) => b.date === todayDate);
  const nextBatchNumber =
    todayBatches.length > 0
      ? Math.max(...todayBatches.map((b) => b.batchNumber)) + 1
      : 1;
  const batchId = formatBatchId(todayDate, nextBatchNumber);
  const actualCount = stratification.batchLeads.length;
  const totalCount = actualCount > 0 ? actualCount : targetSize;

  const newBatch: DailyBatchDocument = sanitizeFirestorePayload({
    batchId,
    batchNumber: nextBatchNumber,
    date: todayDate,
    totalLeads: totalCount,
    remainingLeads: totalCount,
    totalLeadsAssigned: actualCount,
    claimedByEmail: null,
    claimedByName: null,
    claimedAt: null,
    status: 'AVAILABLE',
    completedCallsCount: 0,
    untouchedCount: stratification.bucketACount,
    retryCount: stratification.bucketBCount,
    leadIds: stratification.batchLeads.map((l) => l.id),
    createdAt: now.toISOString(),
  });

  return {
    newBatch,
    updatedBatches: [...existingBatches, newBatch],
    stratification,
  };
}

/**
 * Persists a generated `DailyBatchDocument` to Firestore `batches/{batchId}`.
 */
export async function persistDailyBatchToFirestore(
  batch: DailyBatchDocument
): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;
  try {
    const sanitized = sanitizeFirestorePayload(batch);
    await Promise.race([
      setDoc(doc(db, 'batches', batch.batchId), sanitized, { merge: true }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch {
    // Non-blocking fallback in preview environment
  }
}

/**
 * Persists multiple auto-partitioned `DailyBatchDocument` records to Firestore `batches`.
 */
export async function persistDailyBatchesToFirestore(
  batchesToPersist: DailyBatchDocument[]
): Promise<void> {
  if (batchesToPersist.length === 0 || !hasLiveReachFirebaseConfig()) return;
  try {
    const wb = writeBatch(db);
    for (const b of batchesToPersist) {
      wb.set(doc(db, 'batches', b.batchId), sanitizeFirestorePayload(b), {
        merge: true,
      });
    }
    await Promise.race([
      wb.commit().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Non-blocking fallback
  }
}

export interface ClaimBatchResult {
  updatedBatch: DailyBatchDocument;
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  assignedLeadCount: number;
}

/**
 * Pure atomic state transition for claiming a batch:
 * - Verifies `status === 'AVAILABLE'`
 * - Enforces Strict 1 Batch Per Day Limit: blocks if `rep` already has an `IN_PROGRESS` batch on `targetBatch.date`
 * - Transitions `status -> 'IN_PROGRESS'`, sets `claimedByEmail`, `claimedByName`, `claimedAt`
 */
export function claimBatchStateTransition(
  batchId: string,
  rep: Pick<AuthorizedUser, 'email' | 'name'> & {
    role?: AuthorizedUser['role'];
    isOwnerTier?: boolean;
  },
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  nowIso: string = new Date().toISOString()
): ClaimBatchResult {
  const targetBatch = batches.find((b) => b.batchId === batchId);
  if (!targetBatch) {
    throw new Error(`Batch ${batchId} not found.`);
  }

  if (targetBatch.status !== 'AVAILABLE') {
    throw new Error(
      `Batch ${batchId} is no longer AVAILABLE (current status: ${targetBatch.status}).`
    );
  }

  const normalizedRepEmail = (rep.email || '').toLowerCase().trim();

  // Enforce Strict 1 Batch Per Rep Per Day limit
  const existingClaimedForToday = batches.find(
    (b) =>
      b.date === targetBatch.date &&
      b.batchId !== batchId &&
      b.status === 'IN_PROGRESS' &&
      b.claimedByEmail &&
      areRepEmailsEquivalentPure(
        b.claimedByEmail,
        normalizedRepEmail,
        b.claimedByName,
        rep.name
      )
  );

  if (existingClaimedForToday) {
    throw new Error(
      `${rep.name.split(' (')[0]} has already claimed Batch #${existingClaimedForToday.batchNumber} for today (limit 1 batch per day).`
    );
  }

  const updatedBatch: DailyBatchDocument = {
    ...targetBatch,
    status: 'IN_PROGRESS',
    claimedByEmail: normalizedRepEmail,
    claimedByName: rep.name,
    claimedAt: nowIso,
    remainingLeads:
      targetBatch.remainingLeads ??
      Math.max(
        0,
        (targetBatch.totalLeads ?? targetBatch.leadIds?.length ?? 0) -
          (targetBatch.completedCallsCount || 0)
      ),
  };

  const constituentSet = new Set(targetBatch.leadIds || []);
  let assignedLeadCount = 0;

  const updatedLeads = leads.map((lead) => {
    const belongsToBatch =
      constituentSet.has(lead.id) || lead.assignedBatchId === batchId;

    if (belongsToBatch) {
      assignedLeadCount++;
      return {
        ...lead,
        assignedBatchId: batchId,
        assignedRepEmail: normalizedRepEmail,
        assignedRepName: rep.name,
        updatedAt: nowIso,
      };
    }
    return lead;
  });

  const updatedBatches = batches.map((b) =>
    b.batchId === batchId ? updatedBatch : b
  );

  return {
    updatedBatch,
    updatedBatches,
    updatedLeads,
    assignedLeadCount,
  };
}

/**
 * Instant O(1) Single-Document Batch Claim in Firestore:
 * - Since `FRESH` leads already have `assignedBatchId` assigned when batches are partitioned,
 *   claiming a batch ONLY updates the single batch document (`batches/{batchId}`).
 * - Does NOT loop through thousands of lead documents during the batch claim click (prevents timeouts & composite/quota stalls).
 * - Individual leads have `assignedRepEmail` and `assignedRepName` stamped when the rep saves a call disposition in the Call Drawer.
 */
export async function executeFirestoreBatchClaim(
  batchId: string,
  rep: Pick<AuthorizedUser, 'email' | 'name'>,
  _leadIdsToAssign: string[] = [],
  nowIso: string = new Date().toISOString(),
  fullBatchSnapshot?: DailyBatchDocument
): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;

  const normalizedRepEmail = (rep.email || '').toLowerCase().trim();
  const payload = sanitizeFirestorePayload({
    ...(fullBatchSnapshot || {}),
    batchId,
    status: 'IN_PROGRESS',
    claimedByEmail: normalizedRepEmail,
    claimedByName: rep.name,
    claimedAt: nowIso,
  });

  try {
    const batchRef = doc(db, 'batches', batchId);
    await Promise.race([
      setDoc(batchRef, payload, { merge: true }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Non-blocking fallback when running against restricted preview rules
  }
}

export interface DuplicateBatchClaimCleanupResult {
  updatedBatches: DailyBatchDocument[];
  releasedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  unassignedLeads: LeadRecord[];
  changed: boolean;
}

/**
 * Automatic Duplicate Claim Cleanup on Load:
 * - Groups all `IN_PROGRESS` batches for `todayDate` by canonical `claimedByEmail` / `claimedByName` (`areRepEmailsEquivalentPure`).
 * - If any single Sales Rep has > 1 batch claimed for today (e.g., Savani Hasti has both `Batch #1` and `Batch #2`):
 *   - Keeps the batch with the highest `completedCallsCount` (or earliest `batchNumber`, i.e., `Batch #1`) assigned to that rep.
 *   - Resets any extra batch (`Batch #2`) back to `status: 'AVAILABLE'`, `claimedByEmail: null`, `claimedByName: null`, `claimedAt: null`.
 */
export function autoSanitizeDuplicateClaimedBatchesPure(
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  todayDate: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): DuplicateBatchClaimCleanupResult {
  const repGroups: {
    repEmail: string;
    repName?: string | null;
    batches: DailyBatchDocument[];
  }[] = [];

  for (const b of batches) {
    if (b.date !== todayDate || b.status !== 'IN_PROGRESS' || !b.claimedByEmail) {
      continue;
    }
    const existingGroup = repGroups.find((g) =>
      areRepEmailsEquivalentPure(
        b.claimedByEmail,
        g.repEmail,
        b.claimedByName,
        g.repName
      )
    );
    if (existingGroup) {
      existingGroup.batches.push(b);
    } else {
      const canonical = resolveCanonicalRepIdentity(
        b.claimedByEmail,
        b.claimedByName
      );
      repGroups.push({
        repEmail: (canonical?.email || b.claimedByEmail).toLowerCase().trim(),
        repName: canonical?.name || b.claimedByName,
        batches: [b],
      });
    }
  }

  const batchIdsToRelease = new Set<string>();
  for (const group of repGroups) {
    if (group.batches.length <= 1) continue;
    const sorted = [...group.batches].sort((a, b) => {
      const callsDiff = (b.completedCallsCount || 0) - (a.completedCallsCount || 0);
      if (callsDiff !== 0) return callsDiff;
      return a.batchNumber - b.batchNumber;
    });
    for (let i = 1; i < sorted.length; i++) {
      batchIdsToRelease.add(sorted[i].batchId);
    }
  }

  if (batchIdsToRelease.size === 0) {
    return {
      updatedBatches: batches,
      releasedBatches: [],
      updatedLeads: leads,
      unassignedLeads: [],
      changed: false,
    };
  }

  const releasedBatches: DailyBatchDocument[] = [];
  const releasedLeadIdSet = new Set<string>();

  const updatedBatches = batches.map((b) => {
    if (!batchIdsToRelease.has(b.batchId)) return b;
    for (const lid of b.leadIds || []) {
      releasedLeadIdSet.add(lid);
    }
    const released: DailyBatchDocument = {
      ...b,
      status: 'AVAILABLE',
      claimedByEmail: null,
      claimedByName: null,
      claimedAt: null,
    };
    releasedBatches.push(released);
    return released;
  });

  const unassignedLeads: LeadRecord[] = [];
  const updatedLeads = leads.map((lead) => {
    if (
      (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') &&
      ((lead.assignedBatchId && batchIdsToRelease.has(lead.assignedBatchId)) ||
        releasedLeadIdSet.has(lead.id)) &&
      (lead.assignedRepEmail || lead.assignedRepName)
    ) {
      const cleanedLead: LeadRecord = {
        ...lead,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
      unassignedLeads.push(cleanedLead);
      return cleanedLead;
    }
    return lead;
  });

  return {
    updatedBatches,
    releasedBatches,
    updatedLeads,
    unassignedLeads,
    changed: true,
  };
}

export interface ReleaseBatchClaimResult {
  updatedBatch: DailyBatchDocument;
  releasedBatch: DailyBatchDocument | null;
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  unassignedLeads: LeadRecord[];
}

/**
 * Owner 1-Click `[Release Batch]` State Transition:
 * Resets an `IN_PROGRESS` batch back to `AVAILABLE` (`claimedByEmail: null`, `claimedByName: null`, `claimedAt: null`)
 * and clears `assignedRepEmail` / `assignedRepName` on any uncalled `FRESH` leads in that batch.
 */
export function releaseBatchClaimPure(
  batchId: string,
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  nowIso: string = new Date().toISOString()
): ReleaseBatchClaimResult {
  const targetBatch = batches.find((b) => b.batchId === batchId);
  if (!targetBatch) {
    throw new Error(`Batch ${batchId} not found.`);
  }

  const updatedBatch: DailyBatchDocument = {
    ...targetBatch,
    status: 'AVAILABLE',
    claimedByEmail: null,
    claimedByName: null,
    claimedAt: null,
  };

  const constituentSet = new Set(targetBatch.leadIds || []);
  const unassignedLeads: LeadRecord[] = [];
  const updatedLeads = leads.map((lead) => {
    const belongsToBatch =
      constituentSet.has(lead.id) || lead.assignedBatchId === batchId;
    if (
      belongsToBatch &&
      (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH')
    ) {
      const cleanedLead: LeadRecord = {
        ...lead,
        assignedBatchId: batchId,
        assignedRepEmail: null,
        assignedRepName: null,
        updatedAt: nowIso,
      };
      unassignedLeads.push(cleanedLead);
      return cleanedLead;
    }
    return lead;
  });

  const updatedBatches = batches.map((b) =>
    b.batchId === batchId ? updatedBatch : b
  );

  return {
    updatedBatch,
    releasedBatch: updatedBatch,
    updatedBatches,
    updatedLeads,
    unassignedLeads,
  };
}

/**
 * Persists a released (`AVAILABLE`) batch document to Firestore `batches/{batchId}`.
 */
export async function executeFirestoreBatchRelease(
  batchId: string,
  fullBatchSnapshot?: DailyBatchDocument,
  _unassignedLeadIds?: string[]
): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;

  const payload = sanitizeFirestorePayload({
    ...(fullBatchSnapshot || {}),
    batchId,
    status: 'AVAILABLE',
    claimedByEmail: null,
    claimedByName: null,
    claimedAt: null,
  });

  try {
    const batchRef = doc(db, 'batches', batchId);
    await Promise.race([
      setDoc(batchRef, payload, { merge: true }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Non-blocking fallback
  }
}

export interface NightlySweepExecutionResult {
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  summary: NightlySweepSummary;
}

/**
 * Task 3: Pure 11:59 PM IST Daily Reset, Lead Release & Cooldown Sweeper Engine:
 * 1. Runs `runMidnightResetPure` (`functions/src/cron/midnightReset.ts`):
 *    - Unlinks all uncalled `FRESH` leads (`assignedBatchId != null && status === 'FRESH'`)
 *    - Retires today's `'AVAILABLE'` and `'IN_PROGRESS'` batches to `'CLOSED'` with
 *      `totalLeadsAssigned`, `completedCallsCount`, `uncalledReturnedCount`, and `closedAt`.
 * 2. Runs `runCooldownSweeperPure` (`functions/src/cron/cooldownSweeper.ts`):
 *    - Clears expired 48-hour cooldowns (`cooldownUntil <= now`) so leads enter Bucket B tomorrow
 *    - Enforces `didntReceiveCount > 10 -> DIDNT_RECEIVE_DEAD`
 *    - Audits `SWITCH_OFF` leads with `switchOffCount >= 3 -> SWITCH_OFF_DEAD` and `assignedBatchId = null`
 */
export function runNightlySweepPure(
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  targetDate: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): NightlySweepExecutionResult {
  const midnightResult = runMidnightResetPure(batches, leads, targetDate, nowIso);
  const cooldownResult = runCooldownSweeperPure(
    midnightResult.updatedLeads,
    new Date(nowIso)
  );

  const totalChunkOps =
    midnightResult.summary.chunkWriteOperations +
    (cooldownResult.summary.cooldownClearedCount +
      cooldownResult.summary.didntReceiveDeadCount +
      cooldownResult.summary.switchOffDeadCount >
    0
      ? cooldownResult.summary.chunkWriteOperations
      : 0);

  return {
    updatedBatches: midnightResult.updatedBatches,
    updatedLeads: cooldownResult.updatedLeads,
    summary: {
      ...midnightResult.summary,
      chunkWriteOperations: totalChunkOps,
      cooldownSweep: cooldownResult.summary,
    },
  };
}

/**
 * Executes both the Firestore 11:59 PM Midnight Lead Sweep (`midnightReset.ts`)
 * and the Cooldown & Dead-Lead Sweeper (`cooldownSweeper.ts`) in 500-op batched writes.
 */
export async function executeFirestoreNightlySweep(
  targetDate: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): Promise<void> {
  try {
    await Promise.race([
      (async () => {
        await executeMidnightResetFirestore(targetDate, nowIso);
        await executeCooldownSweeperFirestore(new Date(nowIso));
      })().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Graceful fallback in preview environment
  }
}

