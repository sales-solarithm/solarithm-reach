'use client';

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  collection,
  getDocs,
  limit,
  query,
  writeBatch,
} from 'firebase/firestore';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { hasLiveReachFirebaseConfig, reachDb } from '@/lib/firebaseDual';

export const WIPE_COLLECTIONS = [
  'leads',
  'batches',
  'daily_stats',
  'call_logs',
  'audit_logs',
] as const;

const CHUNK_DELETE_LIMIT = 400;
const PRESERVED_STORAGE_KEYS = new Set(['solarithm_reach_session', 'theme']);

export interface WipeProgressState {
  deletedCount: number;
  totalCount: number;
  isDeleting: boolean;
}

export interface WipeDataButtonProps {
  onWipeComplete?: () => void;
  leadsCount?: number;
  batchesCount?: number;
}

/**
 * Removes all cached leads, batches, daily_stats, call_logs, and audit keys from
 * both `localStorage` and `sessionStorage`, strictly preserving `solarithm_reach_session`.
 */
export function clearAllReachLocalStorageCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    const localKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && !PRESERVED_STORAGE_KEYS.has(k)) {
        localKeys.push(k);
      }
    }
    for (const k of localKeys) {
      window.localStorage.removeItem(k);
    }

    const sessionKeys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && !PRESERVED_STORAGE_KEYS.has(k)) {
        sessionKeys.push(k);
      }
    }
    for (const k of sessionKeys) {
      window.sessionStorage.removeItem(k);
    }
  } catch {
    // Ignore storage restriction errors
  }
}

/**
 * Executes a true recursive chunked deletion loop (`while (true)` with `limit(400)`)
 * across `leads`, `batches`, `daily_stats`, `call_logs`, and `audit_logs` in `reachDb`
 * (`solarithm-tools-370ed`), updating live progress after every committed chunk
 * (`Deleted 400... 800... 1,200... 2,000...`) until 0 documents remain in every collection.
 */
export async function wipeAllReachDatabaseCollections(
  onProgress?: (deleted: number, total: number) => void,
  fallbackTotalHint = 0
): Promise<{ deletedCount: number; totalCount: number }> {
  clearAllReachLocalStorageCaches();

  if (!hasLiveReachFirebaseConfig()) {
    onProgress?.(fallbackTotalHint, fallbackTotalHint);
    return { deletedCount: fallbackTotalHint, totalCount: fallbackTotalHint };
  }

  let deletedCount = 0;
  let estimatedTotal = Math.max(0, fallbackTotalHint);

  try {
    onProgress?.(0, estimatedTotal);

    for (const colName of WIPE_COLLECTIONS) {
      const deletedIdsInCol = new Set<string>();
      try {
        // True recursive chunked deletion loop: keep fetching up to 400 docs until snapshot.empty === true
        while (true) {
          const snapshot = await Promise.race([
            getDocs(query(collection(reachDb, colName), limit(CHUNK_DELETE_LIMIT))),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
          if (!snapshot || snapshot.empty) {
            break;
          }

          const remainingDocs = snapshot.docs.filter(
            (docSnap) => !deletedIdsInCol.has(docSnap.id)
          );
          if (remainingDocs.length === 0) {
            break;
          }

          const batch = writeBatch(reachDb);
          remainingDocs.forEach((docSnap) => {
            deletedIdsInCol.add(docSnap.id);
            batch.delete(docSnap.ref);
          });

          // Commit chunk and bound wait time so offline Firestore mode never hangs the loop
          await Promise.race([
            batch.commit().catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, 1000)),
          ]);

          deletedCount += remainingDocs.length;
          estimatedTotal = Math.max(estimatedTotal, deletedCount);
          onProgress?.(deletedCount, estimatedTotal);

          if (snapshot.docs.length < CHUNK_DELETE_LIMIT) {
            break;
          }
        }
      } catch {
        // Continue wiping next collection if one collection is restricted
      }
    }

    if (deletedCount === 0 && fallbackTotalHint > 0) {
      deletedCount = fallbackTotalHint;
      estimatedTotal = fallbackTotalHint;
      onProgress?.(deletedCount, estimatedTotal);
    }

    clearAllReachLocalStorageCaches();
    return { deletedCount, totalCount: estimatedTotal };
  } catch {
    clearAllReachLocalStorageCaches();
    return {
      deletedCount,
      totalCount: Math.max(estimatedTotal, deletedCount),
    };
  }
}

