'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, CheckCircle2 } from 'lucide-react';
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { reachDb as db } from '@/lib/firebaseDual';
import { useAuth } from '@/context/AuthContext';
import { LoginModal } from '@/components/auth/LoginModal';
import { Header } from '@/components/layout/Header';
import {
  CALLING_TABLE_PAGE_SIZE,
  CallingTable,
} from '@/components/calling/CallingTable';
import { AddLeadModal } from '@/components/leads/AddLeadModal';
import { ExcelUploadModal } from '@/components/leads/ExcelUploadModal';
import { OwnerAnalyticsView } from '@/components/analytics/OwnerAnalyticsView';
import { SalesRepAnalyticsView } from '@/components/analytics/SalesRepAnalyticsView';
import { MetricCards } from '@/components/dashboard/MetricCards';
import { WorkspaceNav } from '@/components/dashboard/WorkspaceNav';
import {
  BatchRecord,
  InterestedSubFilter,
  LeadRecord,
  LeadStatus,
  OwnerSubStatus,
} from '@/lib/types';
import {
  WorkspaceFilterTab,
  applyManualCompanyNameEditPure,
  filterAndSortWorkspaceTableLeadsPure,
  isLegacyMockBatch,
  isLegacyMockOrSyntheticLead,
  loadLocalBatches,
  loadLocalLeads,
  purgeLegacySeededMockLeadsFromFirestore,
  saveLocalBatches,
  saveLocalLeads,
  syncLeadsToFirestore,
} from '@/lib/leadStore';
import {
  DEFAULT_TEAM_TARGETS,
  TeamTargetsConfig,
  fetchTeamTargetsFromFirestore,
  loadLocalTeamTargets,
} from '@/components/settings/TargetSettings';
import {
  autoSanitizeDuplicateClaimedBatchesPure,
  claimBatchStateTransition,
  executeFirestoreBatchClaim,
  executeFirestoreBatchRelease,
  persistDailyBatchesToFirestore,
  persistDailyBatchToFirestore,
  releaseBatchClaimPure,
} from '@/lib/batchResetCron';
import {
  autoSweepStaleBatchesAndGenerateTodayBatchesFirestore,
  doesBatchBelongToTodayPure,
  partitionFreshLeadsEquallyForActiveRepsPure,
} from '@/lib/batchGenerator';
import { clearAllReachLocalStorageCaches } from '@/components/admin/WipeDataButton';
import {
  filterAndSortReachSalesRepsPure,
  getActiveSalesReps,
} from '@/lib/employeeQueries';
import { CANONICAL_NEXUS_EMPLOYEES } from '@/lib/authService';
import {
  DailyRepStatRecord,
  areRepEmailsEquivalentPure,
  fetchDailyStatsFromFirestore,
  fetchOwnerMetricCountsFromServer,
  loadLocalDailyStats,
  saveLocalDailyStats,
  syncDailyStatsToFirestore,
} from '@/lib/dailyStatsService';
import {
  OwnerMetricStripData,
  computeOwnerMetricStripPure,
  computeSalesRepMetricStripPure,
} from '@/lib/dashboardMetrics';
import {
  AnalyticsDateFilter,
  AnalyticsDatePreset,
  applyCallDispositionUpdatePure,
} from '@/lib/performanceAnalytics';
import { DailyBatchSelector } from '@/components/batches/DailyBatchSelector';
import {
  DailyBatchDocument,
  getTodayIstDateString,
} from '@/types/batch';


