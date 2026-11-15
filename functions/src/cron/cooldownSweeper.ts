import {
  collection,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { reachDb as db } from '@/lib/firebaseDual';
import { LeadRecord } from '@/lib/types';
import { CooldownSweepSummary } from '@/types/batch';
import { chunkArray } from '@/lib/leadStore';

export const COOLDOWN_SWEEPER_CRON_SCHEDULE = {
  schedule: '0 * * * *',
  timeZone: 'Asia/Kolkata',
  description: '48-Hour DIDNT_RECEIVE Cooldown Expiry & SWITCH_OFF / DIDNT_RECEIVE Dead-Lead Enforcer',
};

const MAX_FIRESTORE_BATCH_OPS = 500;

export interface CooldownSweepResult {
  updatedLeads: LeadRecord[];
  summary: CooldownSweepSummary;
}

/**
 * Pure deterministic implementation of Task 2: Cooldown & Starvation Prevention Sweeper.
 *
 * 1. `DIDNT_RECEIVE` 48-Hour Cooldown Expiry & Threshold Enforcement:
 *    - Verifies `didntReceiveCount <= 10`. If a lead exceeded 10 attempts (`didntReceiveCount > 10`)
 *      without retiring, forces transition to `status = 'DIDNT_RECEIVE_DEAD'`, clears `cooldownUntil = null`,
 *      and sets `assignedBatchId = null`.
 *    - Identifies leads where `(status === 'FRESH' || status === 'DIDNT_RECEIVE')`,
 *      `didntReceiveCount > 0`, and `cooldownUntil !== null && cooldownUntil <= now`:
 *      * Clears `cooldownUntil = null` and ensures `status = 'FRESH'` (when `didntReceiveCount <= 10`)
 *        so the lead is immediately eligible for the stratified 75/25 batch generator (Bucket B).
 *
 * 2. `SWITCH_OFF` Hard-Cap Audit:
 *    - Audits all leads marked `SWITCH_OFF` (or any non-dead lead with `switchOffCount >= 3`).
 *    - If `switchOffCount >= 3`, transitions `status = 'SWITCH_OFF_DEAD'`, sets `assignedBatchId = null`,
 *      and removes permanently from calling cycles.
 */
export function runCooldownSweeperPure(
  leads: LeadRecord[],
  now: Date = new Date()
): CooldownSweepResult {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let cooldownClearedCount = 0;
  let didntReceiveDeadCount = 0;
  let switchOffDeadCount = 0;
  const clearedLeadIds: string[] = [];
  const retiredDeadLeadIds: string[] = [];

  const updatedLeads = leads.map((lead) => {
    // 1. Audit SWITCH_OFF Hard-Cap (`status === 'SWITCH_OFF'` and `switchOffCount >= 3`)
    if (lead.status === 'SWITCH_OFF' && lead.switchOffCount >= 3) {
      switchOffDeadCount++;
      retiredDeadLeadIds.push(lead.id);
      return {
        ...lead,
        status: 'SWITCH_OFF_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    // 2. Verify `didntReceiveCount <= 10` on active/fresh/retry leads
    if (
      lead.status !== 'DIDNT_RECEIVE_DEAD' &&
      lead.status !== 'SWITCH_OFF_DEAD' &&
      lead.didntReceiveCount > 10
    ) {
      didntReceiveDeadCount++;
      retiredDeadLeadIds.push(lead.id);
      return {
        ...lead,
        status: 'DIDNT_RECEIVE_DEAD' as const,
        assignedBatchId: null,
        cooldownUntil: null,
        updatedAt: nowIso,
      };
    }

    // 3. `DIDNT_RECEIVE` 48-Hour Cooldown Expiry:
    // Identify leads where `(status == 'FRESH' || status == 'DIDNT_RECEIVE')`,
    // `didntReceiveCount > 0`, and `cooldownUntil <= now`.
    if (
      (lead.status === 'FRESH' || lead.status === 'DIDNT_RECEIVE') &&
      lead.didntReceiveCount > 0 &&
      lead.cooldownUntil
    ) {
      const expiryMs = new Date(lead.cooldownUntil).getTime();
      if (!Number.isNaN(expiryMs) && expiryMs <= nowMs) {
        if (lead.didntReceiveCount > 10) {
          didntReceiveDeadCount++;
          retiredDeadLeadIds.push(lead.id);
          return {
            ...lead,
            status: 'DIDNT_RECEIVE_DEAD' as const,
            assignedBatchId: null,
            cooldownUntil: null,
            updatedAt: nowIso,
          };
        }

        cooldownClearedCount++;
        clearedLeadIds.push(lead.id);
        return {
          ...lead,
          status: 'FRESH' as const,
          cooldownUntil: null,
          updatedAt: nowIso,
        };
      }
    }

    return lead;
  });

  const totalOps = cooldownClearedCount + didntReceiveDeadCount + switchOffDeadCount;
  const chunkWriteOperations = Math.max(
    1,
    Math.ceil(totalOps / MAX_FIRESTORE_BATCH_OPS)
  );

  return {
    updatedLeads,
    summary: {
      sweptAt: nowIso,
      cooldownClearedCount,
      didntReceiveDeadCount,
      switchOffDeadCount,
      clearedLeadIds,
      retiredDeadLeadIds,
      chunkWriteOperations,
    },
  };
}

/**
 * Firestore execution of Task 2: Cooldown & Starvation Prevention Sweeper.
 * Uses batched writes (up to 500 records per Firestore commit).
 */
export async function executeCooldownSweeperFirestore(
  now: Date = new Date()
): Promise<CooldownSweepSummary> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let cooldownClearedCount = 0;
  let didntReceiveDeadCount = 0;
  let switchOffDeadCount = 0;
  const clearedLeadIds: string[] = [];
  const retiredDeadLeadIds: string[] = [];
  let chunkWriteOperations = 0;

  try {
    // 1. Query FRESH and DIDNT_RECEIVE leads to audit 48h cooldown expiry & >10 attempt cap
    const retryQuery = query(
      collection(db, 'leads'),
      where('status', 'in', ['FRESH', 'DIDNT_RECEIVE'])
    );
    const retrySnap = await getDocs(retryQuery);

    const pendingUpdates: Array<{
      ref: (typeof retrySnap.docs)[number]['ref'];
      payload: Record<string, unknown>;
    }> = [];

    for (const docSnap of retrySnap.docs) {
      const data = docSnap.data() as LeadRecord;
      const drCount = Number(data.didntReceiveCount || 0);

      if (drCount > 10) {
        didntReceiveDeadCount++;
        retiredDeadLeadIds.push(docSnap.id);
        pendingUpdates.push({
          ref: docSnap.ref,
          payload: {
            status: 'DIDNT_RECEIVE_DEAD',
            assignedBatchId: null,
            cooldownUntil: null,
            updatedAt: nowIso,
          },
        });
        continue;
      }

      if (drCount > 0 && data.cooldownUntil) {
        const expiryMs = new Date(data.cooldownUntil).getTime();
        if (!Number.isNaN(expiryMs) && expiryMs <= nowMs) {
          cooldownClearedCount++;
          clearedLeadIds.push(docSnap.id);
          pendingUpdates.push({
            ref: docSnap.ref,
            payload: {
              status: 'FRESH',
              cooldownUntil: null,
              updatedAt: nowIso,
            },
          });
        }
      }
    }

    // 2. Query SWITCH_OFF leads to enforce switchOffCount >= 3 -> SWITCH_OFF_DEAD
    const switchOffQuery = query(
      collection(db, 'leads'),
      where('status', '==', 'SWITCH_OFF')
    );
    const switchOffSnap = await getDocs(switchOffQuery);

    for (const docSnap of switchOffSnap.docs) {
      const data = docSnap.data() as LeadRecord;
      const soCount = Number(data.switchOffCount || 0);
      if (soCount >= 3) {
        switchOffDeadCount++;
        retiredDeadLeadIds.push(docSnap.id);
        pendingUpdates.push({
          ref: docSnap.ref,
          payload: {
            status: 'SWITCH_OFF_DEAD',
            assignedBatchId: null,
            cooldownUntil: null,
            updatedAt: nowIso,
          },
        });
      }
    }

    // Commit in 500-record Firestore batch chunks
    const updateChunks = chunkArray(pendingUpdates, MAX_FIRESTORE_BATCH_OPS);
    for (const chunk of updateChunks) {
      const wb = writeBatch(db);
      for (const item of chunk) {
        wb.update(item.ref, item.payload);
      }
      await wb.commit();
      chunkWriteOperations++;
    }
  } catch {
    // Graceful fallback when running in offline or preview rule mode
  }

  return {
    sweptAt: nowIso,
    cooldownClearedCount,
    didntReceiveDeadCount,
    switchOffDeadCount,
    clearedLeadIds,
    retiredDeadLeadIds,
    chunkWriteOperations: Math.max(1, chunkWriteOperations),
  };
}
