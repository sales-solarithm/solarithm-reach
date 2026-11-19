'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Search, X } from 'lucide-react';
import {
  collection,
  deleteField,
  doc,
  getDocs,
  getDocsFromServer,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  CloudSyncErrorEvent,
  clearCloudSyncError,
  reachDb as db,
  reportCloudSyncError,
  subscribeToCloudSyncErrors,
} from '@/lib/firebaseDual';
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
import { formatRepName } from '@/lib/utils';
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
  commitCallOutcomeAtomicToFirestore,
  fetchAllBatchesFromServerFirestore,
  fetchAllLeadsFromServerFirestore,
  filterAndSortWorkspaceTableLeadsPure,
  isLegacyMockBatch,
  isLegacyMockOrSyntheticLead,
  purgeLegacySeededMockLeadsFromFirestore,
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
  releaseBatchMetadataOnlyPure,
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
    useState<AnalyticsDatePreset>('ALL_TIME');
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
  const [errorToastMessage, setErrorToastMessage] = useState<string | null>(
    null
  );
  const [cloudSyncError, setCloudSyncError] =
    useState<CloudSyncErrorEvent | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  const showErrorToast = useCallback((msg: string) => {
    setErrorToastMessage(msg);
    setTimeout(() => {
      setErrorToastMessage((prev) => (prev === msg ? null : prev));
    }, 6000);
  }, []);

  useEffect(() => {
    return subscribeToCloudSyncErrors((errEvent) => {
      setCloudSyncError(errEvent);
    });
  }, []);

  // Load initial state directly from live Cloud Firestore server (`getDocsFromServer`),
  // run automatic new-day sweep & batch division, and attach real-time listeners for batches & daily_stats
  useEffect(() => {
    let isMounted = true;
    setTeamTargets(loadLocalTeamTargets());
    void fetchTeamTargetsFromFirestore().then((t) => {
      if (isMounted) setTeamTargets(t);
    });
    void purgeLegacySeededMockLeadsFromFirestore();
    void fetchDailyStatsFromFirestore().then((st) => {
      if (isMounted) setDailyStats(st);
    });
    void fetchOwnerMetricCountsFromServer().then((counts) => {
      if (isMounted && counts) {
        setServerOwnerMetrics(counts);
      }
    });
    void getActiveSalesReps()
      .then((reps) => {
        if (isMounted && Array.isArray(reps) && reps.length > 0) {
          setActiveSalesRepCount(reps.length);
        }
      })
      .catch(() => {});

    // Fetch all leads and batches directly from the live Cloud Firestore server (`reachDb`)
    // so Browser 1 and Browser 2 immediately synchronize from the exact same cloud database
    void Promise.all([
      fetchAllLeadsFromServerFirestore(),
      fetchAllBatchesFromServerFirestore(),
    ]).then(([serverLeads, serverBatches]) => {
      if (!isMounted) return;
      if (serverBatches.length > 0) {
        setBatches(serverBatches);
      }
      if (serverLeads.length > 0) {
        setLeads((prev) => {
          const map = new Map<string, LeadRecord>();
          for (const l of prev) {
            if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
          }
          for (const sl of serverLeads) {
            if (!isLegacyMockOrSyntheticLead(sl)) map.set(sl.id, sl);
          }
          return Array.from(map.values());
        });
      }
    });

    // Automatically sweep stale prior-day batches/uncalled FRESH leads and generate today's equal batches on mount
    const todayIst = getTodayIstDateString();
    void autoSweepStaleBatchesAndGenerateTodayBatchesFirestore(
      todayIst,
      new Date()
    ).then((res) => {
      if (!isMounted || !res) return;
      if (res.activeRepCount > 0) {
        setActiveSalesRepCount(res.activeRepCount);
      }
      const cleanTodayBatches = res.todayBatches
        .filter((b) => !isLegacyMockBatch(b))
        .sort((a, b) => a.batchNumber - b.batchNumber);
      setBatches(cleanTodayBatches);

      if (res.freshLeads.length > 0) {
        setLeads((prev) => {
          const map = new Map<string, LeadRecord>();
          for (const l of prev) {
            if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
          }
          for (const fl of res.freshLeads) {
            if (!isLegacyMockOrSyntheticLead(fl)) map.set(fl.id, fl);
          }
          return Array.from(map.values());
        });
      }
      void fetchOwnerMetricCountsFromServer().then((counts) => {
        if (isMounted && counts) setServerOwnerMetrics(counts);
      });
    });

    let unsubDailyStats: (() => void) | undefined;
    try {
      unsubDailyStats = onSnapshot(
        collection(db, 'daily_stats'),
        (snap) => {
          if (snap.empty) return;
          const remoteStats = snap.docs.map((d) => d.data() as DailyRepStatRecord);
          setDailyStats(remoteStats);
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
            .map((d) => {
              const raw = d.data() as BatchRecord;
              return {
                ...raw,
                batchId: d.id || raw.batchId,
                claimedByEmail:
                  raw.status === 'AVAILABLE' ? null : (raw.claimedByEmail ?? null),
                claimedByName:
                  raw.status === 'AVAILABLE' ? null : (raw.claimedByName ?? null),
                claimedAt:
                  raw.status === 'AVAILABLE' ? null : (raw.claimedAt ?? null),
              } as BatchRecord;
            })
            .filter((b) => !isLegacyMockBatch(b))
            .sort((a, b) => a.batchNumber - b.batchNumber);
          setBatches(remoteBatches);
        },
        () => {}
      );
    } catch {
      // Ignore offline error
    }

    return () => {
      isMounted = false;
      unsubDailyStats?.();
      unsubBatches?.();
    };
  }, []);

  const updateLeadsState = useCallback((nextLeads: LeadRecord[]) => {
    const cleaned = nextLeads.filter((l) => !isLegacyMockOrSyntheticLead(l));
    setLeads(cleaned);
  }, []);

  const updateBatchesState = useCallback((nextBatches: BatchRecord[]) => {
    const cleaned = nextBatches.filter((b) => !isLegacyMockBatch(b));
    setBatches(cleaned);
  }, []);

  const handleSyncBatchesFromFirestore = useCallback(
    (remoteBatches: DailyBatchDocument[]) => {
      const cleaned = remoteBatches
        .filter((b) => !isLegacyMockBatch(b))
        .sort((a, b) => a.batchNumber - b.batchNumber);
      setBatches(cleaned);
    },
    []
  );

  // Automatic Duplicate Claim Cleanup on Load / Sync:
  // If any single Sales Rep has > 1 batch claimed (`IN_PROGRESS`) for today, keeps the batch with highest
  // `completedCallsCount` (or earliest `batchNumber`, i.e., `Batch #1`) and resets extra batches (`Batch #2`) to `AVAILABLE`.
  useEffect(() => {
    const todayDate = getTodayIstDateString();
    const inProgressToday = batches.filter(
      (b) => b.date === todayDate && b.status === 'IN_PROGRESS' && b.claimedByEmail
    );
    if (inProgressToday.length <= 1) return;

    const sanitized = autoSanitizeDuplicateClaimedBatchesPure(
      batches,
      [],
      todayDate
    );
    if (!sanitized.changed || sanitized.releasedBatches.length === 0) return;

    void Promise.all(
      sanitized.releasedBatches.map((rb) =>
        executeFirestoreBatchRelease(rb.batchId)
      )
    )
      .then(() => {
        updateBatchesState(sanitized.updatedBatches);
      })
      .catch(() => {});
  }, [batches, updateBatchesState]);

  // Automatic Batch Generation when 0 active batches exist for TODAY while Fresh leads are present:
  // Never overwrites or re-partitions when today already has active batches (`todayActiveBatchesCount > 0`).
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

    const todayActiveBatchesCount = batches.filter(
      (b) => b.date === todayDate && b.status !== 'CLOSED'
    ).length;
    const hasZeroTodayBatchesWithFreshPool =
      todayActiveBatchesCount === 0 &&
      leads.some((l) => l.status === 'FRESH' || l.status === 'REVIVED_FRESH');

    if (!hasZeroTodayBatchesWithFreshPool) {
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
      `Batch #${transition.updatedBatch.batchNumber || 1} claimed by ${formatRepName(rep.name)}`
    );
  };

  // Owner 1-Click Manual Release Batch Control — Strict Cloud-First Persistence with deleteField()
  const handleReleaseBatch = async (batchId: string) => {
    const nowIso = new Date().toISOString();
    try {
      // 1. Await the cloud write FIRST (do not update local React state until Firestore confirms)
      await updateDoc(doc(db, 'batches', batchId), {
        claimedByEmail: deleteField(),
        claimedByName: deleteField(),
        claimedAt: deleteField(),
        status: 'AVAILABLE',
        updatedAt: nowIso,
      });

      // 2. Only update local UI/state AFTER the cloud confirms the write
      const releasedResult = releaseBatchMetadataOnlyPure(
        batchId,
        batches,
        nowIso
      );
      setBatches(releasedResult.updatedBatches);
      if (activeBatchIdFilter === batchId) {
        setActiveBatchIdFilter(null);
      }

      showToast(
        `Batch #${releasedResult.releasedBatch?.batchNumber || ''} released back to Available`
      );
    } catch (error) {
      // 3. Catch and display the exact reason it failed
      reportCloudSyncError(error, 'Release Batch');
      console.error('Release Batch Failed:', error);
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to release batch in Cloud Firestore.';
      showErrorToast(`Release Batch Failed: ${msg}`);
      throw error;
    }
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

  // Save Call Disposition & Load Next Lead from CallingTable Drawer (<300ms fast non-blocking atomic commit)
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

    // Advance drawer immediately before state/network work so Save & Load Next completes in <300ms
    const currentIdx = displayedLeads.findIndex((l) => l.id === leadId);
    const nextCandidate =
      loadNext && currentIdx >= 0 && currentIdx + 1 < displayedLeads.length
        ? displayedLeads[currentIdx + 1]
        : null;
    setSelectedLead(loadNext ? nextCandidate : null);

    let previousLeadSnapshot: LeadRecord | null = null;
    let updatedTargetLead: LeadRecord | null = null;
    let claimedBatchToIncrement: string | null = null;
    let isFirstTransitionFromFresh = false;

    const nextLeads = leads.map((lead) => {
      if (lead.id !== leadId) return lead;

      previousLeadSnapshot = lead;
      const previousStatus = lead.status;
      isFirstTransitionFromFresh =
        (previousStatus === 'FRESH' || previousStatus === 'REVIVED_FRESH') &&
        newStatus !== 'FRESH' &&
        newStatus !== 'REVIVED_FRESH' &&
        ownerSubStatus === undefined;

      // Increment Batch & Rep Daily Call Counters ONLY on First Transition Away from FRESH
      if (isFirstTransitionFromFresh) {
        claimedBatchToIncrement =
          lead.assignedBatchId ||
          batches.find(
            (b) =>
              b.date === todayIstDate &&
              b.status !== 'CLOSED' &&
              (b.leadIds?.includes(leadId) ||
                (!isOwner &&
                  areRepEmailsEquivalentPure(
                    b.claimedByEmail,
                    user.email,
                    b.claimedByName,
                    user.name
                  )))
          )?.batchId ||
          null;
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

    let updatedBatchDoc: BatchRecord | null = null;
    if (claimedBatchToIncrement) {
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
        updatedBatchDoc = {
          ...b,
          completedCallsCount: nextCompleted,
          remainingLeads: nextRemaining,
        };
        return updatedBatchDoc;
      });
      setBatches(nextBatches);
    }

    setLeads(nextLeads);

    if (updatedTargetLead) {
      void commitCallOutcomeAtomicToFirestore({
        updatedLead: updatedTargetLead,
        existingLead: previousLeadSnapshot,
        rawSelectedStatus: newStatus,
        updatedBatch: updatedBatchDoc,
        actorUser: user,
        isFirstTransitionFromFresh,
      }).catch((err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : 'Firestore failed to save lead status update.';
        showErrorToast(`Failed to save call update (${newStatus}): ${msg}`);
      });
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

    // Commit partitioned batches and all imported/partitioned leads directly to Cloud Firestore (`reachDb`)
    void (async () => {
      try {
        if (partitioned.todayBatches.length > 0) {
          await persistDailyBatchesToFirestore(partitioned.todayBatches);
        }

        const importedIdSet = new Set(allImported.map((l) => l.id));
        const activeTodayBatchIds = new Set(
          partitioned.todayBatches.map((nb) => nb.batchId)
        );
        const leadsToSyncToCloud = partitioned.updatedLeads.filter(
          (l) =>
            importedIdSet.has(l.id) ||
            (l.assignedBatchId && activeTodayBatchIds.has(l.assignedBatchId))
        );

        if (leadsToSyncToCloud.length > 0) {
          await syncLeadsToFirestore(leadsToSyncToCloud);
        }

        const [counts, st] = await Promise.all([
          fetchOwnerMetricCountsFromServer(),
          syncDailyStatsToFirestore(partitioned.updatedLeads),
        ]);
        if (counts) setServerOwnerMetrics(counts);
        setDailyStats(st);
      } catch {
        // Error already surfaced via reportCloudSyncError banner
      }
    })();
  };

  const ownerMetrics = useMemo(() => {
    const computed = computeOwnerMetricStripPure(
      leads,
      authorizedUsers,
      batches,
      analyticsDateFilter
    );
    if (
      leads.length > 0 ||
      analyticsDatePreset !== 'ALL_TIME' ||
      !serverOwnerMetrics
    ) {
      return computed;
    }
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
  }, [
    leads,
    authorizedUsers,
    batches,
    analyticsDateFilter,
    analyticsDatePreset,
    serverOwnerMetrics,
  ]);

  const salesMetrics = useMemo(
    () =>
      user
        ? computeSalesRepMetricStripPure(
            leads,
            batches,
            user.email,
            analyticsDateFilter
          )
        : {
            batchLeadsRemaining: 0,
            myCallsToday: 0,
            proposalsPendingFollowUp: 0,
            futureRequirementsDue: 0,
            interestedCount: 0,
          },
    [leads, batches, user, analyticsDateFilter]
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
          if (res.freshLeads.length > 0) {
            setLeads((prev) => {
              const map = new Map<string, LeadRecord>();
              for (const l of prev) {
                if (!isLegacyMockOrSyntheticLead(l)) map.set(l.id, l);
              }
              for (const fl of res.freshLeads) {
                if (!isLegacyMockOrSyntheticLead(fl)) map.set(fl.id, fl);
              }
              return Array.from(map.values());
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
      dateFilter: analyticsDateFilter,
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
    analyticsDateFilter,
  ]);

  const toCallTodayCount = useMemo(() => {
    if (!user) return 0;
    return filterAndSortWorkspaceTableLeadsPure({
      leads,
      batches,
      tab: 'TO_CALL_TODAY',
      isOwner,
      userEmail: user.email,
      todayDate: todayIstDate,
      selectedRepEmailFilter,
    }).filteredLeads.length;
  }, [leads, batches, isOwner, user, todayIstDate, selectedRepEmailFilter]);

  const displayedLeads = workspaceFilterResult.filteredLeads;
  const todayActiveBatches = workspaceFilterResult.todayActiveBatches;
  const repClaimedBatchId = workspaceFilterResult.repClaimedTodayBatch?.batchId || null;
  const firstTodayBatchId = todayActiveBatches[0]?.batchId || null;

  // Bounded 50-Row Single-Field Server Firestore Query for Active Tab / Active Batch
  useEffect(() => {
    let isMounted = true;
    const runBoundedQuery = async () => {
      try {
        if (statusFilter === 'FRESH' || statusFilter === 'ALL_LEADS') {
          const targetBatchId = isOwner
            ? activeBatchIdFilter && activeBatchIdFilter !== 'ALL'
              ? activeBatchIdFilter
              : firstTodayBatchId
            : repClaimedBatchId;
          if (!targetBatchId) return;

          const q = query(
            collection(db, 'leads'),
            where('assignedBatchId', '==', targetBatchId),
            limit(50)
          );
          const snap = await getDocsFromServer(q).catch(() => getDocs(q));
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
        } else if (statusFilter === 'TO_CALL_TODAY') {
          const [propSnap, futSnap] = await Promise.all([
            getDocsFromServer(
              query(
                collection(db, 'leads'),
                where('status', '==', 'PROPOSAL_SHARED'),
                limit(50)
              )
            ).catch(() =>
              getDocs(
                query(
                  collection(db, 'leads'),
                  where('status', '==', 'PROPOSAL_SHARED'),
                  limit(50)
                )
              )
            ),
            getDocsFromServer(
              query(
                collection(db, 'leads'),
                where('status', '==', 'FUTURE_REQUIREMENT'),
                limit(50)
              )
            ).catch(() =>
              getDocs(
                query(
                  collection(db, 'leads'),
                  where('status', '==', 'FUTURE_REQUIREMENT'),
                  limit(50)
                )
              )
            ),
          ]);
          if (!isMounted) return;
          const fetched: LeadRecord[] = [];
          propSnap?.forEach((d) => {
            const record = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
            if (!isLegacyMockOrSyntheticLead(record)) fetched.push(record);
          });
          futSnap?.forEach((d) => {
            const record = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
            if (!isLegacyMockOrSyntheticLead(record)) fetched.push(record);
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
        } else if (
          statusFilter === 'PROPOSAL_SHARED' ||
          statusFilter === 'FUTURE_REQUIREMENT' ||
          statusFilter === 'INTERESTED'
        ) {
          const q = query(
            collection(db, 'leads'),
            where('status', '==', statusFilter),
            limit(50)
          );
          const snap = await getDocsFromServer(q).catch(() => getDocs(q));
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
        map.set(u.email.toLowerCase().trim(), formatRepName(u.name));
      }
    }
    for (const l of leads) {
      if (l.assignedRepEmail) {
        const em = l.assignedRepEmail.toLowerCase().trim();
        if (!map.has(em)) {
          map.set(
            em,
            formatRepName(l.assignedRepName || l.assignedRepEmail)
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
      rawStatus === 'TO_CALL_TODAY' ||
      rawStatus === 'FRESH' ||
      rawStatus === 'ALL_LEADS' ||
      rawStatus === 'PROPOSAL_SHARED' ||
      rawStatus === 'FUTURE_REQUIREMENT' ||
      rawStatus === 'INTERESTED' ||
      rawStatus === 'CALLS_DIALED_TODAY' ||
      rawStatus === 'DEAD_CLOSED_OUT'
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

      {errorToastMessage && (
        <div
          role="alert"
          data-testid="error-toast-banner"
          className="fixed bottom-16 right-5 z-50 px-3.5 py-2.5 rounded-xl bg-red-600 border border-red-400 text-white text-xs font-semibold shadow-xl flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-white shrink-0" />
          <span>{errorToastMessage}</span>
          <button
            type="button"
            onClick={() => setErrorToastMessage(null)}
            aria-label="Dismiss error toast"
            className="ml-1 p-0.5 rounded hover:bg-red-700 text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-3 sm:px-6 py-4 sm:py-5 space-y-4 sm:space-y-5">
        {cloudSyncError && (
          <div
            role="alert"
            data-testid="cloud-sync-error-banner"
            className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/40 text-red-700 dark:text-red-300 text-xs font-mono flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="space-y-0.5 min-w-0 break-words">
                <div className="font-bold">
                  Cloud Sync Error on project {cloudSyncError.projectId}:{' '}
                  {cloudSyncError.errorCode} — Check Firestore Rules
                </div>
                <div className="text-[11px] opacity-90">
                  Operation: {cloudSyncError.operation} · {cloudSyncError.errorMessage}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => clearCloudSyncError()}
              aria-label="Dismiss Cloud Sync Error"
              className="p-1 rounded hover:bg-red-500/20 text-red-500 shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
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
              activeStatusFilter={statusFilter}
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
                if (bId && statusFilter !== 'ALL_LEADS') {
                  setStatusFilter('FRESH');
                }
              }}
              onClaimBatch={handleClaimBatch}
              onReleaseBatch={handleReleaseBatch}
              onSyncBatchesFromFirestore={handleSyncBatchesFromFirestore}
            />

            {/* 3. Consolidated Priority & Status Filter Tabs + Batch/Rep Filters + 50-Row Paginated Lead Calling Table */}
            <section aria-label="Calling Queue Section" className="space-y-3">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 sm:gap-3">
                {/* Horizontally Scrollable Consolidated Status Filter Tabs */}
                <div
                  data-testid="calling-status-filter-tabs"
                  className="flex items-center gap-2 overflow-x-auto scrollbar-none whitespace-nowrap pb-1 sm:pb-0 -mx-1 px-1"
                >
                  {/* Priority Tab 0 (Far Left): 🔥 To-Call Today (Follow-Ups & Expired Cooldown Retries) */}
                  <button
                    type="button"
                    data-testid="tab-to-call-today"
                    onClick={() => setStatusFilter('TO_CALL_TODAY')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'TO_CALL_TODAY'
                        ? 'bg-amber-500 text-slate-950 border-amber-500'
                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/35 hover:bg-amber-500/20'
                    }`}
                  >
                    <span>🔥 To-Call Today</span>
                    <span
                      data-testid="to-call-today-count-badge"
                      className={`px-1.5 py-0.2 rounded text-[10px] font-mono tabular-nums ${
                        statusFilter === 'TO_CALL_TODAY'
                          ? 'bg-slate-950/20 text-slate-950'
                          : 'bg-amber-500/20 text-amber-800 dark:text-amber-200'
                      }`}
                    >
                      {toCallTodayCount}
                    </span>
                  </button>

                  {/* Tab 1: Today's Batch / Fresh (Default active tab) */}
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

                  {/* Owner Master Lead Table Tab: All Leads & Attempt History */}
                  {isOwner && (
                    <button
                      type="button"
                      data-testid="tab-owner-all-leads"
                      onClick={() => setStatusFilter('ALL_LEADS')}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                        statusFilter === 'ALL_LEADS'
                          ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                          : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      All Leads &amp; Attempt History
                    </button>
                  )}

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

                  {/* Tab 4: Interested (Owner Queue) */}
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

                  {/* Tab 5: Calls Dialed Today */}
                  <button
                    type="button"
                    data-testid="tab-calls-dialed-today"
                    onClick={() => setStatusFilter('CALLS_DIALED_TODAY')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'CALLS_DIALED_TODAY'
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Calls Dialed Today
                  </button>

                  {/* Tab 6: Dead / Closed Out */}
                  <button
                    type="button"
                    data-testid="tab-dead-closed-out"
                    onClick={() => setStatusFilter('DEAD_CLOSED_OUT')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer ${
                      statusFilter === 'DEAD_CLOSED_OUT'
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Dead / Closed Out
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto justify-between lg:justify-end">
                  {/* Owner Compact Batch Selector for Today's Batch / Fresh or All Leads & Attempt History */}
                  {isOwner &&
                    (statusFilter === 'FRESH' || statusFilter === 'ALL_LEADS') && (
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
                      <option value="ALL">
                        {statusFilter === 'ALL_LEADS'
                          ? 'All Leads (All Batches & Pool)'
                          : "All Today's Batches"}
                      </option>
                      {todayActiveBatches.map((b) => {
                        const repLabel = b.claimedByName
                          ? formatRepName(b.claimedByName)
                          : 'Unclaimed';
                        return (
                          <option key={b.batchId} value={b.batchId}>
                            Batch #{b.batchNumber} - {repLabel}
                          </option>
                        );
                      })}
                    </select>
                  )}

                  {/* Owner Compact Sales Rep Selector for Historical / Follow-up / Master Tabs */}
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