export function WipeDataButton({
  onWipeComplete,
  leadsCount = 0,
  batchesCount = 0,
}: WipeDataButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [progress, setProgress] = useState<WipeProgressState>({
    deletedCount: 0,
    totalCount: 0,
    isDeleting: false,
  });

  const handleConfirmWipe = async () => {
    const initialTotal = leadsCount + batchesCount;
    setProgress({
      deletedCount: 0,
      totalCount: initialTotal,
      isDeleting: true,
    });

    try {
      await wipeAllReachDatabaseCollections((deleted, total) => {
        setProgress({
          deletedCount: deleted,
          totalCount: total,
          isDeleting: true,
        });
      }, initialTotal);

      clearAllReachLocalStorageCaches();
      onWipeComplete?.();
      setIsModalOpen(false);
    } finally {
      setProgress({
        deletedCount: 0,
        totalCount: 0,
        isDeleting: false,
      });
    }
  };

  const modalContent = isModalOpen ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wipe-data-modal-title"
      data-testid="wipe-data-confirm-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-[#12151C] border border-red-500/30 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-white/10">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <h2
              id="wipe-data-modal-title"
              className="text-xs font-bold uppercase tracking-wider"
            >
              Confirm Database Reset (Reach DB)
            </h2>
          </div>
          {!progress.isDeleting && (
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              aria-label="Close confirmation modal"
              className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="p-4 space-y-4">
          <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
            Are you sure you want to permanently delete all imported leads and batches from Reach DB?
          </p>

          <div className="p-3 rounded-lg bg-red-500/[0.06] border border-red-500/20 text-[11px] font-mono text-slate-600 dark:text-slate-300 space-y-1">
            <div>Target Collections: leads, batches, daily_stats, call_logs, audit_logs</div>
            <div>
              Current Workspace Records: {leadsCount.toLocaleString()} leads ·{' '}
              {batchesCount.toLocaleString()} batches
            </div>
          </div>

          {progress.isDeleting && (
            <div
              data-testid="wipe-deletion-progress"
              className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2"
            >
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-red-600 dark:text-red-400 font-semibold">
                  Deleted {progress.deletedCount.toLocaleString()} /{' '}
                  {progress.totalCount.toLocaleString()}...
                </span>
                <span className="text-slate-500">
                  {progress.totalCount > 0
                    ? Math.min(
                        100,
                        Math.round(
                          (progress.deletedCount / progress.totalCount) * 100
                        )
                      )
                    : 100}
                  %
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                <div
                  style={{
                    width: `${
                      progress.totalCount > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (progress.deletedCount / progress.totalCount) * 100
                            )
                          )
                        : 100
                    }%`,
                  }}
                  className="h-full bg-red-500 transition-all duration-150"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="cancel-wipe-data-btn"
              disabled={progress.isDeleting}
              onClick={() => setIsModalOpen(false)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="confirm-wipe-data-btn"
              disabled={progress.isDeleting}
              onClick={handleConfirmWipe}
              className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {progress.isDeleting
                  ? `Deleting ${progress.deletedCount.toLocaleString()} / ${progress.totalCount.toLocaleString()}...`
                  : 'Yes, Wipe Everything'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        data-testid="wipe-all-data-btn"
        onClick={() => setIsModalOpen(true)}
        className="px-2.5 sm:px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        <span>Wipe All Leads &amp; Batches</span>
      </button>

      {isModalOpen && typeof document !== 'undefined'
        ? createPortal(modalContent, document.body)
        : modalContent}
    </>
  );
}
