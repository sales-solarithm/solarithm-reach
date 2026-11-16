'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  Lock,
  PhoneOutgoing,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { hasLiveReachFirebaseConfig, reachDb as db } from '@/lib/firebaseDual';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import {
  DailyBatchDocument,
  getTodayIstDateString,
} from '@/types/batch';
import {
  filterBatchesForUser,
} from '@/lib/batchResetCron';
import {
  ActiveReachSalesRep,
  filterAndSortReachSalesRepsPure,
  getActiveSalesReps,
} from '@/lib/employeeQueries';
import { CANONICAL_NEXUS_EMPLOYEES } from '@/lib/authService';
import { areRepEmailsEquivalentPure } from '@/lib/dailyStatsService';
import { formatRepName } from '@/lib/utils';

interface DailyBatchSelectorProps {
  currentUser: AuthorizedUser;
  authorizedUsers?: AuthorizedUser[];
  batches: DailyBatchDocument[];
  leads: LeadRecord[];
  activeBatchIdFilter?: string | null;
  onSelectActiveBatchWorkspace?: (batchId: string | null) => void;
  onClaimBatch: (batchId: string, rep: AuthorizedUser) => Promise<void>;
  onReleaseBatch?: (batchId: string) => Promise<void>;
  onGenerateNewDailyBatch?: (targetSize: number) => void;
  onRunNightlySweep?: () => Promise<unknown>;
  onSyncBatchesFromFirestore?: (remoteBatches: DailyBatchDocument[]) => void;
}

