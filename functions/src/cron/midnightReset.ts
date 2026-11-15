import {
  collection,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { reachDb as db } from '@/lib/firebaseDual';
import { LeadRecord } from '@/lib/types';
import {
  DailyBatchDocument,
  NightlySweepSummary,
  getTodayIstDateString,
} from '@/types/batch';
import { chunkArray } from '@/lib/leadStore';

export const MIDNIGHT_RESET_CRON_SCHEDULE = {
  schedule: '59 23 * * *',
  timeZone: 'Asia/Kolkata',
  description: '23:59:00 IST Automated Uncalled Batch Sweep & Batch Document Retirement',
};

const MAX_FIRESTORE_BATCH_OPS = 500;

export interface MidnightResetResult {
  updatedBatches: DailyBatchDocument[];
  updatedLeads: LeadRecord[];
  summary: NightlySweepSummary;
}

/**
 * Pure deterministic implementation of Task 1: Midnight Lead Sweep Engine (`23:59:00 IST`).
 *
 * 1. Uncalled Batch Sweep:
 *    - Finds all leads where `assignedBatchId != null` and `status == 'FRESH'`.
 *    - Resets `assignedBatchId = null`, `assignedRepEmail = null`, `assignedRepName = null`,
 *      and sets `updatedAt = nowIso`.
 *
 * 2. Batch Document Retirement:
 *    - Finds all batches for `todayString` (or active batches) where `status` is `'AVAILABLE'` or `'IN_PROGRESS'`.
 *    - Transitions `status` to `'CLOSED'`.
 *    - Calculates and stores day-end metrics on each batch document:
 *      * `totalLeadsAssigned`
 *      * `completedCallsCount`
 *      * `uncalledReturnedCount`
 *      * `closedAt = nowIso`
 */
export function runMidnightResetPure(
  batches: DailyBatchDocument[],
  leads: LeadRecord[],
  todayString: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): MidnightResetResult {
  let uncalledLeadsReleasedCount = 0;
  const releasedCountByBatch = new Map<string, number>();
  const totalAssignedByBatch = new Map<string, number>();

  for (const lead of leads) {
    if (lead.assignedBatchId) {
      totalAssignedByBatch.set(
        lead.assignedBatchId,
        (totalAssignedByBatch.get(lead.assignedBatchId) || 0) + 1
      );
    }
  }

  // 1. Uncalled Batch Sweep: assignedBatchId != null && status == 'FRESH'
  const updatedLeads = leads.map((lead) => {
    if (lead.assignedBatchId !== null && lead.status === 'FRESH') {
      uncalledLeadsReleasedCount++;
      const prevBatchId = lead.assignedBatchId;
      releasedCountByBatch.set(
        prevBatchId,
        (releasedCountByBatch.get(prevBatchId) || 0) + 1
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

  // 2. Batch Document Retirement: transition today's AVAILABLE or IN_PROGRESS batches to CLOSED
  const closedBatchIds: string[] = [];
  let totalDialedCallsCount = 0;

  const updatedBatches = batches.map((batch) => {
    const isTargetBatch =
      !todayString || batch.date === todayString || batch.status !== 'CLOSED';

    if (
      isTargetBatch &&
      (batch.status === 'AVAILABLE' || batch.status === 'IN_PROGRESS')
    ) {
      closedBatchIds.push(batch.batchId);
      const completedCalls = batch.completedCallsCount || 0;
      totalDialedCallsCount += completedCalls;

      const totalAssigned =
        batch.totalLeadsAssigned ??
        batch.totalLeads ??
        totalAssignedByBatch.get(batch.batchId) ??
        0;

      const uncalledReturned =
        releasedCountByBatch.get(batch.batchId) ??
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

  const totalWriteOps = uncalledLeadsReleasedCount + closedBatchIds.length;
  const chunkWriteOperations = Math.max(
    1,
    Math.ceil(totalWriteOps / MAX_FIRESTORE_BATCH_OPS)
  );

  return {
    updatedBatches,
    updatedLeads,
    summary: {
      sweptAt: nowIso,
      date: todayString,
      closedBatchesCount: closedBatchIds.length,
      totalDialedCallsCount,
      uncalledLeadsReleasedCount,
      closedBatchIds,
      chunkWriteOperations,
    },
  };
}

/**
 * Firestore execution of Task 1: Midnight Lead Sweep Engine (`23:59:00 IST` / `59 23 * * *`).
 * Commits all lead releases and batch retirements in batched writes of up to 500 records per commit.
 */
export async function executeMidnightResetFirestore(
  todayString: string = getTodayIstDateString(),
  nowIso: string = new Date().toISOString()
): Promise<{
  uncalledLeadsReleasedCount: number;
  closedBatchesCount: number;
  chunkWriteOperations: number;
}> {
  let uncalledLeadsReleasedCount = 0;
  let closedBatchesCount = 0;
  let chunkWriteOperations = 0;

  const hasConfiguredProject =
    Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY) &&
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY !== 'AIzaSySolarithmReachFallbackLocalKey000000';

  if (!hasConfiguredProject) {
    return {
      uncalledLeadsReleasedCount: 0,
      closedBatchesCount: 0,
      chunkWriteOperations: 1,
    };
  }

  try {
    // 1. Uncalled Batch Sweep: Query `leads` where `status == 'FRESH'` and `assignedBatchId != null`
    const freshLeadsQuery = query(
      collection(db, 'leads'),
      where('status', '==', 'FRESH')
    );
    const freshSnap = await getDocs(freshLeadsQuery);

    const releasedByBatchId = new Map<string, number>();
    const uncalledDocs = freshSnap.docs.filter((docSnap) => {
      const data = docSnap.data();
      return data.assignedBatchId !== null && data.assignedBatchId !== undefined;
    });

    uncalledLeadsReleasedCount = uncalledDocs.length;

    const leadChunks = chunkArray(uncalledDocs, 400);
    for (const chunk of leadChunks) {
      const wb = writeBatch(db);
      for (const docSnap of chunk) {
        const bId = docSnap.data().assignedBatchId as string;
        if (bId) {
          releasedByBatchId.set(bId, (releasedByBatchId.get(bId) || 0) + 1);
        }
        wb.update(docSnap.ref, {
          assignedBatchId: null,
          assignedRepEmail: null,
          assignedRepName: null,
          updatedAt: nowIso,
        });
      }
      await wb.commit();
      chunkWriteOperations++;
    }

    // 2. Batch Document Retirement: Query all `batches` that remain 'AVAILABLE' or 'IN_PROGRESS' (including prior dates <= todayString)
    const batchesQuery = query(
      collection(db, 'batches'),
      where('status', 'in', ['AVAILABLE', 'IN_PROGRESS'])
    );
    const batchesSnap = await getDocs(batchesQuery);
    closedBatchesCount = batchesSnap.docs.length;

    const batchChunks = chunkArray(batchesSnap.docs, 400);
    for (const chunk of batchChunks) {
      const wb = writeBatch(db);
      for (const bSnap of chunk) {
        const bData = bSnap.data() as DailyBatchDocument;
        const completedCallsCount = bData.completedCallsCount || 0;
        const totalLeadsAssigned = bData.totalLeadsAssigned ?? bData.totalLeads ?? 0;
        const uncalledReturnedCount =
          releasedByBatchId.get(bData.batchId) ??
          Math.max(0, totalLeadsAssigned - completedCallsCount);

        wb.update(bSnap.ref, {
          status: 'CLOSED',
          totalLeadsAssigned,
          completedCallsCount,
          uncalledReturnedCount,
          closedAt: nowIso,
        });
      }
      await wb.commit();
      chunkWriteOperations++;
    }
  } catch {
    // Graceful fallback when running in offline or preview rule mode
  }

  return {
    uncalledLeadsReleasedCount,
    closedBatchesCount,
    chunkWriteOperations: Math.max(1, chunkWriteOperations),
  };
}