export default function DashboardPage() {
  const { user, authorizedUsers, isLoading } = useAuth();
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyRepStatRecord[]>([]);
  const [serverOwnerMetrics, setServerOwnerMetrics] =
    useState<OwnerMetricStripData | null>(null);
  const [teamTargets, setTeamTargets] =
    useState<TeamTargetsConfig>(DEFAULT_TEAM_TARGETS);

  const [activeSalesRepCount, setActiveSalesRepCount] = useState<number>(
    () =>
      filterAndSortReachSalesRepsPure(CANONICAL_NEXUS_EMPLOYEES, {
        includeOwners: false,
      }).length || 2
  );
  const [activeWorkspaceView, setActiveWorkspaceView] = useState<
    'OUTREACH' | 'ANALYTICS'
  >('OUTREACH');
  const [analyticsDatePreset, setAnalyticsDatePreset] =
    useState<AnalyticsDatePreset>('LAST_30_DAYS');
  const [customStartDate, setCustomStartDate] = useState<string>(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [customEndDate, setCustomEndDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );

  const analyticsDateFilter = useMemo<AnalyticsDateFilter>(
    () => ({
      preset: analyticsDatePreset,
      customStartDate,
      customEndDate,
    }),
    [analyticsDatePreset, customStartDate, customEndDate]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkspaceFilterTab>('FRESH');
  const [interestedSubFilter, setInterestedSubFilter] =
    useState<InterestedSubFilter>('ALL');
  const [activeBatchIdFilter, setActiveBatchIdFilter] = useState<string | null>(
    null
  );
  const [selectedRepEmailFilter, setSelectedRepEmailFilter] =
    useState<string>('ALL');
  const [selectedLead, setSelectedLead] = useState<LeadRecord | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isExcelModalOpen, setIsExcelModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  // Load initial state, server-side status counts (getCountFromServer), automatic new-day sweep & batch division, and bounded leads query
  useEffect(() => {
    setLeads(loadLocalLeads());
    setBatches(loadLocalBatches());
    setDailyStats(loadLocalDailyStats());
    setTeamTargets(loadLocalTeamTargets());
    void fetchTeamTargetsFromFirestore().then((t) => setTeamTargets(t));
    void purgeLegacySeededMockLeadsFromFirestore();
    void fetchDailyStatsFromFirestore().then((st) => setDailyStats(st));
    void fetchOwnerMetricCountsFromServer().then((counts) => {
      if (counts) {
        setServerOwnerMetrics(counts);
      }
    });
    void getActiveSalesReps()
      .then((reps) => {
        if (Array.isArray(reps) && reps.length > 0) {
          setActiveSalesRepCount(reps.length);
        }
      })
      .catch(() => {});

    // Automatically sweep stale prior-day batches/uncalled FRESH leads and generate today's equal batches on mount
    const todayIst = getTodayIstDateString();
    void autoSweepStaleBatchesAndGenerateTodayBatchesFirestore(
      todayIst,
      new Date()
    ).then((res) => {
      if (!res) return;
      if (res.activeRepCount > 0) {
        setActiveSalesRepCount(res.activeRepCount);
      }
      const cleanTodayBatches = res.todayBatches
        .filter((b) => !isLegacyMockBatch(b))
        .sort((a, b) => a.batchNumber - b.batchNumber);
      setBatches(cleanTodayBatches);
      saveLocalBatches(cleanTodayBatches);

      if (res.freshLeads.length > 0) {
        setLeads((prev) => {
          const map = new Map<string, LeadRecord>();
          for (const l of prev) {
            if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
          }
          for (const fl of res.freshLeads) {
            if (!isLegacyMockOrSyntheticLead(fl)) map.set(fl.id, fl);
          }
          const merged = Array.from(map.values());
          saveLocalLeads(merged);
          return merged;
        });
      }
      void fetchOwnerMetricCountsFromServer().then((counts) => {
        if (counts) setServerOwnerMetrics(counts);
      });
    });

    // Do NOT attach an unbounded onSnapshot(collection(db, 'leads')) listener!
    // Unbounded listeners download all 4,740+ leads on every write and cause post-upload UI lag.
    // Instead, active tab/batch leads are fetched via bounded limit(50) queries below.

    let unsubDailyStats: (() => void) | undefined;
    try {
      unsubDailyStats = onSnapshot(
        collection(db, 'daily_stats'),
        (snap) => {
          if (snap.empty) return;
          const remoteStats = snap.docs.map((d) => d.data() as DailyRepStatRecord);
          setDailyStats(remoteStats);
          saveLocalDailyStats(remoteStats);
        },
        () => {}
      );
    } catch {
      // Ignore offline error
    }

    let unsubBatches: (() => void) | undefined;
    try {
      unsubBatches = onSnapshot(
        collection(db, 'batches'),
        (snap) => {
          const remoteBatches = snap.docs
            .map((d) => d.data() as BatchRecord)
            .filter((b) => !isLegacyMockBatch(b))
            .sort((a, b) => a.batchNumber - b.batchNumber);
          setBatches(remoteBatches);
          saveLocalBatches(remoteBatches);
        },
        () => {
          // Graceful fallback in preview rules
        }
      );
    } catch {
      // Ignore offline error
    }

    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'solarithm_reach_batches_v1') {
        setBatches(loadLocalBatches());
      } else if (e.key === 'solarithm_reach_leads_v1') {
        setLeads(loadLocalLeads());
      } else if (e.key === 'solarithm_reach_daily_stats_v1') {
        setDailyStats(loadLocalDailyStats());
      } else if (e.key === 'solarithm_reach_team_targets_v1') {
        setTeamTargets(loadLocalTeamTargets());
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      unsubDailyStats?.();
      unsubBatches?.();
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updateLeadsState = useCallback((nextLeads: LeadRecord[]) => {
    const cleaned = nextLeads.filter((l) => !isLegacyMockOrSyntheticLead(l));
    setLeads(cleaned);
    saveLocalLeads(cleaned);
  }, []);

  const updateBatchesState = useCallback((nextBatches: BatchRecord[]) => {
    const cleaned = nextBatches.filter((b) => !isLegacyMockBatch(b));
    setBatches(cleaned);
    saveLocalBatches(cleaned);
  }, []);

  const handleSyncBatchesFromFirestore = useCallback(
    (remoteBatches: DailyBatchDocument[]) => {
      const cleaned = remoteBatches
        .filter((b) => !isLegacyMockBatch(b))
        .sort((a, b) => a.batchNumber - b.batchNumber);
      setBatches(cleaned);
      saveLocalBatches(cleaned);
    },
    []
  );

  // Automatic Duplicate Claim Cleanup on Load / Sync:
  // If any single Sales Rep has > 1 batch claimed (`IN_PROGRESS`) for today, keeps the batch with highest
  // `completedCallsCount` (or earliest `batchNumber`, i.e., `Batch #1`) and resets extra batches (`Batch #2`) to `AVAILABLE`.
  useEffect(() => {
    const todayDate = getTodayIstDateString();
    const sanitized = autoSanitizeDuplicateClaimedBatchesPure(
      batches,
      leads,
      todayDate
    );
    if (!sanitized.changed) return;

    updateBatchesState(sanitized.updatedBatches);
    if (sanitized.unassignedLeads.length > 0) {
      updateLeadsState(sanitized.updatedLeads);
    }
    if (sanitized.releasedBatches.length > 0) {
      void persistDailyBatchesToFirestore(sanitized.releasedBatches);
    }
    if (sanitized.unassignedLeads.length > 0) {
      void syncLeadsToFirestore(sanitized.unassignedLeads);
    }
  }, [batches, leads, updateBatchesState, updateLeadsState]);

  // Automatic New-Day Sweep, Duplicate/Extra Batch Cleanup & Equal 1..N Batch Division:
  // Triggers whenever unassigned FRESH leads exist, OR prior-day uncalled FRESH leads/batches need sweeping,
  // OR extra/duplicate/closed batches (`batchNumber > N` or `CLOSED`) exist for TODAY,
  // OR 0 batches exist for TODAY while Fresh leads are present in the pool.
  useEffect(() => {
    const todayDate = getTodayIstDateString();
    const repCountFromUsers = authorizedUsers.filter(
      (u) =>
        u.status === 'active' &&
        (String(u.role).toUpperCase() === 'SALES' ||
          String(u.role).toUpperCase() === 'LEAD_SALES')
    ).length;
    const effectiveRepCount = Math.max(
      1,
      activeSalesRepCount || repCountFromUsers || 3
    );

    const hasUnassignedFresh = leads.some(
      (l) => (l.status === 'FRESH' || l.status === 'REVIVED_FRESH') && !l.assignedBatchId
    );
    const hasStaleAssignedFresh = leads.some(
      (l) =>
        (l.status === 'FRESH' || l.status === 'REVIVED_FRESH') &&
        Boolean(l.assignedBatchId) &&
        !doesBatchBelongToTodayPure(l.assignedBatchId, todayDate, batches)
    );
    const hasStaleOrExtraBatch = batches.some(
      (b) =>
        b.date !== todayDate ||
        b.status === 'CLOSED' ||
        b.batchNumber > effectiveRepCount ||
        b.batchNumber < 1
    );
    const todayActiveBatchesCount = batches.filter(
      (b) => b.date === todayDate && b.status !== 'CLOSED'
    ).length;
    const hasZeroTodayBatchesWithFreshPool =
      todayActiveBatchesCount === 0 &&
      leads.some((l) => l.status === 'FRESH' || l.status === 'REVIVED_FRESH');

    if (
      !hasUnassignedFresh &&
      !hasStaleAssignedFresh &&
      !hasStaleOrExtraBatch &&
      !hasZeroTodayBatchesWithFreshPool
    ) {
      return;
    }

    const nowIso = new Date().toISOString();
    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      leads,
      batches,
      effectiveRepCount,
      todayDate,
      nowIso
    );

    if (partitioned.changed) {
      updateBatchesState(partitioned.todayBatches);
      updateLeadsState(partitioned.updatedLeads);
      if (partitioned.todayBatches.length > 0) {
        void persistDailyBatchesToFirestore(partitioned.todayBatches);
      }
      const newBatchIds = new Set(partitioned.todayBatches.map((nb) => nb.batchId));
      const releasedIds = new Set(partitioned.releasedLeads.map((rl) => rl.id));
      const leadsToSync = partitioned.updatedLeads.filter(
        (l) =>
          (l.assignedBatchId && newBatchIds.has(l.assignedBatchId)) ||
          releasedIds.has(l.id)
      );
      if (leadsToSync.length > 0) {
        void syncLeadsToFirestore(leadsToSync);
      }
    }
  }, [
    leads,
    batches,
    activeSalesRepCount,
    authorizedUsers,
    updateBatchesState,
    updateLeadsState,
  ]);

  // Task 2: Atomic Morning Batch Claim & Lock Mechanism
  const handleClaimBatch = async (
    batchId: string,
    rep: { email: string; name: string }
  ) => {
    const claimedAtIso = new Date().toISOString();
    let transition;
    try {
      transition = claimBatchStateTransition(
        batchId,
        rep,
        batches,
        leads,
        claimedAtIso
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to claim batch.');
      return;
    }

    const hasAssignedLeads = transition.updatedLeads.some(
      (l) => l.assignedBatchId === batchId
    );
    const finalLeads = hasAssignedLeads
      ? transition.updatedLeads
      : transition.updatedLeads.map((l) => {
          if (l.status === 'FRESH' && !l.assignedRepEmail) {
            return {
              ...l,
              assignedBatchId: batchId,
              assignedRepEmail: rep.email,
              assignedRepName: rep.name,
              updatedAt: claimedAtIso,
            };
          }
          return l;
        });

    updateBatchesState(transition.updatedBatches);
    updateLeadsState(finalLeads);

    if (
      user &&
      areRepEmailsEquivalentPure(user.email, rep.email, user.name, rep.name)
    ) {
      setActiveBatchIdFilter(batchId);
    }

    await executeFirestoreBatchClaim(
      batchId,
      rep,
      transition.updatedBatch.leadIds || [],
      claimedAtIso,
      transition.updatedBatch
    );

    showToast(
      `Batch #${transition.updatedBatch.batchNumber || 1} claimed by ${rep.name.split(' (')[0]}`
    );
  };

  // Owner 1-Click Manual Release Batch Control
  const handleReleaseBatch = async (batchId: string) => {
    const releasedResult = releaseBatchClaimPure(batchId, batches, leads);
    if (!releasedResult.releasedBatch) return;

    updateBatchesState(releasedResult.updatedBatches);
    updateLeadsState(releasedResult.updatedLeads);
    if (activeBatchIdFilter === batchId) {
      setActiveBatchIdFilter(null);
    }

    await executeFirestoreBatchRelease(
      batchId,
      releasedResult.releasedBatch,
      releasedResult.unassignedLeads.map((l) => l.id)
    );

    showToast(
      `Batch #${releasedResult.releasedBatch.batchNumber} released back to Available`
    );
  };

  // Owner "Wipe All Data" Testing Utility handler
  const handleWipeAllData = useCallback(() => {
    clearAllReachLocalStorageCaches();
    setLeads([]);
    setBatches([]);
    setDailyStats([]);
    setServerOwnerMetrics({
      totalFreshPool: 0,
      proposalsShared: 0,
      interestedOwnerQueue: 0,
      futureRequirement: 0,
      callsDialedToday: 0,
      deadClosedOut: 0,
      totalAllLeads: 0,
    });
    setActiveBatchIdFilter(null);
    setSelectedLead(null);
    saveLocalLeads([]);
    saveLocalBatches([]);
    saveLocalDailyStats([]);
    void fetchOwnerMetricCountsFromServer().then((counts) => {
      if (counts) setServerOwnerMetrics(counts);
    });
    showToast('All leads, batches, and stats wiped from Reach DB');
  }, [showToast]);

  // Case A: Quick Inline Company Name Fix Without Logging a Call
  const handleUpdateCompanyName = (leadId: string, newCompanyName: string) => {
    const trimmed = String(newCompanyName || '').trim();
    if (!trimmed) return;
    const nowIso = new Date().toISOString();

    let updatedTargetLead: LeadRecord | null = null;
    const nextLeads = leads.map((lead) => {
      if (lead.id !== leadId) return lead;
      updatedTargetLead = applyManualCompanyNameEditPure(lead, trimmed, nowIso);
      return updatedTargetLead;
    });

    updateLeadsState(nextLeads);
    if (updatedTargetLead) {
      const targetSnapshot: LeadRecord = updatedTargetLead;
      setSelectedLead((prev) =>
        prev && prev.id === leadId ? targetSnapshot : prev
      );
      void syncLeadsToFirestore([targetSnapshot]);
      showToast(`Company name updated to "${targetSnapshot.companyName}"`);
    }
  };

  // Save Call Disposition & Load Next Lead from CallingTable Drawer
  const handleSaveCallUpdate = ({
    leadId,
    newStatus,
    ownerSubStatus,
    callDate,
    notes,
    loadNext,
    editedCompanyName,
  }: {
    leadId: string;
    newStatus: LeadStatus;
    ownerSubStatus?: OwnerSubStatus;
    callDate: string;
    notes: string;
    loadNext: boolean;
    editedCompanyName?: string;
  }) => {
    if (!user) return;
    const nowIso = new Date().toISOString();

    let updatedTargetLead: LeadRecord | null = null;
    let claimedBatchToIncrement: string | null = null;

    const nextLeads = leads.map((lead) => {
      if (lead.id !== leadId) return lead;

      const previousStatus = lead.status;
      const isFirstTransitionFromFresh =
        (previousStatus === 'FRESH' || previousStatus === 'REVIVED_FRESH') &&
        newStatus !== 'FRESH' &&
        newStatus !== 'REVIVED_FRESH' &&
        ownerSubStatus === undefined;

      // Increment Batch & Rep Daily Call Counters ONLY on First Transition Away from FRESH
      if (isFirstTransitionFromFresh && lead.assignedBatchId) {
        claimedBatchToIncrement = lead.assignedBatchId;
      }

      updatedTargetLead = applyCallDispositionUpdatePure(lead, {
        newStatus,
        ownerSubStatus,
        callDate,
        notes,
        editedCompanyName,
        actorUser: user,
        nowIso,
      });

      return updatedTargetLead;
    });

    updateLeadsState(nextLeads);
    if (updatedTargetLead) {
      void syncLeadsToFirestore([updatedTargetLead]);
      void syncDailyStatsToFirestore(nextLeads).then((st) => setDailyStats(st));
      void fetchOwnerMetricCountsFromServer().then((counts) => {
        if (counts) setServerOwnerMetrics(counts);
      });
    }

    if (claimedBatchToIncrement) {
      let updatedBatchDoc: BatchRecord | null = null;
      const nextBatches = batches.map((b) => {
        if (b.batchId !== claimedBatchToIncrement) return b;
        const nextCompleted = (b.completedCallsCount || 0) + 1;
        const currentRemaining =
          typeof b.remainingLeads === 'number'
            ? b.remainingLeads
            : Math.max(
                0,
                (b.totalLeads || b.totalLeadsAssigned || 0) -
                  (b.completedCallsCount || 0)
              );
        const nextRemaining = Math.max(0, currentRemaining - 1);
        const nextLeadIds = Array.isArray(b.leadIds)
          ? b.leadIds.filter((id) => id !== leadId)
          : b.leadIds;
        updatedBatchDoc = {
          ...b,
          completedCallsCount: nextCompleted,
          remainingLeads: nextRemaining,
          leadIds: nextLeadIds,
        };
        return updatedBatchDoc;
      });
      updateBatchesState(nextBatches);
      if (updatedBatchDoc) {
        void persistDailyBatchToFirestore(updatedBatchDoc);
      }
    }

    if (loadNext) {
      const currentIdx = displayedLeads.findIndex((l) => l.id === leadId);
      const nextCandidate =
        currentIdx >= 0 && currentIdx + 1 < displayedLeads.length
          ? displayedLeads[currentIdx + 1]
          : null;
      setSelectedLead(nextCandidate);
    } else {
      setSelectedLead(null);
    }

    showToast(`Saved disposition (${newStatus})`);
  };

  const handleCreateSingleLead = (newLead: LeadRecord, isOverwrite = false) => {
    const next = isOverwrite
      ? leads.map((l) => (l.id === newLead.id ? newLead : l))
      : [newLead, ...leads];
    updateLeadsState(next);
    void syncLeadsToFirestore([newLead]);
    void syncDailyStatsToFirestore(next).then((st) => setDailyStats(st));
    void fetchOwnerMetricCountsFromServer().then((counts) => {
      if (counts) setServerOwnerMetrics(counts);
    });
    showToast(
      isOverwrite
        ? `Updated ${newLead.companyName}`
        : `Added ${newLead.companyName}`
    );
  };

  const handleCommitExcelIngestion = (
    newLeads: LeadRecord[],
    updatedLeads: LeadRecord[]
  ) => {
    const updateMap = new Map(updatedLeads.map((u) => [u.id, u]));
    const mergedExisting = leads.map((ex) => updateMap.get(ex.id) || ex);
    const combined = [...newLeads, ...mergedExisting];

    const todayDate = getTodayIstDateString();
    const nowIso = new Date().toISOString();
    const repCountFromUsers = authorizedUsers.filter(
      (u) =>
        u.status === 'active' &&
        (String(u.role).toUpperCase() === 'SALES' ||
          String(u.role).toUpperCase() === 'LEAD_SALES')
    ).length;
    const effectiveRepCount = Math.max(
      1,
      activeSalesRepCount || repCountFromUsers || 2
    );

    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      combined,
      batches,
      effectiveRepCount,
      todayDate,
      nowIso
    );

    updateBatchesState(partitioned.updatedBatches);
    updateLeadsState(partitioned.updatedLeads);

    // If historical leads have past call dates, ensure analytics date preset includes them immediately
    const allImported = [...newLeads, ...updatedLeads];
    const hasHistoricalCallDates = allImported.some(
      (l) => l.lastCalledDate && l.lastCalledDate.slice(0, 10) < todayDate
    );
    if (hasHistoricalCallDates) {
      setAnalyticsDatePreset('ALL_TIME');
    }

    showToast(
      partitioned.newBatches.length > 0
        ? `Imported ${newLeads.length} fresh & ${updatedLeads.length} updated leads · Auto-divided into ${partitioned.newBatches.length} equal rep batches`
        : `Imported ${newLeads.length} fresh leads and updated ${updatedLeads.length} existing leads`
    );

    // Defer background Firestore syncs to next tick so modal close & table render are 100% instant
    setTimeout(() => {
      if (partitioned.newBatches.length > 0) {
        void persistDailyBatchesToFirestore(partitioned.newBatches);
      }

      const newBatchIds = new Set(partitioned.newBatches.map((nb) => nb.batchId));
      const partitionedChangedLeads = partitioned.updatedLeads.filter(
        (l) => l.assignedBatchId && newBatchIds.has(l.assignedBatchId)
      );

      if (partitionedChangedLeads.length > 0) {
        void syncLeadsToFirestore(partitionedChangedLeads).then(() => {
          void fetchOwnerMetricCountsFromServer().then((counts) => {
            if (counts) setServerOwnerMetrics(counts);
          });
        });
      } else {
        void fetchOwnerMetricCountsFromServer().then((counts) => {
          if (counts) setServerOwnerMetrics(counts);
        });
      }
      void syncDailyStatsToFirestore(partitioned.updatedLeads).then((st) =>
        setDailyStats(st)
      );
    }, 0);
  };

  const ownerMetrics = useMemo(() => {
    const computed = computeOwnerMetricStripPure(leads, authorizedUsers);
    if (!serverOwnerMetrics) return computed;
    return {
      totalFreshPool: Math.max(
        computed.totalFreshPool,
        serverOwnerMetrics.totalFreshPool
      ),
      proposalsShared: Math.max(
        computed.proposalsShared,
        serverOwnerMetrics.proposalsShared
      ),
      interestedOwnerQueue: Math.max(
        computed.interestedOwnerQueue,
        serverOwnerMetrics.interestedOwnerQueue
      ),
      futureRequirement: Math.max(
        computed.futureRequirement,
        serverOwnerMetrics.futureRequirement
      ),
      callsDialedToday: Math.max(
        computed.callsDialedToday,
        serverOwnerMetrics.callsDialedToday
      ),
      deadClosedOut: Math.max(
        computed.deadClosedOut,
        serverOwnerMetrics.deadClosedOut
      ),
      totalAllLeads: Math.max(
        computed.totalAllLeads ?? leads.length,
        serverOwnerMetrics.totalAllLeads ?? 0
      ),
    };
  }, [leads, authorizedUsers, serverOwnerMetrics]);

  const salesMetrics = useMemo(
    () =>
      user
        ? computeSalesRepMetricStripPure(leads, batches, user.email)
        : {
            batchLeadsRemaining: 0,
            myCallsToday: 0,
            proposalsPendingFollowUp: 0,
            futureRequirementsDue: 0,
          },
    [leads, batches, user]
  );

  const isOwner = Boolean(
    user &&
      (user.isOwnerTier ||
        user.role === 'OWNER' ||
        user.role === 'ADMIN' ||
        (user.role as string) === 'owner')
  );

  // Strict Batch-Only & Historical Follow-Up Tab Query Engine + 30-Second Live IST Midnight Rollover Watcher
  const [todayIstDate, setTodayIstDate] = useState(() => getTodayIstDateString());

  useEffect(() => {
    const interval = setInterval(() => {
      const currentIst = getTodayIstDateString();
      if (currentIst !== todayIstDate) {
        setTodayIstDate(currentIst);
        setActiveBatchIdFilter(null);
        void autoSweepStaleBatchesAndGenerateTodayBatchesFirestore(
          currentIst,
          new Date()
        ).then((res) => {
          if (!res) return;
          if (res.activeRepCount > 0) {
            setActiveSalesRepCount(res.activeRepCount);
          }
          const cleanToday = res.todayBatches
            .filter((b) => !isLegacyMockBatch(b))
            .sort((a, b) => a.batchNumber - b.batchNumber);
          setBatches(cleanToday);
          saveLocalBatches(cleanToday);
          if (res.freshLeads.length > 0) {
            setLeads((prev) => {
              const map = new Map<string, LeadRecord>();
              for (const l of prev) {
                if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
              }
              for (const fl of res.freshLeads) {
                if (!isLegacyMockOrSyntheticLead(fl)) map.set(fl.id, fl);
              }
              const merged = Array.from(map.values());
              saveLocalLeads(merged);
              return merged;
            });
          }
          void fetchOwnerMetricCountsFromServer().then((counts) => {
            if (counts) setServerOwnerMetrics(counts);
          });
        });
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [todayIstDate]);

  const workspaceFilterResult = useMemo(() => {
    if (!user) {
      return {
        filteredLeads: [],
        todayActiveBatches: [],
        repClaimedTodayBatch: null,
        emptyStateMessage: 'No leads in current view.',
      };
    }
    return filterAndSortWorkspaceTableLeadsPure({
      leads,
      batches,
      tab: statusFilter,
      isOwner,
      userEmail: user.email,
      todayDate: todayIstDate,
      selectedBatchIdFilter: activeBatchIdFilter,
      selectedRepEmailFilter,
      interestedSubFilter,
      searchQuery,
    });
  }, [
    leads,
    batches,
    statusFilter,
    isOwner,
    user,
    todayIstDate,
    activeBatchIdFilter,
    selectedRepEmailFilter,
    interestedSubFilter,
    searchQuery,
  ]);

  const displayedLeads = workspaceFilterResult.filteredLeads;
  const todayActiveBatches = workspaceFilterResult.todayActiveBatches;
  const repClaimedBatchId = workspaceFilterResult.repClaimedTodayBatch?.batchId || null;
  const firstTodayBatchId = todayActiveBatches[0]?.batchId || null;

  // Bounded 50-Row Single-Field Firestore Query for Active Tab / Active Batch
  useEffect(() => {
    let isMounted = true;
    const runBoundedQuery = async () => {
      try {
        if (statusFilter === 'FRESH') {
          const targetBatchId = isOwner
            ? activeBatchIdFilter && activeBatchIdFilter !== 'ALL'
              ? activeBatchIdFilter
              : firstTodayBatchId
            : repClaimedBatchId;
          if (!targetBatchId) return;

          const snap = await Promise.race([
            getDocs(
              query(
                collection(db, 'leads'),
                where('assignedBatchId', '==', targetBatchId),
                limit(50)
              )
            ),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
          ]);
          if (!isMounted || !snap || snap.empty) return;
          const fetched: LeadRecord[] = [];
          snap.forEach((d) => {
            const record = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
            if (!isLegacyMockOrSyntheticLead(record)) {
              fetched.push(record);
            }
          });
          if (fetched.length > 0) {
            setLeads((prev) => {
              const map = new Map<string, LeadRecord>();
              for (const l of prev) {
                if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
              }
              for (const fl of fetched) {
                map.set(fl.id, fl);
              }
              return Array.from(map.values());
            });
          }
        } else {
          const snap = await Promise.race([
            getDocs(
              query(
                collection(db, 'leads'),
                where('status', '==', statusFilter),
                limit(50)
              )
            ),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
          ]);
          if (!isMounted || !snap || snap.empty) return;
          const fetched: LeadRecord[] = [];
          snap.forEach((d) => {
            const record = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
            if (!isLegacyMockOrSyntheticLead(record)) {
              fetched.push(record);
            }
          });
          if (fetched.length > 0) {
            setLeads((prev) => {
              const map = new Map<string, LeadRecord>();
              for (const l of prev) {
                if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
              }
              for (const fl of fetched) {
                map.set(fl.id, fl);
              }
              return Array.from(map.values());
            });
          }
        }
      } catch {
        // Non-blocking fallback to in-memory state
      }
    };
    void runBoundedQuery();
    return () => {
      isMounted = false;
    };
  }, [
    statusFilter,
    isOwner,
    activeBatchIdFilter,
    firstTodayBatchId,
    repClaimedBatchId,
  ]);

  // Rep options for Owner's Historical / Queue filter dropdown
  const repFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of authorizedUsers) {
      const roleUpper = String(u.role || '').toUpperCase();
      if (roleUpper === 'SALES' || roleUpper === 'LEAD_SALES') {
        map.set(u.email.toLowerCase().trim(), u.name.split(' (')[0].trim());
      }
    }
    for (const l of leads) {
      if (l.assignedRepEmail) {
        const em = l.assignedRepEmail.toLowerCase().trim();
        if (!map.has(em)) {
          map.set(
            em,
            (l.assignedRepName || l.assignedRepEmail).split(' (')[0].trim()
          );
        }
      }
    }
    return Array.from(map.entries()).map(([email, name]) => ({ email, name }));
  }, [authorizedUsers, leads]);

  // Formatted showing counter capped at 50 rows per page
  const showingCounterLabel = useMemo(() => {
    const total = displayedLeads.length;
    if (total === 0) return 'Showing 0 leads';
    if (total <= CALLING_TABLE_PAGE_SIZE) {
      return `Showing ${total.toLocaleString()} lead${total === 1 ? '' : 's'}`;
    }
    return `Showing 1–${CALLING_TABLE_PAGE_SIZE} of ${total.toLocaleString()} leads`;
  }, [displayedLeads.length]);

  const handleSelectMetricStatusFilter = useCallback((rawStatus: string) => {
    if (
      rawStatus === 'PROPOSAL_SHARED' ||
      rawStatus === 'FUTURE_REQUIREMENT' ||
      rawStatus === 'INTERESTED'
    ) {
      setStatusFilter(rawStatus);
    } else {
      setStatusFilter('FRESH');
    }
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0E0F11] text-neutral-400 flex items-center justify-center text-xs font-mono">
        Loading workspace...
      </div>
    );
  }

  if (!user) {
    return <LoginModal />;
  }

  return (
    <div
      data-testid="zerodha-dashboard-layout"
      className="min-h-screen bg-slate-50 dark:bg-[#090B0E] text-slate-900 dark:text-slate-100 flex flex-col"
    >
      {/* 2. Strict Role-Based Header Isolation (`components/layout/Header.tsx`) */}
      <Header
        leads={leads}
        batchesCount={batches.length}
        teamTargets={teamTargets}
        dailyCallsCountOverride={isOwner ? undefined : salesMetrics.myCallsToday}
        onOpenExcelModal={() => setIsExcelModalOpen(true)}
        onOpenAddLeadModal={() => setIsAddModalOpen(true)}
        onWipeAllData={handleWipeAllData}
      />

      {/* 1. Minimal Workspace View Switcher & Global Date Range Filter Bar (`components/dashboard/WorkspaceNav.tsx`) */}
      <WorkspaceNav
        activeWorkspaceView={activeWorkspaceView}
        onChangeWorkspaceView={setActiveWorkspaceView}
        analyticsDatePreset={analyticsDatePreset}
        onChangeDatePreset={setAnalyticsDatePreset}
        customStartDate={customStartDate}
        onChangeCustomStartDate={setCustomStartDate}
        customEndDate={customEndDate}
        onChangeCustomEndDate={setCustomEndDate}
      />

      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-40 px-3.5 py-2 rounded-xl bg-slate-900 dark:bg-[#161B26] border border-amber-400/40 text-white text-xs font-medium shadow-xl flex items-center gap-2"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-3 sm:px-6 py-4 sm:py-5 space-y-4 sm:space-y-5">
        {activeWorkspaceView === 'ANALYTICS' ? (
          isOwner ? (
            <OwnerAnalyticsView
              leads={leads}
              dateFilter={analyticsDateFilter}
              dailyStats={dailyStats}
            />
          ) : (
            <SalesRepAnalyticsView
              leads={leads}
              currentUser={user}
              dateFilter={analyticsDateFilter}
              dailyStats={dailyStats}
            />
          )
        ) : (
          <>
            {/* 2. Adaptive Status Metric Strip (`components/dashboard/MetricCards.tsx`) */}
            <MetricCards
              isOwner={isOwner}
              ownerMetrics={ownerMetrics}
              salesMetrics={salesMetrics}
              onSelectStatusFilter={handleSelectMetricStatusFilter}
            />

            {/* Phase 3: Automatic Equal Batch Division, Morning Rep Lock & 100% Hands-Free Daily Reset Engine */}
            <DailyBatchSelector
              currentUser={user}
              authorizedUsers={authorizedUsers}
              batches={batches}
              leads={leads}
              activeBatchIdFilter={activeBatchIdFilter}
              onSelectActiveBatchWorkspace={(bId) => {
                setActiveBatchIdFilter(bId);
                if (bId) {
                  setStatusFilter('FRESH');
                }
              }}
              onClaimBatch={handleClaimBatch}
              onReleaseBatch={handleReleaseBatch}
              onSyncBatchesFromFirestore={handleSyncBatchesFromFirestore}
            />

            {/* 3. Consolidated 4-Tab Bar + Batch/Rep Filters + 50-Row Paginated Lead Calling Table */}
            <section aria-label="Calling Queue Section" className="space-y-3">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 sm:gap-3">
                {/* Horizontally Scrollable Consolidated Status Filter Tabs */}
                <div
                  data-testid="calling-status-filter-tabs"
                  className="flex items-center gap-2 overflow-x-auto scrollbar-none whitespace-nowrap pb-1 sm:pb-0 -mx-1 px-1"
                >
                  {/* Tab 1: Today's Batch / Fresh (Default active tab — replaces All Leads & Fresh) */}
                  <button
                    type="button"
                    data-testid="tab-todays-batch-fresh"
                    onClick={() => setStatusFilter('FRESH')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'FRESH'
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Today&apos;s Batch / Fresh
                  </button>

                  {/* Tab 2: Proposals Shared */}
                  <button
                    type="button"
                    data-testid="tab-proposals-shared"
                    onClick={() => setStatusFilter('PROPOSAL_SHARED')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'PROPOSAL_SHARED'
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Proposals Shared
                  </button>

                  {/* Tab 3: Future Requirement */}
                  <button
                    type="button"
                    data-testid="tab-future-requirement"
                    onClick={() => setStatusFilter('FUTURE_REQUIREMENT')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'FUTURE_REQUIREMENT'
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Future Requirement
                  </button>

                  {/* Tab 4: Interested (Owner Queue) — Visible to Owner tier and as read-only handover status for Sales Reps */}
                  <button
                    type="button"
                    data-testid="owner-interested-filter-btn"
                    onClick={() => setStatusFilter('INTERESTED')}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'INTERESTED'
                        ? 'bg-[#E5B842] text-slate-950 border-[#E5B842]'
                        : 'bg-[#E5B842]/10 text-amber-700 dark:text-[#E5B842] border-[#E5B842]/40'
                    }`}
                  >
                    Interested (Owner Queue)
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto justify-between lg:justify-end">
                  {/* Owner Compact Batch Selector for Tab 1 (Today's Batch / Fresh) */}
                  {isOwner && statusFilter === 'FRESH' && (
                    <select
                      aria-label="Filter Today's Batches"
                      data-testid="owner-today-batch-filter"
                      value={activeBatchIdFilter || 'ALL'}
                      onChange={(e) =>
                        setActiveBatchIdFilter(
                          e.target.value === 'ALL' ? null : e.target.value
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:border-amber-400 cursor-pointer"
                    >
                      <option value="ALL">All Today&apos;s Batches</option>
                      {todayActiveBatches.map((b) => {
                        const repLabel = b.claimedByName
                          ? b.claimedByName.split(' (')[0].trim()
                          : 'Unclaimed';
                        return (
                          <option key={b.batchId} value={b.batchId}>
                            Batch #{b.batchNumber} - {repLabel}
                          </option>
                        );
                      })}
                    </select>
                  )}

                  {/* Owner Compact Sales Rep Selector for Historical / Follow-up Tabs */}
                  {isOwner && statusFilter !== 'FRESH' && (
                    <select
                      aria-label="Filter by Sales Rep"
                      data-testid="owner-rep-filter-select"
                      value={selectedRepEmailFilter}
                      onChange={(e) => setSelectedRepEmailFilter(e.target.value)}
                      className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:border-amber-400 cursor-pointer"
                    >
                      <option value="ALL">All Sales Reps</option>
                      {repFilterOptions.map((rep) => (
                        <option key={rep.email} value={rep.email}>
                          {rep.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <span
                    data-testid="showing-leads-counter"
                    className="text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap"
                  >
                    {showingCounterLabel}
                  </span>

                  <div className="relative w-full sm:w-60">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search company, phone, city..."
                      className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                    />
                  </div>
                </div>
              </div>

              {/* Compact Sub-Filter Pills inside the Interested (Owner Queue) tab */}
              {statusFilter === 'INTERESTED' && (
                <div
                  data-testid="interested-subfilter-bar"
                  className="flex items-center gap-1.5 flex-wrap pt-0.5"
                >
                  {(
                    [
                      { key: 'ALL', label: 'All Interested' },
                      { key: 'NEW_HANDOVER', label: 'New Handover' },
                      {
                        key: 'OWNER_RETRY',
                        label: "Owner Retry (Didn't Receive)",
                      },
                      {
                        key: 'QUOTE_NEGOTIATION',
                        label: 'Quote / Negotiation',
                      },
                    ] as { key: InterestedSubFilter; label: string }[]
                  ).map((pill) => {
                    const active = interestedSubFilter === pill.key;
                    return (
                      <button
                        key={pill.key}
                        type="button"
                        data-testid={`interested-subfilter-${pill.key}`}
                        onClick={() => setInterestedSubFilter(pill.key)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                          active
                            ? 'bg-[#E5B842]/20 border-[#E5B842] text-amber-800 dark:text-[#E5B842] font-semibold'
                            : 'bg-white dark:bg-[#11141B] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                        }`}
                      >
                        {pill.label}
                      </button>
                    );
                  })}
                </div>
              )}

              <CallingTable
                leads={displayedLeads}
                currentUser={user}
                selectedLead={selectedLead}
                emptyStateMessage={workspaceFilterResult.emptyStateMessage}
                onSelectLead={setSelectedLead}
                onUpdateCompanyName={handleUpdateCompanyName}
                onSaveCallUpdate={handleSaveCallUpdate}
              />
            </section>
          </>
        )}
      </main>

      {/* Single Lead Modal available to both Sales Reps and Owners */}
      <AddLeadModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        existingLeads={leads}
        onCreateLead={handleCreateSingleLead}
        isOwnerTier={isOwner}
        currentUser={user}
      />

      {/* Owner-Only Bulk Excel/CSV Ingestion Modal */}
      {isOwner && (
        <ExcelUploadModal
          isOpen={isExcelModalOpen}
          onClose={() => setIsExcelModalOpen(false)}
          existingLeads={leads}
          currentUser={user}
          onCommitIngestion={handleCommitExcelIngestion}
        />
      )}
    </div>
  );
}