export function DailyBatchSelector({
  currentUser,
  authorizedUsers = [],
  batches,
  leads,
  onClaimBatch,
  onReleaseBatch,
  onSyncBatchesFromFirestore,
}: DailyBatchSelectorProps) {
  const isOwner = Boolean(
    currentUser.isOwnerTier ||
      currentUser.role === 'owner' ||
      currentUser.role === 'OWNER' ||
      currentUser.role === 'ADMIN'
  );
  const todayDate = useMemo(() => getTodayIstDateString(), []);

  const [includeOwnersInDropdown, setIncludeOwnersInDropdown] = useState(false);

  // Dynamically populate active sales representatives using getActiveSalesReps() from lib/employeeQueries.ts
  const [nexusSalesReps, setNexusSalesReps] = useState<ActiveReachSalesRep[]>(() =>
    filterAndSortReachSalesRepsPure(CANONICAL_NEXUS_EMPLOYEES, {
      includeOwners: false,
    })
  );

  useEffect(() => {
    let active = true;
    void getActiveSalesReps({ includeOwners: includeOwnersInDropdown }).then(
      (reps) => {
        if (active && reps.length > 0) {
          setNexusSalesReps(reps);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [includeOwnersInDropdown]);

  const salesReps = useMemo(() => {
    const byEmail = new Map<string, AuthorizedUser>();

    for (const rep of nexusSalesReps) {
      const roleUpper = (rep.role || 'SALES').toUpperCase();
      const isOwnerRep = roleUpper === 'OWNER' || roleUpper === 'ADMIN';
      byEmail.set(rep.email.toLowerCase().trim(), {
        email: rep.email.toLowerCase().trim(),
        name: rep.name,
        role: (isOwnerRep ? 'OWNER' : 'SALES') as AuthorizedUser['role'],
        status: 'ACTIVE',
        employeeId: rep.employeeId,
        uid: rep.uid,
        designation: rep.designation,
        isOwnerTier: isOwnerRep,
        isSalesTier: !isOwnerRep,
      });
    }

    if (!isOwner && !byEmail.has(currentUser.email.toLowerCase().trim())) {
      byEmail.set(currentUser.email.toLowerCase().trim(), currentUser);
    }

    return Array.from(byEmail.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [nexusSalesReps, isOwner, currentUser]);

  // Per-batch selected rep email for the Owner-only "Assign to Rep" dropdown on AVAILABLE cards
  const [selectedRepByBatch, setSelectedRepByBatch] = useState<Record<string, string>>({});
  const [claimingBatchId, setClaimingBatchId] = useState<string | null>(null);
  const [releasingBatchId, setReleasingBatchId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  // Listen to active batches for today via single-field `where('date', '==', todayDate)` query (no composite index required)
  useEffect(() => {
    if (!hasLiveReachFirebaseConfig()) return;

    let unsubscribe: (() => void) | undefined;
    try {
      const q = query(collection(db, 'batches'), where('date', '==', todayDate));
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          if (!snapshot.empty && onSyncBatchesFromFirestore) {
            const remote: DailyBatchDocument[] = [];
            snapshot.forEach((docSnap) => {
              const data = docSnap.data() as DailyBatchDocument;
              if (data?.batchId) remote.push(data);
            });
            if (remote.length > 0) {
              onSyncBatchesFromFirestore(remote);
            }
          }
        },
        () => {
          // Ignore permission or offline errors in preview sandbox
        }
      );
    } catch {
      // Ignore offline error
    }
    return () => unsubscribe?.();
  }, [todayDate, onSyncBatchesFromFirestore]);

  // Helper to compute live remaining FRESH leads in a given batch (accurate in both full-memory and 50-row paged mode)
  const getBatchRemainingFreshLeadsCount = useMemo(() => {
    const freshByBatchId = new Map<string, number>();
    for (const l of leads) {
      if (
        (l.status === 'FRESH' || l.status === 'REVIVED_FRESH') &&
        l.assignedBatchId
      ) {
        freshByBatchId.set(
          l.assignedBatchId,
          (freshByBatchId.get(l.assignedBatchId) || 0) + 1
        );
      }
    }

    return (batch: DailyBatchDocument): number => {
      const total = batch.totalLeads ?? batch.leadIds?.length ?? 0;
      const dialed = batch.completedCallsCount || 0;
      const counterRemaining =
        batch.remainingLeads !== undefined
          ? batch.remainingLeads
          : Math.max(0, total - dialed);

      const liveFresh = freshByBatchId.get(batch.batchId);
      if (liveFresh !== undefined && leads.length >= total && total > 0) {
        return liveFresh;
      }
      return Math.max(liveFresh ?? 0, counterRemaining);
    };
  }, [leads]);

  const getBatchDialedCallsCount = useMemo(() => {
    return (batch: DailyBatchDocument): number => {
      const total = batch.totalLeads ?? batch.leadIds?.length ?? 0;
      const remaining = getBatchRemainingFreshLeadsCount(batch);
      const rawCompleted = batch.completedCallsCount || 0;
      if (total > 0 && remaining <= total) {
        const derivedFromRemaining = Math.max(0, total - remaining);
        // Never display an inflated completedCallsCount that exceeds (total - remaining)
        if (rawCompleted > derivedFromRemaining && remaining > 0) {
          return derivedFromRemaining;
        }
      }
      return rawCompleted;
    };
  }, [getBatchRemainingFreshLeadsCount]);

  // Check if current Sales Rep has already claimed 1 batch for today
  const myActiveClaimedBatch = useMemo(() => {
    if (isOwner) return null;
    return (
      batches.find(
        (b) =>
          b.date === todayDate &&
          b.status === 'IN_PROGRESS' &&
          areRepEmailsEquivalentPure(
            b.claimedByEmail,
            currentUser.email,
            b.claimedByName,
            currentUser.name
          )
      ) || null
    );
  }, [batches, isOwner, todayDate, currentUser.email, currentUser.name]);

  // Multi-User Isolation & Strict 1-Batch-Per-Day filter:
  // - For Owner Tier: Shows active batches for today (`AVAILABLE`, `IN_PROGRESS`).
  // - For Sales Rep:
  //   - If they HAVE claimed a batch today (`myActiveClaimedBatch`), `filterBatchesForUser` returns `[myActiveClaimedBatch]`,
  //     and the batch card grid is hidden so ONLY their single claimed batch summary banner is shown!
  //   - If they have NOT claimed a batch today yet, shows all `AVAILABLE` batches for today with a direct 1-click `[Claim Batch]` button.
  const visibleBatches = useMemo(
    () =>
      filterBatchesForUser(batches, currentUser, todayDate)
        .filter((b) => b.status !== 'CLOSED')
        .sort((a, b) => a.batchNumber - b.batchNumber),
    [batches, currentUser, todayDate]
  );

  const totalTodayBatchesCount = useMemo(
    () => batches.filter((b) => b.date === todayDate && b.status !== 'CLOSED').length,
    [batches, todayDate]
  );

  const uncalledFreshLockedCount = useMemo(() => {
    const activeTodayBatches = batches.filter(
      (b) => b.date === todayDate && b.status !== 'CLOSED'
    );
    return activeTodayBatches.reduce(
      (sum, b) => sum + getBatchRemainingFreshLeadsCount(b),
      0
    );
  }, [batches, todayDate, getBatchRemainingFreshLeadsCount]);

  const handleLockAndClaim = async (batch: DailyBatchDocument, overrideEmail?: string) => {
    setClaimError(null);

    // Enforce Strict 1 Batch Per Day Limit before claiming
    if (!isOwner && myActiveClaimedBatch) {
      setClaimError(
        `You have already claimed Batch #${myActiveClaimedBatch.batchNumber} for today (limit 1 batch per day).`
      );
      return;
    }

    setClaimingBatchId(batch.batchId);
    try {
      const chosenEmail = !isOwner
        ? currentUser.email
        : overrideEmail || selectedRepByBatch[batch.batchId] || salesReps[0]?.email;

      if (!chosenEmail) {
        setClaimError('Please select a sales representative to claim this batch.');
        return;
      }

      // Check if chosen rep already has a claimed batch today
      const alreadyClaimedByTarget = batches.find(
        (b) =>
          b.date === todayDate &&
          b.batchId !== batch.batchId &&
          b.status === 'IN_PROGRESS' &&
          b.claimedByEmail &&
          areRepEmailsEquivalentPure(b.claimedByEmail, chosenEmail, b.claimedByName)
      );
      if (alreadyClaimedByTarget) {
        setClaimError(
          `This representative has already claimed Batch #${alreadyClaimedByTarget.batchNumber} for today (limit 1 batch per day).`
        );
        return;
      }

      const repProfile = !isOwner
        ? {
            ...currentUser,
            email: currentUser.email.toLowerCase().trim(),
            name: currentUser.name,
          }
        : salesReps.find((u) =>
            areRepEmailsEquivalentPure(u.email, chosenEmail, u.name)
          ) ||
          authorizedUsers.find((u) =>
            areRepEmailsEquivalentPure(u.email, chosenEmail, u.name)
          ) ||
          currentUser;

      await onClaimBatch(batch.batchId, repProfile);
    } catch (err) {
      setClaimError(
        err instanceof Error ? err.message : 'Unable to claim batch. It may already be locked.'
      );
    } finally {
      setClaimingBatchId(null);
    }
  };

  const handleReleaseBatchClick = async (batchId: string) => {
    if (!onReleaseBatch) return;
    setClaimError(null);
    setReleasingBatchId(batchId);
    try {
      await onReleaseBatch(batchId);
    } catch (err) {
      setClaimError(
        err instanceof Error ? err.message : 'Unable to release batch.'
      );
    } finally {
      setReleasingBatchId(null);
    }
  };

  const myActiveBatchRemainingCount = myActiveClaimedBatch
    ? getBatchRemainingFreshLeadsCount(myActiveClaimedBatch)
    : 0;
  const myActiveBatchDialedCount = myActiveClaimedBatch
    ? getBatchDialedCallsCount(myActiveClaimedBatch)
    : 0;

  return (
    <section
      aria-label="Daily Batch Allocation & Morning Rep Lock"
      data-testid="daily-batch-selector-section"
      className="space-y-3"
    >
      {/* Compact Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            {isOwner
              ? `Daily Batch Allocation & Supervisory Monitor (${todayDate})`
              : `Morning Batch Allocation (${todayDate})`}
          </h2>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-[11px] font-mono text-[#B88917] dark:text-[#E5B842]">
            {isOwner
              ? `${visibleBatches.length} Batches (${uncalledFreshLockedCount.toLocaleString()} Uncalled FRESH Assigned)`
              : myActiveClaimedBatch
              ? `Batch #${myActiveClaimedBatch.batchNumber} Claimed by You (1 Batch/Day Limit Active)`
              : `${visibleBatches.length} Available (${Math.max(
                  0,
                  totalTodayBatchesCount - visibleBatches.length
                )} Claimed by Peers Hidden)`}
          </span>
        </div>

        {/* Owner-Only Self-Assignment Toggle */}
        {isOwner && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <label
              data-testid="toggle-include-owners-dropdown"
              className="px-2.5 py-1.5 rounded bg-slate-100 dark:bg-white/[0.05] border border-slate-200 dark:border-white/10 text-[11px] font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={includeOwnersInDropdown}
                onChange={(e) => setIncludeOwnersInDropdown(e.target.checked)}
                className="rounded border-slate-300 text-amber-500 focus:ring-0 cursor-pointer"
              />
              <span>Include Owners in Rep List</span>
            </label>
          </div>
        )}
      </div>

      {claimError && (
        <div
          role="alert"
          className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-center gap-2"
        >
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{claimError}</span>
        </div>
      )}

      {/* Single Claimed Batch Summary Banner for the Claiming Sales Rep (No queue toggle buttons; other batches hidden) */}
      {myActiveClaimedBatch && (
        <div
          data-testid="claiming-rep-active-workspace-banner"
          className="p-3.5 rounded-lg bg-[#E5B842]/10 border border-[#E5B842]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-xs font-bold text-[#9A7110] dark:text-[#E5B842]">
              <PhoneOutgoing className="w-3.5 h-3.5" />
              <span data-testid="active-claimed-batch-card-title">
                Batch #{myActiveClaimedBatch.batchNumber} — Claimed by You ·{' '}
                {myActiveBatchRemainingCount.toLocaleString()} Fresh Leads Remaining
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Batch ID: <span className="font-mono">{myActiveClaimedBatch.batchId}</span> · Locked by{' '}
              <strong>{formatRepName(myActiveClaimedBatch.claimedByName)}</strong> · Completed Calls:{' '}
              <strong className="font-mono tabular-nums">
                {myActiveBatchDialedCount.toLocaleString()}
              </strong>{' '}
              / {(myActiveClaimedBatch.totalLeads ?? myActiveClaimedBatch.leadIds?.length ?? 0).toLocaleString()} Leads
            </p>
          </div>

          <span
            data-testid={`batch-status-badge-${myActiveClaimedBatch.batchNumber}`}
            className="px-2.5 py-1 rounded bg-[#E5B842]/15 border border-[#E5B842]/35 text-[11px] font-mono font-semibold text-[#9A7110] dark:text-[#E5B842] whitespace-nowrap self-start sm:self-center"
          >
            Claimed by You
          </span>
        </div>
      )}

      {/* Daily Batch Display Card Grid:
          - For Owner: always visible showing all batches (`Available`, `Claimed by [Rep]`, `Closed`) + Owner assignment dropdown + Release Batch control.
          - For Sales Rep: ONLY shown BEFORE the Sales Rep claims their 1 batch for today! Once claimed, hidden immediately. */}
      {(isOwner || !myActiveClaimedBatch) && (
        <div
          aria-label="Morning Batch Selection Area"
          data-testid="morning-batch-selection-area"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
        >
          {visibleBatches.length === 0 ? (
            <div className="col-span-full p-6 rounded-lg bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-center space-y-1">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                No Available Batches Remaining for Today
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Upload fresh leads via Excel / CSV to automatically partition equal batches across active sales reps.
              </p>
            </div>
          ) : (
            visibleBatches.map((batch) => {
              const isAvailable = batch.status === 'AVAILABLE';
              const isInProgress = batch.status === 'IN_PROGRESS';
              const isClosed = batch.status === 'CLOSED';
              const totalLeadsCount = batch.totalLeads ?? batch.leadIds?.length ?? 0;
              const remainingFreshCount = getBatchRemainingFreshLeadsCount(batch);
              const claimedRepShortName = batch.claimedByName
                ? formatRepName(batch.claimedByName)
                : 'Rep';

              return (
                <div
                  key={batch.batchId}
                  data-testid={`batch-card-${batch.batchNumber}`}
                  className={`p-4 rounded-lg border transition-colors flex flex-col justify-between gap-3 ${
                    isAvailable
                      ? 'bg-white dark:bg-[#11141B] border-slate-200 dark:border-white/10'
                      : isInProgress
                      ? 'bg-white dark:bg-[#11141B] border-[#E5B842]/40'
                      : 'bg-slate-100/60 dark:bg-[#0D1016] border-slate-200/70 dark:border-white/5 opacity-80'
                  }`}
                >
                  {/* Top Row: Header `Batch #X`, Live Fresh Lead Count, and Status Badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-900 dark:text-white">
                          Batch #{batch.batchNumber}
                        </span>
                        <span className="text-xs font-mono font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
                          {isInProgress
                            ? `${remainingFreshCount.toLocaleString()} Fresh Leads Remaining`
                            : `${totalLeadsCount.toLocaleString()} Leads`}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        {batch.batchId}
                      </div>
                    </div>

                    {/* Status Badge */}
                    {isAvailable && (
                      <span
                        data-testid={`batch-status-badge-${batch.batchNumber}`}
                        className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-[11px] font-mono font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap"
                      >
                        Available
                      </span>
                    )}
                    {isInProgress && (
                      <span
                        data-testid={`batch-status-badge-${batch.batchNumber}`}
                        className="px-2 py-0.5 rounded bg-[#E5B842]/15 border border-[#E5B842]/35 text-[11px] font-mono font-semibold text-[#9A7110] dark:text-[#E5B842] whitespace-nowrap"
                      >
                        {`Claimed by ${claimedRepShortName}`}
                      </span>
                    )}
                    {isClosed && (
                      <span
                        data-testid={`batch-status-badge-${batch.batchNumber}`}
                        className="px-2 py-0.5 rounded bg-slate-500/10 border border-slate-500/20 text-[11px] font-mono font-semibold text-slate-400 dark:text-slate-500 whitespace-nowrap"
                      >
                        Closed
                      </span>
                    )}
                  </div>

                  {/* Action Row:
                      - Owner View on AVAILABLE batch: "Assign to Rep..." dropdown (disables reps who already claimed a batch today) + Claim button
                      - Sales Rep View on AVAILABLE batch: Single direct 1-click `[Claim Batch]` button (NO dropdown!)
                      - Claimed / Closed batch: Rep & dialed summary + Owner `[Release Batch]` button */}
                  {isAvailable ? (
                    isOwner ? (
                      <div className="flex items-center gap-2 pt-1">
                        <div className="relative flex-1 min-w-0">
                          <UserCheck className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <select
                            id={`assign-rep-${batch.batchId}`}
                            aria-label={`Assign to Rep for Batch #${batch.batchNumber}`}
                            data-testid={`claim-batch-select-${batch.batchNumber}`}
                            value={selectedRepByBatch[batch.batchId] || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSelectedRepByBatch((prev) => ({
                                ...prev,
                                [batch.batchId]: val,
                              }));
                              if (val) {
                                void handleLockAndClaim(batch, val);
                              }
                            }}
                            className="w-full pl-8 pr-2.5 py-1.5 rounded bg-slate-50 dark:bg-[#0D1016] border border-slate-200 dark:border-white/15 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#E5B842] cursor-pointer"
                          >
                            <option value="">Assign to Rep...</option>
                            {salesReps.map((rep) => {
                              const claimedBatchForRep = batches.find(
                                (b) =>
                                  b.date === todayDate &&
                                  b.status === 'IN_PROGRESS' &&
                                  b.claimedByEmail &&
                                  areRepEmailsEquivalentPure(
                                    b.claimedByEmail,
                                    rep.email,
                                    b.claimedByName,
                                    rep.name
                                  )
                              );
                              const shortRepName = formatRepName(rep.name);
                              return (
                                <option
                                  key={rep.email}
                                  value={rep.email}
                                  disabled={Boolean(claimedBatchForRep)}
                                >
                                  {claimedBatchForRep
                                    ? `${shortRepName} (Already Claimed Batch #${claimedBatchForRep.batchNumber})`
                                    : shortRepName}
                                </option>
                              );
                            })}
                          </select>
                        </div>

                        <button
                          type="button"
                          data-testid={`claim-batch-btn-${batch.batchNumber}`}
                          disabled={claimingBatchId === batch.batchId}
                          onClick={() => handleLockAndClaim(batch)}
                          className="px-3 py-1.5 rounded bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1 shrink-0 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Lock className="w-3 h-3 text-[#E5B842]" />
                          <span>
                            {claimingBatchId === batch.batchId ? 'Locking...' : 'Claim'}
                          </span>
                        </button>
                      </div>
                    ) : (
                      <div className="pt-1">
                        <button
                          type="button"
                          data-testid={`claim-batch-btn-${batch.batchNumber}`}
                          disabled={claimingBatchId === batch.batchId}
                          onClick={() => handleLockAndClaim(batch, currentUser.email)}
                          className="w-full py-2 px-3 rounded bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Lock className="w-3.5 h-3.5 text-[#E5B842]" />
                          <span>
                            {claimingBatchId === batch.batchId
                              ? 'Claiming...'
                              : 'Claim Batch for Myself'}
                          </span>
                        </button>
                      </div>
                    )
                  ) : (
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-white/5 text-xs">
                      <div className="min-w-0 truncate">
                        <span className="text-slate-500 dark:text-slate-400">Rep: </span>
                        <strong className="text-slate-900 dark:text-white truncate">
                          {batch.claimedByName
                            ? formatRepName(batch.claimedByName)
                            : 'Unclaimed'}
                        </strong>
                        <span className="ml-2 font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                          · {getBatchDialedCallsCount(batch).toLocaleString()} /{' '}
                          {totalLeadsCount.toLocaleString()} dialed
                        </span>
                      </div>
                      {isOwner && isInProgress && onReleaseBatch && (
                        <button
                          type="button"
                          data-testid={`release-batch-btn-${batch.batchNumber}`}
                          disabled={releasingBatchId === batch.batchId}
                          onClick={() => handleReleaseBatchClick(batch.batchId)}
                          className="px-2.5 py-1 rounded border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.09] text-[11px] font-medium text-slate-700 dark:text-slate-300 shrink-0 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {releasingBatchId === batch.batchId
                            ? 'Releasing...'
                            : 'Release Batch'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
