'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Clock,
  CheckCircle2,
  FileSpreadsheet,
  Wand2,
  ShieldCheck,
  Filter,
  X,
  AlertTriangle,
  Lock,
  RotateCcw,
  ArrowRightLeft,
  Activity,
  History,
  MessageSquareShare,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { ConsoleTabId, TopNav } from '@/components/layout/TopNav';
import { AuthorizedUser, BatchRecord, LeadRecord, LeadStatus } from '@/lib/types';
import {
  computeOperationalDatesForStatus,
  loadLocalBatches,
  loadLocalLeads,
  saveLocalBatches,
  saveLocalLeads,
  syncLeadsToFirestore,
} from '@/lib/leadStore';
import {
  computeCooldownUntil,
  generateStratifiedBatch,
  isLeadOnCooldown,
} from '@/lib/batchGenerator';
import {
  claimBatchStateTransition,
  executeCooldownSweeperFirestore,
  executeFirestoreBatchClaim,
  executeFirestoreNightlySweep,
  runCooldownSweeperPure,
  runNightlySweepPure,
} from '@/lib/batchResetCron';
import {
  CooldownSweepSummary,
  DailyBatchDocument,
  NightlySweepSummary,
  formatBatchId,
  getTodayIstDateString,
} from '@/types/batch';
import { AuditActionType, AuditLogRecord } from '@/types/audit';
import {
  loadLocalAuditLogs,
  logLeadEvent,
  logLeadEventsBatch,
} from '@/lib/auditLogger';
import {
  commitLeadsAndAuditToFirestore,
  releaseRepDailyBatchOverridePure,
  remediateDeadStatusCapsPure,
  remediateOrphanedAssignmentsPure,
  runDataIntegrityDiagnostics,
  transferSelectedLeadsPure,
} from '@/lib/integrityChecker';
import { sanitizeIndianPhone } from '@/lib/phoneSanitizer';
import { synthesizeBulkLeadsForBatchTest } from '@/lib/seedData';
import { AddLeadModal } from '@/components/leads/AddLeadModal';
import { ExcelCommitMetadata, ExcelUploadModal } from '@/components/leads/ExcelUploadModal';
import { DailyBatchSelector } from '@/components/batches/DailyBatchSelector';
import { LeadTransferModal } from '@/components/admin/LeadTransferModal';
import { IntegrityDiagnosticModal } from '@/components/admin/IntegrityDiagnosticModal';
import { DisasterRecoveryModal } from '@/components/admin/DisasterRecoveryModal';
import { useLeadLock } from '@/hooks/useLeadLock';
import {
  ImportBatchSnapshotRecord,
  executeImportBatchRollbackFirestore,
  loadLocalImportHistory,
  rollbackImportBatchPure,
  saveLocalImportHistory,
} from '@/scripts/firestoreBackup';
import {
  PendingDispositionItem,
  applyOfflineDispositionLocally,
  cacheActiveBatchLeads,
  enqueueOfflineDisposition,
  flushPendingDispositionsToFirestore,
  getPendingDispositions,
} from '@/lib/offlineSync';
import {
  executeDormantReengagementSweepFirestore,
  runDidntReceiveAltNumberSweepPure,
  runDormantReengagementSweepPure,
  runSwitchOff90DayRevivalPure,
} from '@/lib/reengagementEngine';
import { DispositionHeatmap } from '@/components/analytics/DispositionHeatmap';
import { WhatsAppAction } from '@/components/calling/WhatsAppAction';
import { hasRecentWhatsAppTouchpoint } from '@/lib/whatsappLogger';
import { Leaderboard } from '@/components/analytics/Leaderboard';
import {
  DEFAULT_TEAM_TARGETS,
  TargetSettings,
  TeamTargetsConfig,
  fetchTeamTargetsFromFirestore,
  loadLocalTeamTargets,
} from '@/components/settings/TargetSettings';

interface GeminiPitchBrief {
  openingHook: string;
  estimatedCapacityKw: string;
  keyValueProp: string;
  objectionRebuttal: string;
}

export function PipelineConsole() {
  const { user, authorizedUsers } = useAuth();
  const isOwner = Boolean(
    user?.isOwnerTier ||
      user?.role === 'OWNER' ||
      user?.role === 'ADMIN' ||
      user?.role === 'owner'
  );

  const [activeTab, setActiveTab] = useState<ConsoleTabId>(
    isOwner ? 'global_pool' : 'rep_daily_batch'
  );
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [activeBatchIdFilter, setActiveBatchIdFilter] = useState<string | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isExcelModalOpen, setIsExcelModalOpen] = useState(false);

  // Latest Shuffled Batch Interleaving Proof
  const [lastBatchSummary, setLastBatchSummary] = useState<{
    batchId: string;
    total: number;
    bucketA: number;
    bucketB: number;
    excludedCooldown: number;
    sampleFirst10: {
      id: string;
      companyName: string;
      bucket: 'Bucket A (Untouched)' | 'Bucket B (Retry)';
    }[];
  } | null>(null);

  // Interactive Phone Sanitizer Inspector state
  const [testPhoneInput, setTestPhoneInput] = useState('0091 94293-60746.0');

  // Gemini AI Pitch Drawer state
  const [selectedLeadForPitch, setSelectedLeadForPitch] = useState<LeadRecord | null>(null);
  const [pitchBrief, setPitchBrief] = useState<GeminiPitchBrief | null>(null);
  const [isGeneratingPitch, setIsGeneratingPitch] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Phase 6: Emergency Force Release Confirmation Modal & Cooldown Sweeper Telemetry
  const [isForceReleaseModalOpen, setIsForceReleaseModalOpen] = useState(false);
  const [isExecutingForceRelease, setIsExecutingForceRelease] = useState(false);
  const [lastCooldownSweepSummary, setLastCooldownSweepSummary] =
    useState<CooldownSweepSummary | null>(null);
  const [lastForceReleaseSummary, setLastForceReleaseSummary] =
    useState<NightlySweepSummary | null>(null);

  // Phase 8: Audit Logs, Lead Transfer Modal, and Data Integrity Diagnostic Modal
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState<string>('ALL');
  const [isLeadTransferModalOpen, setIsLeadTransferModalOpen] = useState(false);
  const [isIntegrityModalOpen, setIsIntegrityModalOpen] = useState(false);

  // Phase 10: Disaster Recovery & Import Rollback History + Call Action Drawer Disposition
  const [importHistory, setImportHistory] = useState<ImportBatchSnapshotRecord[]>([]);
  const [isDisasterRecoveryModalOpen, setIsDisasterRecoveryModalOpen] = useState(false);
  const [drawerDisposition, setDrawerDisposition] = useState<LeadStatus>('INTERESTED');
  const [drawerCallNotes, setDrawerCallNotes] = useState('');

  // Phase 12 Task 1: Offline Calling & State Reconciliation state
  const [isOfflineMode, setIsOfflineMode] = useState<boolean>(false);
  const [pendingDispositions, setPendingDispositions] = useState<PendingDispositionItem[]>([]);

  // Phase 14 Task 1: Rep Target & KPI Configuration (`config/targets`)
  const [teamTargets, setTeamTargets] = useState<TeamTargetsConfig>(DEFAULT_TEAM_TARGETS);
  const [isTargetSettingsModalOpen, setIsTargetSettingsModalOpen] = useState<boolean>(false);

  useEffect(() => {
    const initialLeads = loadLocalLeads();
    setLeads(initialLeads);
    setBatches(loadLocalBatches());
    setAuditLogs(loadLocalAuditLogs());
    setImportHistory(loadLocalImportHistory());
    setTeamTargets(loadLocalTeamTargets());
    void fetchTeamTargetsFromFirestore().then((t) => setTeamTargets(t));

    // Cache active batch leads in IndexedDB `reach_local_queue` and load `pending_dispositions`
    void cacheActiveBatchLeads(initialLeads);
    void getPendingDispositions().then((items) => setPendingDispositions(items));

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setIsOfflineMode(true);
    }

    const handleStorageSync = (e: StorageEvent) => {
      if (e.key === 'solarithm_reach_batches_v1') {
        setBatches(loadLocalBatches());
      } else if (e.key === 'solarithm_reach_leads_v1') {
        setLeads(loadLocalLeads());
      } else if (e.key === 'solarithm_reach_audit_logs_v1') {
        setAuditLogs(loadLocalAuditLogs());
      } else if (e.key === 'solarithm_reach_import_history_v1') {
        setImportHistory(loadLocalImportHistory());
      } else if (e.key === 'solarithm_reach_team_targets_v1') {
        setTeamTargets(loadLocalTeamTargets());
      }
    };
    window.addEventListener('storage', handleStorageSync);
    return () => window.removeEventListener('storage', handleStorageSync);
  }, []);

  useEffect(() => {
    if (user) {
      const ownerTier = Boolean(
        user.isOwnerTier ||
          user.role === 'OWNER' ||
          user.role === 'ADMIN' ||
          (user.role as string) === 'owner'
      );
      setActiveTab(ownerTier ? 'global_pool' : 'rep_daily_batch');
      setActiveBatchIdFilter(null);
    }
  }, [user?.role, user?.email, user?.isOwnerTier]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4500);
  };

  const updateLeadsState = useCallback((nextLeads: LeadRecord[]) => {
    setLeads(nextLeads);
    saveLocalLeads(nextLeads);
    void cacheActiveBatchLeads(nextLeads);
  }, []);

  const handleUpdateSingleLeadInState = useCallback((updatedLead: LeadRecord) => {
    setLeads((prev) => {
      const next = prev.map((l) => (l.id === updatedLead.id ? updatedLead : l));
      saveLocalLeads(next);
      return next;
    });
    setSelectedLeadForPitch((prev) =>
      prev && prev.id === updatedLead.id ? updatedLead : prev
    );
  }, []);

  // Phase 10 Task 2: Real-Time Tab Concurrency & Soft Collision Hook (10-minute TTL)
  const {
    collision: activeLeadCollision,
    releaseLock: releaseActiveLeadSoftLock,
    overrideSoftLock,
    simulatePeerCollisionLock,
  } = useLeadLock({
    activeLead: selectedLeadForPitch,
    currentUser: user,
    onUpdateLeadInState: handleUpdateSingleLeadInState,
  });

  const updateBatchesState = useCallback((nextBatches: BatchRecord[]) => {
    setBatches(nextBatches);
    saveLocalBatches(nextBatches);
  }, []);

  const handleSyncBatchesFromFirestore = useCallback(
    (remoteBatches: DailyBatchDocument[]) => {
      setBatches((prev) => {
        const mergedMap = new Map<string, DailyBatchDocument>();
        for (const b of prev) mergedMap.set(b.batchId, b);
        for (const rb of remoteBatches) mergedMap.set(rb.batchId, rb);
        const merged = Array.from(mergedMap.values());
        saveLocalBatches(merged);
        return merged;
      });
    },
    []
  );

  // Compute KPI metrics
  const metrics = useMemo(() => {
    const now = new Date();
    let freshUntouchedBucketA = 0;
    let freshRetryBucketB = 0;
    let activeCooldownCount = 0;
    let interestedCount = 0;

    for (const l of leads) {
      const onCooldown = isLeadOnCooldown(l, now);
      if (onCooldown) {
        activeCooldownCount++;
      }
      if (l.status === 'FRESH' && !onCooldown) {
        if (l.callAttempts === 0) freshUntouchedBucketA++;
        else freshRetryBucketB++;
      }
      if (l.status === 'INTERESTED') {
        interestedCount++;
      }
    }

    return {
      total: leads.length,
      freshUntouchedBucketA,
      freshRetryBucketB,
      activeCooldownCount,
      interestedCount,
    };
  }, [leads]);

  // Detect internal duplicate groups for Duplicate Audit tab
  const duplicateAuditGroups = useMemo(() => {
    const phoneMap = new Map<string, LeadRecord[]>();
    for (const l of leads) {
      const existing = phoneMap.get(l.phoneNumber) || [];
      existing.push(l);
      phoneMap.set(l.phoneNumber, existing);
    }
    return Array.from(phoneMap.entries()).filter(([, group]) => group.length > 1);
  }, [leads]);

  // Phase 12 Task 1.2: Reconnection & Conflict Sync Handler
  const handleFlushOfflineDispositions = useCallback(async () => {
    const currentServerLeads = loadLocalLeads();
    const report = await flushPendingDispositionsToFirestore(currentServerLeads);
    setPendingDispositions([]);
    setIsOfflineMode(false);
    if (report.flushedCount > 0) {
      updateLeadsState(report.updatedLeads);
      if (report.auditLogs.length > 0) {
        await logLeadEventsBatch(
          report.auditLogs.map((a) => ({
            leadId: a.leadId,
            actorEmail: a.actorEmail,
            actorName: a.actorName,
            actorRole: a.actorRole,
            actionType: a.actionType,
            previousStatus: a.previousStatus,
            newStatus: a.newStatus,
            metadata: a.metadata,
            timestamp: a.timestamp,
          }))
        );
        setAuditLogs(loadLocalAuditLogs());
      }
      showToast(
        `Reconnected & synced ${report.flushedCount} offline disposition(s) (${report.conflictsResolvedCount} Owner conflict override(s) reconciled).`
      );
    } else {
      showToast('Reconnected to live Firestore sync.');
    }
  }, [updateLeadsState]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOfflineMode(false);
      void handleFlushOfflineDispositions();
    };
    const handleOffline = () => {
      setIsOfflineMode(true);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleFlushOfflineDispositions]);

  const handleToggleOfflineSimulation = () => {
    if (isOfflineMode) {
      void handleFlushOfflineDispositions();
    } else {
      setIsOfflineMode(true);
      void cacheActiveBatchLeads(leads);
      showToast(
        'Offline Mode active: Dispositions will queue locally in pending_dispositions until reconnection.'
      );
    }
  };

  // Phase 12 Task 2: Dormant Pool Re-engagement Engine Handlers
  const handleRun90DaySwitchOffRevival = async () => {
    const actor = user
      ? { email: user.email, name: user.name, role: user.role }
      : { email: 'system@solarithmdesign.com', name: 'Re-engagement Engine', role: 'system' as const };
    const result = runSwitchOff90DayRevivalPure(leads, new Date(), actor);
    updateLeadsState(result.updatedLeads);
    await executeDormantReengagementSweepFirestore(result.revivedLeads, result.auditLogs);
    if (result.auditLogs.length > 0) {
      await logLeadEventsBatch(
        result.auditLogs.map((a) => ({
          leadId: a.leadId,
          actorEmail: a.actorEmail,
          actorName: a.actorName,
          actorRole: a.actorRole,
          actionType: a.actionType,
          previousStatus: a.previousStatus,
          newStatus: a.newStatus,
          metadata: a.metadata,
          timestamp: a.timestamp,
        }))
      );
      setAuditLogs(loadLocalAuditLogs());
    }
    showToast(
      `90-Day SWITCH_OFF_DEAD Revival complete: ${result.revivedCount} lead(s) transitioned to REVIVED_FRESH (max 10% morning batch quota).`
    );
  };

  const handleRunAltNumberSweep = async () => {
    const actor = user
      ? { email: user.email, name: user.name, role: user.role }
      : { email: 'system@solarithmdesign.com', name: 'Re-engagement Engine', role: 'system' as const };
    const result = runDidntReceiveAltNumberSweepPure(leads, new Date(), actor);
    updateLeadsState(result.updatedLeads);
    await executeDormantReengagementSweepFirestore(result.swappedLeads, result.auditLogs);
    if (result.auditLogs.length > 0) {
      await logLeadEventsBatch(
        result.auditLogs.map((a) => ({
          leadId: a.leadId,
          actorEmail: a.actorEmail,
          actorName: a.actorName,
          actorRole: a.actorRole,
          actionType: a.actionType,
          previousStatus: a.previousStatus,
          newStatus: a.newStatus,
          metadata: a.metadata,
          timestamp: a.timestamp,
        }))
      );
      setAuditLogs(loadLocalAuditLogs());
    }
    showToast(
      `Alternate Number Sweep complete: ${result.swappedCount} exhausted lead(s) swapped to altNumber & returned to FRESH pool.`
    );
  };

  const handleRunFullDormantReengagement = async () => {
    const actor = user
      ? { email: user.email, name: user.name, role: user.role }
      : { email: 'system@solarithmdesign.com', name: 'Re-engagement Engine', role: 'system' as const };
    const summary = runDormantReengagementSweepPure(leads, new Date(), actor);
    updateLeadsState(summary.updatedLeads);
    const changed = summary.updatedLeads.filter(
      (l) => summary.revivedLeadIds.includes(l.id) || summary.swappedLeadIds.includes(l.id)
    );
    await executeDormantReengagementSweepFirestore(changed, summary.auditLogs);
    if (summary.auditLogs.length > 0) {
      await logLeadEventsBatch(
        summary.auditLogs.map((a) => ({
          leadId: a.leadId,
          actorEmail: a.actorEmail,
          actorName: a.actorName,
          actorRole: a.actorRole,
          actionType: a.actionType,
          previousStatus: a.previousStatus,
          newStatus: a.newStatus,
          metadata: a.metadata,
          timestamp: a.timestamp,
        }))
      );
      setAuditLogs(loadLocalAuditLogs());
    }
    showToast(
      `Dormant Re-engagement complete: ${summary.revivedSwitchOffCount} revived to REVIVED_FRESH & ${summary.swappedAltNumberCount} swapped to altNumber.`
    );
  };

  // Handle Call Disposition & Increment Batch `completedCallsCount` (Supports Offline Mode Queueing)
  const handleDispositionChange = (leadId: string, nextStatus: LeadStatus, customNotes?: string) => {
    if (!user) return;
    const targetLead = leads.find((l) => l.id === leadId);
    if (!targetLead) return;

    // Task 3 Security Rule enforcement: Sales reps cannot alter leads marked INTERESTED, CLOSED_WON, or LEAD_LOST
    if (
      user.role === 'sales' &&
      (targetLead.status === 'INTERESTED' ||
        targetLead.status === 'CLOSED_WON' ||
        targetLead.status === 'LEAD_LOST')
    ) {
      showToast(
        `Protected status (${targetLead.status}): Only an Owner can modify this lead.`
      );
      return;
    }

    const nowIso = new Date().toISOString();

    // Phase 12 Task 1: If offline (`isOfflineMode` or `navigator.onLine === false`), store in `pending_dispositions`
    if (isOfflineMode || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void enqueueOfflineDisposition({
        lead: targetLead,
        repEmail: user.email,
        repName: user.name,
        repRole: user.role,
        newStatus: nextStatus,
        callNotes:
          customNotes?.trim() ||
          `Offline call disposition (${targetLead.status} -> ${nextStatus})`,
        clientLoggedAt: nowIso,
      }).then((queuedItem) => {
        setPendingDispositions((prev) => [...prev, queuedItem]);
        const nextLeads = leads.map((l) =>
          l.id === leadId ? applyOfflineDispositionLocally(l, queuedItem) : l
        );
        updateLeadsState(nextLeads);
        showToast(
          `Offline Mode: Queued ${targetLead.companyName} -> ${nextStatus} in pending_dispositions (${nowIso.slice(11, 19)} UTC).`
        );
      });
      return;
    }

    let affectedBatchId: string | null = null;

    const updated = leads.map((lead) => {
      if (lead.id !== leadId) return lead;

      affectedBatchId = lead.assignedBatchId;
      const nextAttempts = lead.callAttempts + 1;
      let nextDidntReceive = lead.didntReceiveCount;
      let nextSwitchOff = lead.switchOffCount;
      let finalStatus: LeadStatus = nextStatus;
      let nextCooldown: string | null = null;

      if (nextStatus === 'DIDNT_RECEIVE') {
        nextDidntReceive += 1;
        if (nextDidntReceive >= 10) {
          finalStatus = 'DIDNT_RECEIVE_DEAD';
          nextCooldown = null;
        } else {
          nextCooldown = computeCooldownUntil(nowIso, 48);
        }
      } else if (nextStatus === 'SWITCH_OFF') {
        nextSwitchOff += 1;
        if (nextSwitchOff >= 3) {
          finalStatus = 'SWITCH_OFF_DEAD';
        }
      }

      const nextCallHistory = [
        ...(lead.callHistory || []),
        {
          id: `call-${Date.now()}`,
          timestamp: nowIso,
          repEmail: user.email,
          repName: user.name,
          previousStatus: lead.status,
          newStatus: finalStatus,
          note:
            customNotes?.trim() ||
            `Call attempt #${nextAttempts} (${lead.status} -> ${finalStatus})`,
        },
      ];

      const { nextFollowUpDate: computedFollowUp } = computeOperationalDatesForStatus(
        finalStatus,
        nowIso
      );

      return {
        ...lead,
        status: finalStatus,
        callAttempts: nextAttempts,
        didntReceiveCount: nextDidntReceive,
        switchOffCount: nextSwitchOff,
        lastCalledDate: nowIso,
        cooldownUntil: nextCooldown,
        nextFollowUpDate: computedFollowUp ?? lead.nextFollowUpDate,
        assignedRepEmail: lead.assignedRepEmail || user.email,
        assignedRepName: lead.assignedRepName || user.name,
        notes: customNotes?.trim() ? customNotes.trim() : lead.notes,
        callHistory: nextCallHistory,
        updatedAt: nowIso,
      };
    });

    updateLeadsState(updated);

    // Live increment `completedCallsCount` on the associated batch
    if (affectedBatchId) {
      const nextBatches = batches.map((b) =>
        b.batchId === affectedBatchId
          ? { ...b, completedCallsCount: (b.completedCallsCount || 0) + 1 }
          : b
      );
      updateBatchesState(nextBatches);
    }

    const changed = updated.find((l) => l.id === leadId);
    if (changed) {
      syncLeadsToFirestore([changed]);

      // Phase 8 Task 1: Log immutable call/transition audit event
      const auditAction: AuditActionType =
        changed.status === 'CLOSED_WON'
          ? 'CLOSED_WON'
          : changed.status === 'LEAD_LOST'
            ? 'LEAD_LOST'
            : 'CALL_LOGGED';

      logLeadEvent({
        leadId: changed.id,
        actorEmail: user.email,
        actorName: user.name,
        actorRole: user.role,
        actionType: auditAction,
        previousStatus: targetLead.status,
        newStatus: changed.status,
        metadata: {
          companyName: changed.companyName,
          phoneNumber: changed.phoneNumber,
          batchId: changed.assignedBatchId,
          callNote:
            customNotes?.trim() ||
            `Call attempt #${changed.callAttempts} logged (${targetLead.status} -> ${changed.status})`,
        },
        timestamp: nowIso,
      }).then(() => setAuditLogs(loadLocalAuditLogs()));

      if (changed.status === 'DIDNT_RECEIVE' && changed.cooldownUntil) {
        showToast(
          `48-Hour Cooldown Lock activated for ${changed.companyName} until ${changed.cooldownUntil.slice(0, 16).replace('T', ' ')}`
        );
      } else if (changed.status === 'INTERESTED') {
        showToast(`${changed.companyName} routed to Owner Closing Queue!`);
      } else {
        showToast(`Logged call for ${changed.companyName} -> ${changed.status}`);
      }
    }
  };

  // Task 2: Morning Batch Claim & Lock Handler (Atomic Transaction + Lead Assignment)
  const handleClaimBatch = async (batchId: string, rep: AuthorizedUser) => {
    const nowIso = new Date().toISOString();
    const result = claimBatchStateTransition(batchId, rep, batches, leads, nowIso);

    updateBatchesState(result.updatedBatches);
    updateLeadsState(result.updatedLeads);

    // Route claiming rep directly to their active Daily Calling Queue
    if (user && user.email.toLowerCase() === rep.email.toLowerCase()) {
      setActiveBatchIdFilter(batchId);
    }

    await executeFirestoreBatchClaim(
      batchId,
      rep,
      result.updatedBatch.leadIds || [],
      nowIso
    );

    await logLeadEvent({
      leadId: result.updatedBatch.leadIds?.[0] || batchId,
      actorEmail: user?.email || rep.email,
      actorName: user?.name || rep.name,
      actorRole: user?.role || 'sales',
      actionType: 'LEAD_CLAIMED',
      previousStatus: 'FRESH',
      newStatus: 'FRESH',
      metadata: {
        batchId,
        toRepEmail: rep.email,
        toRepName: rep.name,
        callNote: `Claimed & locked ${batchId} (${result.updatedBatch.totalLeads.toLocaleString()} leads assigned)`,
      },
      timestamp: nowIso,
    });
    setAuditLogs(loadLocalAuditLogs());

    showToast(
      `Locked ${batchId} for ${rep.name.split(' (')[0]} (${result.updatedBatch.totalLeads.toLocaleString()} leads assigned)`
    );
  };

  // Task 3 / Phase 6 Task 1: 11:59 PM Daily Reset & Lead Release Engine Handler
  const handleRunNightlySweep = async (): Promise<NightlySweepSummary> => {
    const todayDate = getTodayIstDateString();
    const nowIso = new Date().toISOString();

    const sweepResult = runNightlySweepPure(batches, leads, todayDate, nowIso);
    updateBatchesState(sweepResult.updatedBatches);
    updateLeadsState(sweepResult.updatedLeads);
    setActiveBatchIdFilter(null);
    setLastForceReleaseSummary(sweepResult.summary);
    if (sweepResult.summary.cooldownSweep) {
      setLastCooldownSweepSummary(sweepResult.summary.cooldownSweep);
    }

    await executeFirestoreNightlySweep(todayDate, nowIso);

    await logLeadEvent({
      leadId: sweepResult.summary.closedBatchIds[0] || `SWEEP_${todayDate}`,
      actorEmail: user?.email || 'system@solarithmdesign.com',
      actorName: user?.name || 'Nightly Reset Cron Engine',
      actorRole: user?.role || 'system',
      actionType: 'BATCH_RESET',
      previousStatus: 'FRESH',
      newStatus: 'FRESH',
      metadata: {
        batchId: sweepResult.summary.closedBatchIds.join(', ') || todayDate,
        remediationReason: `Released ${sweepResult.summary.uncalledLeadsReleasedCount} uncalled FRESH leads & closed ${sweepResult.summary.closedBatchesCount} batches`,
      },
      timestamp: nowIso,
    });
    setAuditLogs(loadLocalAuditLogs());

    showToast(
      `11:59 PM Sweep complete: Closed ${sweepResult.summary.closedBatchesCount} batches & released ${sweepResult.summary.uncalledLeadsReleasedCount.toLocaleString()} uncalled FRESH leads back to pool.`
    );

    return sweepResult.summary;
  };

  // Phase 6 Task 2: Cooldown & Starvation Prevention Sweeper Handler
  const handleRunCooldownSweeper = async () => {
    const now = new Date();
    const result = runCooldownSweeperPure(leads, now);
    updateLeadsState(result.updatedLeads);
    setLastCooldownSweepSummary(result.summary);

    await executeCooldownSweeperFirestore(now);

    showToast(
      `Cooldown Sweeper complete: ${result.summary.cooldownClearedCount} expired 48h locks cleared, ${
        result.summary.didntReceiveDeadCount + result.summary.switchOffDeadCount
      } dead leads retired.`
    );
  };

  // Phase 6 Task 2.3: Confirmed Emergency Force Release Handler
  const handleConfirmForceReleaseUncalled = async () => {
    setIsExecutingForceRelease(true);
    try {
      await handleRunNightlySweep();
      setIsForceReleaseModalOpen(false);
    } finally {
      setIsExecutingForceRelease(false);
    }
  };

  // Phase 8 Task 2.1: Selective Lead Transfer Handler
  const handleTransferSelectedLeads = async (
    selectedLeadIds: string[],
    targetRep: AuthorizedUser
  ) => {
    if (!user) return;
    const nowIso = new Date().toISOString();
    const result = transferSelectedLeadsPure(
      leads,
      selectedLeadIds,
      targetRep,
      user,
      nowIso
    );
    updateLeadsState(result.updatedLeads);

    const changedLeads = result.updatedLeads.filter((l) =>
      selectedLeadIds.includes(l.id)
    );
    await commitLeadsAndAuditToFirestore(changedLeads, result.auditEvents);
    setAuditLogs(loadLocalAuditLogs());

    showToast(
      `Transferred ${result.transferredCount} lead(s) to ${targetRep.name.split(' (')[0]} & logged MANUALLY_TRANSFERRED in audit_logs.`
    );
  };

  // Phase 8 Task 2.2: Mid-Day Batch Release Override Handler
  const handleReleaseBatchOverride = async (targetBatchId: string) => {
    if (!user) return;
    const nowIso = new Date().toISOString();
    const result = releaseRepDailyBatchOverridePure(
      batches,
      leads,
      targetBatchId,
      user,
      nowIso
    );
    updateBatchesState(result.updatedBatches);
    updateLeadsState(result.updatedLeads);
    if (activeBatchIdFilter === targetBatchId) {
      setActiveBatchIdFilter(null);
    }

    await logLeadEventsBatch(result.auditEvents);
    setAuditLogs(loadLocalAuditLogs());

    showToast(
      `Mid-Day Override: Released ${result.releasedLeadsCount} uncalled FRESH lead(s) from ${targetBatchId} back to Global Pool.`
    );
  };

  // Phase 8 Task 3.2: [Fix Orphaned Assignments] Handler
  const handleFixOrphanedAssignments = async (): Promise<number> => {
    if (!user) return 0;
    const nowIso = new Date().toISOString();
    const result = remediateOrphanedAssignmentsPure(
      leads,
      authorizedUsers,
      { email: user.email, name: user.name, role: 'owner' },
      nowIso
    );
    updateLeadsState(result.updatedLeads);
    await logLeadEventsBatch(result.auditEvents);
    setAuditLogs(loadLocalAuditLogs());
    showToast(
      `Fixed ${result.remediatedCount} orphaned lead assignment(s) & moved uncalled leads to Fresh Pool.`
    );
    return result.remediatedCount;
  };

  // Phase 8 Task 3.2: [Enforce Dead-Status Caps] Handler
  const handleEnforceDeadStatusCaps = async (): Promise<number> => {
    if (!user) return 0;
    const nowIso = new Date().toISOString();
    const result = remediateDeadStatusCapsPure(
      leads,
      { email: user.email, name: user.name, role: 'owner' },
      nowIso
    );
    updateLeadsState(result.updatedLeads);
    await logLeadEventsBatch(result.auditEvents);
    setAuditLogs(loadLocalAuditLogs());
    showToast(
      `Enforced dead-status caps on ${result.remediatedCount} lead(s) -> DIDNT_RECEIVE_DEAD / SWITCH_OFF_DEAD.`
    );
    return result.remediatedCount;
  };

  // Inject test anomalies for on-demand diagnostic testing
  const handleInjectTestAnomalies = () => {
    const nowIso = new Date().toISOString();
    const anomalyOrphan: LeadRecord = {
      id: `lead-orphan-${Date.now()}`,
      companyName: 'Kutch Wind & Solar Hybrid Park Pvt Ltd',
      companyNameNormalized: 'kutch wind & solar hybrid park pvt ltd',
      phoneNumber: '9825776611',
      formattedPhone: '+91 98257 76611',
      altNumber: null,
      state: 'Gujarat',
      city: 'Bhuj',
      status: 'FRESH',
      assignedBatchId: 'BATCH-LEGACY-ORPHAN',
      assignedRepEmail: 'resigned.rep@solarithmdesign.com',
      assignedRepName: 'Nitin Joshi (Resigned Rep)',
      callAttempts: 0,
      didntReceiveCount: 0,
      switchOffCount: 0,
      lastCalledDate: null,
      cooldownUntil: null,
      nextFollowUpDate: '2026-10-02T08:00:00.000Z',
      createdAt: nowIso,
      updatedAt: nowIso,
      notes: 'Assigned to resigned rep — test anomaly.',
    };
    const anomalyDeadCap: LeadRecord = {
      id: `lead-deadcap-${Date.now()}`,
      companyName: 'Vapi Paper & Pulp Mill Industries',
      companyNameNormalized: 'vapi paper & pulp mill industries',
      phoneNumber: '9879112299',
      formattedPhone: '+91 98791 12299',
      altNumber: null,
      state: 'Gujarat',
      city: 'Vapi',
      status: 'FRESH',
      assignedBatchId: null,
      assignedRepEmail: 'sales@solarithmdesign.com',
      assignedRepName: 'Priya Nair',
      callAttempts: 12,
      didntReceiveCount: 12,
      switchOffCount: 0,
      lastCalledDate: '2026-10-05T10:00:00.000Z',
      cooldownUntil: null,
      nextFollowUpDate: '2026-10-06T10:00:00.000Z',
      createdAt: nowIso,
      updatedAt: nowIso,
      notes: 'Stuck with 12 DIDNT_RECEIVE attempts — test anomaly.',
    };
    updateLeadsState([anomalyOrphan, anomalyDeadCap, ...leads]);
  };

  // Single Lead Creation / Merge
  const handleCreateSingleLead = (lead: LeadRecord, isOverwrite = false) => {
    if (isOverwrite) {
      const prev = leads.find((l) => l.id === lead.id);
      const next = leads.map((l) => (l.id === lead.id ? lead : l));
      updateLeadsState(next);
      syncLeadsToFirestore([lead]);
      if (user) {
        logLeadEvent({
          leadId: lead.id,
          actorEmail: user.email,
          actorName: user.name,
          actorRole: user.role,
          actionType: 'DUPLICATE_OVERWRITTEN',
          previousStatus: prev?.status || 'FRESH',
          newStatus: lead.status,
          metadata: {
            companyName: lead.companyName,
            phoneNumber: lead.phoneNumber,
            duplicateMatchReason: 'Manual Overwrite (preserved status & call history)',
          },
        }).then(() => setAuditLogs(loadLocalAuditLogs()));
      }
      showToast(`Updated existing record for ${lead.companyName} (preserved status & history)`);
    } else {
      const next = [lead, ...leads];
      updateLeadsState(next);
      syncLeadsToFirestore([lead]);
      showToast(`Added fresh lead: ${lead.companyName} (${lead.formattedPhone})`);
    }
  };

  // Excel Ingestion Commit + Phase 10 importBatchId Snapshot Tracking
  const handleCommitExcelIngestion = (
    newLeads: LeadRecord[],
    updatedLeads: LeadRecord[],
    meta?: ExcelCommitMetadata
  ) => {
    const updateMap = new Map<string, LeadRecord>();
    for (const u of updatedLeads) updateMap.set(u.id, u);

    const mergedExisting = leads.map((existing) => updateMap.get(existing.id) || existing);
    const combined = [...newLeads, ...mergedExisting];
    updateLeadsState(combined);
    if (!meta) {
      syncLeadsToFirestore([...newLeads, ...updatedLeads]);
    }

    if (meta && user) {
      const snapshotEntry: ImportBatchSnapshotRecord = {
        importBatchId: meta.importBatchId,
        fileName: meta.fileName,
        importedAt: new Date().toISOString(),
        importedByEmail: user.email,
        importedByName: user.name,
        insertedLeadIds: newLeads.map((l) => l.id),
        overwrittenLeadCount: updatedLeads.length,
        preOverwriteSnapshots: meta.preOverwriteSnapshots,
        rolledBackAt: null,
      };
      const nextHistory = [snapshotEntry, ...importHistory];
      setImportHistory(nextHistory);
      saveLocalImportHistory(nextHistory);
    }

    if (user && updatedLeads.length > 0) {
      logLeadEventsBatch(
        updatedLeads.map((u) => ({
          leadId: u.id,
          actorEmail: user.email,
          actorName: user.name,
          actorRole: user.role,
          actionType: 'DUPLICATE_OVERWRITTEN' as const,
          previousStatus: u.status,
          newStatus: u.status,
          metadata: {
            companyName: u.companyName,
            phoneNumber: u.phoneNumber,
            duplicateMatchReason: 'Excel Pre-Flight Duplicate Overwrite',
          },
        }))
      ).then(() => setAuditLogs(loadLocalAuditLogs()));
    }

    showToast(
      `Ingestion complete (${meta?.importBatchId || 'Batch'}): ${newLeads.length.toLocaleString()} fresh leads added, ${updatedLeads.length.toLocaleString()} existing records updated.`
    );
  };

  // Phase 10 Task 3: One-Click Rollback by `importBatchId`
  const handleRollbackImportBatch = async (targetImportBatchId: string) => {
    const nowIso = new Date().toISOString();
    const result = rollbackImportBatchPure(
      leads,
      targetImportBatchId,
      importHistory,
      nowIso
    );
    updateLeadsState(result.updatedLeads);
    setImportHistory(result.updatedImportHistory);
    saveLocalImportHistory(result.updatedImportHistory);

    await executeImportBatchRollbackFirestore(targetImportBatchId, importHistory);

    if (user) {
      await logLeadEvent({
        leadId: targetImportBatchId,
        actorEmail: user.email,
        actorName: user.name,
        actorRole: user.role,
        actionType: 'STATUS_CHANGED',
        previousStatus: 'FRESH',
        newStatus: 'FRESH',
        metadata: {
          batchId: targetImportBatchId,
          remediationReason: `Emergency Rollback of ${targetImportBatchId}: Removed ${result.removedInsertedLeadsCount} inserted leads & restored ${result.restoredOverwrittenLeadsCount} overwritten records`,
        },
        timestamp: nowIso,
      });
      setAuditLogs(loadLocalAuditLogs());
    }

    showToast(
      `Rolled back ${targetImportBatchId}: Removed ${result.removedInsertedLeadsCount.toLocaleString()} inserted leads & restored ${result.restoredOverwrittenLeadsCount.toLocaleString()} overwritten records.`
    );
  };

  // Synthesize 3,250 Bulk C&I Leads for testing 3,000-lead Batch Shuffler
  const handleSynthesizeBulkPool = () => {
    const bulk = synthesizeBulkLeadsForBatchTest(leads.length);
    const combined = [...leads, ...bulk];
    updateLeadsState(combined);
    showToast(
      `Synthesized 3,250 C&I leads (2,350 Untouched Bucket A + 800 Retry Bucket B + 100 Active Cooldown)`
    );
  };

  // Generate New Daily Stratified Batch (`BATCH_YYYY_MM_DD_XX`, Status: AVAILABLE)
  const handleGenerateNewDailyBatch = (targetSize: number = 3000) => {
    if (!user) return;
    const unassignedPool = leads.filter((l) => !l.assignedBatchId);
    const poolToUse = unassignedPool.length > 0 ? unassignedPool : leads;
    const result = generateStratifiedBatch(poolToUse, targetSize, new Date());

    if (result.batchLeads.length === 0) {
      showToast('No eligible FRESH leads available outside of 48-hour cooldown.');
      return;
    }

    const todayDate = getTodayIstDateString();
    const todayBatches = batches.filter((b) => b.date === todayDate);
    const nextBatchNumber =
      todayBatches.length > 0
        ? Math.max(...todayBatches.map((b) => b.batchNumber)) + 1
        : 1;
    const batchId = formatBatchId(todayDate, nextBatchNumber);

    const newBatch: DailyBatchDocument = {
      batchId,
      batchNumber: nextBatchNumber,
      date: todayDate,
      totalLeads: result.batchLeads.length,
      claimedByEmail: null,
      claimedByName: null,
      claimedAt: null,
      status: 'AVAILABLE',
      completedCallsCount: 0,
      untouchedCount: result.bucketACount,
      retryCount: result.bucketBCount,
      leadIds: result.batchLeads.map((l) => l.id),
      createdAt: new Date().toISOString(),
    };

    const nextBatches = [...batches, newBatch];
    updateBatchesState(nextBatches);

    setLastBatchSummary({
      batchId,
      total: result.batchLeads.length,
      bucketA: result.bucketACount,
      bucketB: result.bucketBCount,
      excludedCooldown: result.excludedOnCooldownCount,
      sampleFirst10: result.batchLeads.slice(0, 10).map((l) => ({
        id: l.id,
        companyName: l.companyName,
        bucket: l.callAttempts === 0 ? 'Bucket A (Untouched)' : 'Bucket B (Retry)',
      })),
    });

    showToast(
      `Generated ${batchId} (${result.batchLeads.length.toLocaleString()} leads: ${result.bucketACount.toLocaleString()} Bucket A / ${result.bucketBCount.toLocaleString()} Bucket B) — Status: AVAILABLE`
    );
  };

  // Trigger Call Action & Pitch Drawer (Acquires 10-minute Soft Lock via useLeadLock)
  const handleOpenPitchBrief = async (lead: LeadRecord) => {
    setSelectedLeadForPitch(lead);
    setDrawerDisposition(lead.status === 'FRESH' ? 'INTERESTED' : lead.status);
    setDrawerCallNotes(lead.notes || '');
    setIsGeneratingPitch(false);
    setPitchBrief({
      openingHook: `Speaking with the Facility / Energy Head at ${lead.companyName}? We help industrial units in ${lead.city || lead.state || 'India'} cut HT power costs by 45% via captive solar.`,
      estimatedCapacityKw: '500 kWp – 1.2 MWp Industrial Rooftop',
      keyValueProp: '3.1-year CAPEX payback with 40% accelerated depreciation benefit.',
      objectionRebuttal: 'Full DISCOM net-metering and CEIG statutory approvals handled turnkey.',
    });
  };

  // Filtered leads based on role + activeTab + activeBatchIdFilter + searchQuery + statusFilter
  const displayedLeads = useMemo(() => {
    if (!user) return [];
    const now = new Date();
    const q = searchQuery.trim().toLowerCase();

    return leads
      .filter((lead) => {
        if (activeBatchIdFilter && lead.assignedBatchId !== activeBatchIdFilter) {
          return false;
        }

        // Role & Tab Scopes
        if (activeTab === 'owner_closing_queue') {
          if (lead.status !== 'INTERESTED' && lead.status !== 'PROPOSAL_SHARED') return false;
        } else if (activeTab === 'rep_daily_batch') {
          // Sales Rep sees leads assigned to their claimed batch (or open pool if filtering)
          const isAssignedToRep =
            lead.assignedRepEmail?.toLowerCase() === user.email.toLowerCase();
          const isUnassignedFresh = !lead.assignedRepEmail && lead.status === 'FRESH';
          if (!isAssignedToRep && !isUnassignedFresh) return false;
          if (isLeadOnCooldown(lead, now)) return false;
        } else if (activeTab === 'rep_dialed_leads') {
          if (
            lead.assignedRepEmail?.toLowerCase() !== user.email.toLowerCase() ||
            lead.callAttempts === 0
          ) {
            return false;
          }
        }

        if (statusFilter !== 'ALL' && lead.status !== statusFilter) {
          return false;
        }

        if (q) {
          const matchesCompany = lead.companyNameNormalized.includes(q);
          const matchesPhone =
            lead.phoneNumber.includes(q) || (lead.altNumber && lead.altNumber.includes(q));
          const matchesLocation =
            (lead.city && lead.city.toLowerCase().includes(q)) ||
            (lead.state && lead.state.toLowerCase().includes(q));
          if (!matchesCompany && !matchesPhone && !matchesLocation) return false;
        }

        return true;
      })
      .slice(0, 150);
  }, [leads, user, activeTab, activeBatchIdFilter, statusFilter, searchQuery]);

  const liveSanitizedPreview = useMemo(
    () => sanitizeIndianPhone(testPhoneInput),
    [testPhoneInput]
  );

  const integrityReport = useMemo(
    () => runDataIntegrityDiagnostics(leads, authorizedUsers, new Date()),
    [leads, authorizedUsers]
  );

  const filteredAuditLogs = useMemo(() => {
    if (auditActionFilter === 'ALL') return auditLogs;
    return auditLogs.filter((log) => log.actionType === auditActionFilter);
  }, [auditLogs, auditActionFilter]);

  if (!user) return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#090B0E] text-slate-900 dark:text-slate-100 flex flex-col">
      <TopNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        interestedCount={metrics.interestedCount}
        duplicateCount={duplicateAuditGroups.length}
        auditLogsCount={auditLogs.length}
        leads={leads}
        teamTargets={teamTargets}
        isOfflineMode={isOfflineMode}
        pendingDispositionsCount={pendingDispositions.length}
        onToggleOfflineSimulation={handleToggleOfflineSimulation}
        onFlushOfflineQueueNow={handleFlushOfflineDispositions}
        onOpenExcelModal={() => setIsExcelModalOpen(true)}
        onOpenAddLeadModal={() => setIsAddModalOpen(true)}
        onRequestForceReleaseUncalled={() => setIsForceReleaseModalOpen(true)}
        onRequestCooldownSweep={handleRunCooldownSweeper}
        onOpenLeadTransferModal={() => setIsLeadTransferModalOpen(true)}
        onOpenIntegrityDiagnosticModal={() => setIsIntegrityModalOpen(true)}
        onOpenDisasterRecoveryModal={() => setIsDisasterRecoveryModalOpen(true)}
        onOpenTargetSettingsModal={() => setIsTargetSettingsModalOpen(true)}
      />

      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-40 px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-[#1A1F2B] border border-[#E5B842]/40 text-white text-xs font-medium shadow-xl flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4 text-[#E5B842] shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Top Executive KPI Strip */}
        <section
          aria-label="Pipeline Telemetry Summary"
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5"
        >
          <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
            <div className="text-xs text-slate-500 dark:text-slate-400">Total Pipeline Leads</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
              {metrics.total.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Strict 10-digit normalized records
            </div>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Bucket A · Untouched (75% Target)
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
              {metrics.freshUntouchedBucketA.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              status = FRESH · callAttempts = 0
            </div>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Bucket B · Cooldown Cleared (25%)
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-1">
              {metrics.freshRetryBucketB.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              didntReceiveCount &gt; 0 · Ready to retry
            </div>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              48-Hour Cooldown Locked
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-amber-600 dark:text-amber-400 mt-1">
              {metrics.activeCooldownCount.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Excluded from today&apos;s batch shuffler
            </div>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-[#E5B842]/30">
            <div className="text-xs font-medium text-[#9A7110] dark:text-[#E5B842]">
              Interested · Owner Closing Queue
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
              {metrics.interestedCount.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              High-priority EPC closing prospects
            </div>
          </div>
        </section>

        {/* PHASE 8: Owner Administrative Governance Bar (Lead Transfer, Data Integrity Diagnostics & Audit Trail) */}
        {isOwner && (
          <section
            aria-label="Administrative Reconciliation & Governance"
            className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3.5"
          >
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  Administrative Reconciliation, Rep Handover &amp; Audit Governance
                </span>
                <span className="text-[11px] font-mono text-[#B88917] dark:text-[#E5B842]">
                  · {integrityReport.totalIssuesCount} Integrity Alerts · {auditLogs.length} Immutable Audit Logs
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Reassign <code className="font-mono">PROPOSAL_SHARED</code> /{' '}
                <code className="font-mono">FUTURE_REQUIREMENT</code> leads between sales reps, override mid-day batch locks, and run 1-click orphan &amp; dead-cap remediation.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                data-testid="open-lead-transfer-btn"
                onClick={() => setIsLeadTransferModalOpen(true)}
                className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>Lead Transfer &amp; Rep Handover</span>
              </button>

              <button
                type="button"
                data-testid="open-integrity-diagnostic-btn"
                onClick={() => setIsIntegrityModalOpen(true)}
                className="px-3.5 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Activity className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>
                  Data Integrity &amp; Orphan Cleaner ({integrityReport.totalIssuesCount})
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('audit_trail')}
                className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <History className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>Audit Trail ({auditLogs.length})</span>
              </button>

              <button
                type="button"
                data-testid="open-disaster-recovery-btn"
                onClick={() => setIsDisasterRecoveryModalOpen(true)}
                className="px-3.5 py-2 rounded-xl border border-[#E5B842]/40 bg-[#E5B842]/10 hover:bg-[#E5B842]/20 text-xs font-semibold text-[#9A7110] dark:text-[#E5B842] flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>Disaster Recovery &amp; Snapshot (.json.gz)</span>
              </button>
            </div>
          </section>
        )}

        {/* PHASE 3: DailyBatchSelector (Visible on Sales Rep's "Daily Fresh Batches" AND Owner's "Daily Batch Health & Shuffler") */}
        {(activeTab === 'rep_daily_batch' || activeTab === 'batch_health') && (
          <div className="space-y-4">
            <DailyBatchSelector
              currentUser={user}
              authorizedUsers={authorizedUsers}
              batches={batches}
              leads={leads}
              activeBatchIdFilter={activeBatchIdFilter}
              onSelectActiveBatchWorkspace={(bId) => setActiveBatchIdFilter(bId)}
              onClaimBatch={handleClaimBatch}
              onGenerateNewDailyBatch={handleGenerateNewDailyBatch}
              onRunNightlySweep={handleRunNightlySweep}
              onSyncBatchesFromFirestore={handleSyncBatchesFromFirestore}
            />

            {/* Phase 6: Cooldown Sweeper & Emergency Force Release Panel (Owner View) */}
            {isOwner && activeTab === 'batch_health' && (
              <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      Phase 6 · Cooldown Sweeper &amp; Dead-Lead Threshold Enforcer
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">
                      · DIDNT_RECEIVE (48h / Max 10) · SWITCH_OFF (Max 3)
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Clears expired <code className="font-mono">cooldownUntil &le; now</code> locks for morning Bucket B recirculation and permanently retires <code className="font-mono">SWITCH_OFF &ge; 3</code> or <code className="font-mono">DIDNT_RECEIVE &gt; 10</code> leads.
                  </p>
                  {lastCooldownSweepSummary && (
                    <div className="pt-1 text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                      Last Cooldown Sweep ({lastCooldownSweepSummary.sweptAt.slice(11, 19)} UTC):{' '}
                      {lastCooldownSweepSummary.cooldownClearedCount} locks cleared ·{' '}
                      {lastCooldownSweepSummary.switchOffDeadCount} SWITCH_OFF_DEAD ·{' '}
                      {lastCooldownSweepSummary.didntReceiveDeadCount} DIDNT_RECEIVE_DEAD
                    </div>
                  )}
                  {lastForceReleaseSummary && (
                    <div className="pt-0.5 text-[11px] font-mono text-[#B88917] dark:text-[#E5B842]">
                      Last Force Release ({lastForceReleaseSummary.sweptAt.slice(11, 19)} UTC):{' '}
                      Released {lastForceReleaseSummary.uncalledLeadsReleasedCount} uncalled FRESH leads &amp; closed {lastForceReleaseSummary.closedBatchesCount} batches
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    data-testid="run-cooldown-sweeper-btn"
                    onClick={handleRunCooldownSweeper}
                    className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-sky-400" />
                    <span>Run Cooldown Sweeper</span>
                  </button>

                  <button
                    type="button"
                    data-testid="open-force-release-modal-btn"
                    onClick={() => setIsForceReleaseModalOpen(true)}
                    className="px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    <span>Force Release Uncalled Leads Now</span>
                  </button>
                </div>
              </div>
            )}

            {/* Latest Shuffled Batch Interleaving Proof */}
            {lastBatchSummary && isOwner && (
              <div className="p-4 rounded-xl bg-emerald-500/[0.05] border border-emerald-500/25 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                    Shuffled Batch Generated: {lastBatchSummary.batchId}
                  </div>
                  <div className="text-xs font-mono text-slate-600 dark:text-slate-300">
                    Total: {lastBatchSummary.total.toLocaleString()} · Bucket A:{' '}
                    {lastBatchSummary.bucketA.toLocaleString()} · Bucket B:{' '}
                    {lastBatchSummary.bucketB.toLocaleString()} · Cooldown Excluded:{' '}
                    {lastBatchSummary.excludedCooldown.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                    First 10 Dial Positions after Fisher-Yates Randomization (proving anti-starvation interleaving):
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {lastBatchSummary.sampleFirst10.map((item, idx) => (
                      <div
                        key={item.id}
                        className="p-2 rounded-lg bg-white dark:bg-[#0D1016] border border-slate-200 dark:border-white/10 text-[11px]"
                      >
                        <div className="font-mono text-slate-400">#{idx + 1}</div>
                        <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                          {item.companyName}
                        </div>
                        <div
                          className={`font-mono text-[10px] mt-0.5 ${
                            item.bucket.includes('Bucket A')
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-sky-600 dark:text-sky-400'
                          }`}
                        >
                          {item.bucket}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* PHASE 12 TASK 2 & 3: Call Disposition Distribution, Quality Heatmap & Dormant Pool Re-engagement Engine */}
        {activeTab === 'disposition_analytics' && isOwner && (
          <DispositionHeatmap
            leads={leads}
            authorizedUsers={authorizedUsers}
            onRun90DaySwitchOffRevival={handleRun90DaySwitchOffRevival}
            onRunAltNumberSweep={handleRunAltNumberSweep}
            onRunFullDormantReengagement={handleRunFullDormantReengagement}
          />
        )}

        {/* PHASE 14 TASK 1, 2 & 3: Real-Time Team Leaderboard, Rep Target Configuration & Sunday Executive Digest */}
        {activeTab === 'team_leaderboard' && (
          <Leaderboard
            leads={leads}
            authorizedUsers={authorizedUsers}
            targets={teamTargets}
            onSaveTargets={(nextTargets) => {
              setTeamTargets(nextTargets);
              showToast(
                `Updated config/targets: ${nextTargets.dailyDialsTarget} daily dials · ${nextTargets.weeklyInterestedTarget} weekly interested · ${nextTargets.proposalTurnaroundTargetHours}h SLA`
              );
            }}
            isOwner={isOwner}
            actorEmail={user.email}
          />
        )}

        {/* TAB VIEW: Duplicate Audit & Phone Normalizer Verification Bench */}
        {activeTab === 'duplicate_audit' && isOwner && (
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 p-6 rounded-2xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#E5B842]" />
                    <span>Global Firestore Duplicate Audit</span>
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Enforces uniqueness across <code className="font-mono">phoneNumber</code>,{' '}
                    <code className="font-mono">altNumber</code>, and case-insensitive{' '}
                    <code className="font-mono">companyNameNormalized</code>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsExcelModalOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>Open Pre-Flight Conflict Resolver</span>
                </button>
              </div>

              {duplicateAuditGroups.length === 0 ? (
                <div className="p-8 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] text-center space-y-2">
                  <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto" />
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">
                    Zero Unresolved Phone Collisions in Active Pool
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                    All {leads.length.toLocaleString()} stored records have unique 10-digit normalized Indian phone keys. Click &quot;Open Pre-Flight Conflict Resolver&quot; to test incoming duplicate sheets.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {duplicateAuditGroups.map(([phone, group]) => (
                    <div
                      key={phone}
                      className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.05] text-xs"
                    >
                      <div className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                        Collision on +91 {phone} ({group.length} records)
                      </div>
                      <div className="mt-1 text-slate-600 dark:text-slate-300">
                        {group.map((g) => g.companyName).join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Interactive Phone Sanitizer Bench */}
            <div className="p-6 rounded-2xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 space-y-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Indian Phone Sanitizer Bench
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Test dirty strings, Excel floats (<code className="font-mono">.0</code>,{' '}
                  <code className="font-mono">9.825E+09</code>), and prefixes (<code className="font-mono">91</code>,{' '}
                  <code className="font-mono">091</code>, <code className="font-mono">0</code>,{' '}
                  <code className="font-mono">0091</code>)
                </p>
              </div>

              <div>
                <label
                  htmlFor="sanitizer-bench-input"
                  className="block text-[11px] font-semibold uppercase text-slate-400 mb-1.5"
                >
                  Raw Input Value
                </label>
                <input
                  id="sanitizer-bench-input"
                  type="text"
                  value={testPhoneInput}
                  onChange={(e) => setTestPhoneInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-900 dark:text-white"
                />
              </div>

              <div className="flex flex-wrap gap-1.5">
                {['9825011223.0', '9.82501E+09', '00919429360746', '0919429360746', '09429360746'].map(
                  (preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setTestPhoneInput(preset)}
                      className="px-2 py-1 rounded bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-[11px] font-mono text-slate-600 dark:text-slate-300 cursor-pointer"
                    >
                      {preset}
                    </button>
                  )
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 font-mono text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">isValid:</span>
                  <span
                    className={
                      liveSanitizedPreview.isValid ? 'text-emerald-500 font-bold' : 'text-red-500 font-bold'
                    }
                  >
                    {String(liveSanitizedPreview.isValid)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">cleaned (DB):</span>
                  <span className="text-slate-900 dark:text-white">
                    &quot;{liveSanitizedPreview.cleaned}&quot;
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">formatted (UI):</span>
                  <span className="text-[#B88917] dark:text-[#E5B842]">
                    &quot;{liveSanitizedPreview.formatted}&quot;
                  </span>
                </div>
                {liveSanitizedPreview.error && (
                  <div className="text-[11px] text-red-500 pt-1 border-t border-slate-200 dark:border-white/5">
                    Error: {liveSanitizedPreview.error}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* PHASE 8 TASK 1: IMMUTABLE CALL & TRANSITION AUDIT LOGS PANEL */}
        {activeTab === 'audit_trail' && isOwner && (
          <section
            aria-label="Immutable Call & Transition Audit Trail"
            data-testid="audit-trail-section"
            className="bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-xs"
          >
            <div className="p-5 border-b border-slate-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <History className="w-4 h-4 text-[#E5B842]" />
                  <span>Immutable Call &amp; Transition Audit Trail (`audit_logs`)</span>
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Append-only compliance ledger recorded via <code className="font-mono">logLeadEvent()</code> across call logs, batch claims, manual transfers, duplicate overwrites, and nightly resets.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    'ALL',
                    'CALL_LOGGED',
                    'WHATSAPP_DISPATCHED',
                    'MANUALLY_TRANSFERRED',
                    'LEAD_CLAIMED',
                    'BATCH_RESET',
                    'STATUS_CHANGED',
                    'DUPLICATE_OVERWRITTEN',
                    'CLOSED_WON',
                    'LEAD_LOST',
                  ] as const
                ).map((act) => (
                  <button
                    key={act}
                    type="button"
                    onClick={() => setAuditActionFilter(act)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono transition-colors cursor-pointer ${
                      auditActionFilter === act
                        ? 'bg-[#7C6328] text-white font-semibold'
                        : 'bg-slate-100 dark:bg-[#171C26] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
                    }`}
                  >
                    {act}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#0D1016] text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4">Timestamp (UTC)</th>
                    <th className="py-3 px-4">Action Type</th>
                    <th className="py-3 px-4">Lead / Target</th>
                    <th className="py-3 px-4">Status Transition</th>
                    <th className="py-3 px-4">Actor &amp; Role</th>
                    <th className="py-3 px-4">Compliance Context &amp; Metadata</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
                  {filteredAuditLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-white/[0.02]"
                    >
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                        {log.timestamp.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] font-semibold text-[#B88917] dark:text-[#E5B842] whitespace-nowrap">
                        {log.actionType}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {log.metadata?.companyName || log.leadId}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">
                          ID: {log.leadId}
                          {log.metadata?.phoneNumber
                            ? ` · +91 ${log.metadata.phoneNumber}`
                            : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">
                        <span className="text-slate-400">
                          {log.previousStatus || 'NONE'}
                        </span>{' '}
                        &rarr;{' '}
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                          {log.newStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="text-slate-800 dark:text-slate-200 font-medium">
                          {log.actorName.split(' (')[0]}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">
                          {log.actorEmail} · {log.actorRole.toUpperCase()}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-md">
                        {log.metadata?.callNote ||
                          log.metadata?.remediationReason ||
                          log.metadata?.duplicateMatchReason ||
                          (log.metadata?.toRepName
                            ? `Transferred from ${log.metadata.fromRepName || 'Unassigned'} to ${log.metadata.toRepName}`
                            : JSON.stringify(log.metadata))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* MAIN LEAD PIPELINE / DAILY CALLING QUEUE TABLE */}
        <section className="bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-xs">
          {/* Toolbar: Search, Status Filter, Active Batch Filter Indicator */}
          <div className="p-4 border-b border-slate-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3.5">
            <div className="flex flex-wrap items-center gap-3 flex-1">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  aria-label="Search leads by company, 10-digit phone, or city"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search company, 10-digit phone, city, or state..."
                  className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                />
              </div>

              {activeBatchIdFilter && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#E5B842]/15 border border-[#E5B842]/35 text-xs font-mono text-[#9A7110] dark:text-[#E5B842]">
                  <Filter className="w-3 h-3" />
                  <span>Queue: {activeBatchIdFilter}</span>
                  <button
                    type="button"
                    onClick={() => setActiveBatchIdFilter(null)}
                    aria-label="Clear batch filter"
                    className="ml-1 hover:text-white cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* Interactive Status Filter Control */}
              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-[#161A23] overflow-x-auto">
                {(['ALL', 'FRESH', 'INTERESTED', 'PROPOSAL_SHARED', 'DIDNT_RECEIVE', 'CLOSED_WON'] as const).map(
                  (st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        statusFilter === st
                          ? 'bg-white dark:bg-[#252B39] text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                      }`}
                    >
                      {st === 'ALL' ? 'All Statuses' : st.replace(/_/g, ' ')}
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>
                Showing <strong className="font-mono text-slate-900 dark:text-white">{displayedLeads.length}</strong>{' '}
                of <strong className="font-mono text-slate-900 dark:text-white">{leads.length.toLocaleString()}</strong> leads
              </span>
            </div>
          </div>

          {/* High-Density Data Grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-[#151922] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-white/10">
                  <th className="py-3 px-4 font-semibold">Company &amp; Industrial Cluster</th>
                  <th className="py-3 px-4 font-semibold">Formatted Phone (10-Digit Core)</th>
                  <th className="py-3 px-4 font-semibold">Pipeline Status &amp; Cooldown</th>
                  <th className="py-3 px-4 font-semibold text-right">Attempts / Retries</th>
                  <th className="py-3 px-3 font-semibold">Assigned Rep</th>
                  <th className="py-3 px-3 font-semibold text-right">Quick Telecalling Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-white/5">
                {displayedLeads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <div className="max-w-sm mx-auto space-y-2">
                        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                          No matching solar leads in this queue
                        </div>
                        <p className="text-xs text-slate-500">
                          Claim an available morning batch above or reset your filters.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setStatusFilter('ALL');
                            setSearchQuery('');
                            setActiveBatchIdFilter(null);
                          }}
                          className="mt-2 px-3 py-1.5 rounded-lg bg-[#7C6328] text-white text-xs font-semibold cursor-pointer"
                        >
                          Reset Filters
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  displayedLeads.map((lead) => {
                    const lockedOnCooldown = isLeadOnCooldown(lead);
                    const recentWhatsApp = hasRecentWhatsAppTouchpoint(lead);
                    return (
                      <tr
                        key={lead.id}
                        className="hover:bg-slate-50/90 dark:hover:bg-white/[0.02] transition-colors"
                      >
                        {/* Column 1: Company, 7-Day WhatsApp Touchpoint Indicator & Notes */}
                        <td className="py-3 px-4 align-top max-w-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900 dark:text-white truncate">
                              {lead.companyName}
                            </span>
                            {recentWhatsApp && (
                              <span
                                data-testid={`whatsapp-7d-indicator-${lead.id}`}
                                title={`WhatsApp collateral sent within past 7 days (${
                                  lead.lastWhatsAppTemplateName || 'Template'
                                } · ${lead.lastWhatsAppSentAt?.slice(0, 10)})`}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-500 text-[10px] font-mono shrink-0"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                <MessageSquareShare className="w-3 h-3 text-emerald-500" />
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mt-0.5">
                            <span>{lead.city || 'Industrial Zone'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{lead.state || 'India'}</span>
                            {lead.assignedBatchId && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono text-[10px] text-[#B88917] dark:text-[#E5B842]">
                                  {lead.assignedBatchId}
                                </span>
                              </>
                            )}
                          </div>
                          {lead.notes && (
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                              {lead.notes}
                            </p>
                          )}
                        </td>

                        {/* Column 2: Formatted Phone + DB 10-Digit */}
                        <td className="py-3 px-4 align-top font-mono tabular-nums whitespace-nowrap">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {lead.formattedPhone}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            Key: {lead.phoneNumber}
                            {lead.altNumber ? ` · Alt: ${lead.altNumber}` : ''}
                          </div>
                        </td>

                        {/* Column 3: Unboxed Status Metadata + Cooldown Lock */}
                        <td className="py-3 px-4 align-top whitespace-nowrap">
                          <div className="flex items-center gap-1.5 font-mono text-xs font-semibold">
                            <span
                              className={
                                lead.status === 'INTERESTED' || lead.status === 'CLOSED_WON'
                                  ? 'text-[#B88917] dark:text-[#E5B842]'
                                  : lead.status === 'FRESH'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : lead.status.includes('DEAD')
                                  ? 'text-red-500'
                                  : 'text-slate-700 dark:text-slate-300'
                              }
                            >
                              {lead.status}
                            </span>
                            <span aria-hidden="true" className="text-slate-400">
                              ·
                            </span>
                            <span className="text-[11px] font-normal text-slate-500">
                              {lead.callAttempts === 0 ? 'Bucket A' : 'Bucket B'}
                            </span>
                          </div>
                          {lockedOnCooldown && lead.cooldownUntil && (
                            <div className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 font-mono mt-0.5">
                              <Clock className="w-3 h-3" />
                              <span>48h Lock until {lead.cooldownUntil.slice(5, 16).replace('T', ' ')}</span>
                            </div>
                          )}
                        </td>

                        {/* Column 4: Tabular Attempts / Counters */}
                        <td className="py-3 px-4 align-top text-right font-mono tabular-nums whitespace-nowrap">
                          <div className="text-slate-900 dark:text-slate-200 font-medium">
                            {lead.callAttempts} dials
                          </div>
                          <div className="text-[11px] text-slate-400">
                            NR: {lead.didntReceiveCount}/10 · SO: {lead.switchOffCount}/3
                          </div>
                        </td>

                        {/* Column 5: Assigned Rep */}
                        <td className="py-3 px-3 align-top whitespace-nowrap">
                          <div className="text-slate-800 dark:text-slate-200">
                            {lead.assignedRepName ? lead.assignedRepName.split(' (')[0] : 'Unassigned Pool'}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono">
                            {lead.lastCalledDate
                              ? `Last: ${lead.lastCalledDate.slice(0, 10)}`
                              : 'Never dialed'}
                          </div>
                        </td>

                        {/* Column 6: Interactive Disposition Selector & AI Pitch Strategist */}
                        <td className="py-3 px-3 align-top text-right whitespace-nowrap">
                          {(() => {
                            const isSalesProtected =
                              !isOwner &&
                              (lead.status === 'INTERESTED' ||
                                lead.status === 'CLOSED_WON' ||
                                lead.status === 'LEAD_LOST');

                            return (
                              <div className="inline-flex items-center justify-end gap-1.5">
                                {isSalesProtected && (
                                  <span
                                    title="Protected Owner-only status (INTERESTED / CLOSED_WON / LEAD_LOST)"
                                    className="inline-flex items-center text-amber-500"
                                  >
                                    <Lock className="w-3.5 h-3.5" />
                                  </span>
                                )}
                                <select
                                  aria-label={`Log call disposition for ${lead.companyName}`}
                                  value={lead.status}
                                  disabled={isSalesProtected}
                                  onChange={(e) =>
                                    handleDispositionChange(lead.id, e.target.value as LeadStatus)
                                  }
                                  className="w-[155px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-[#181C26] border border-slate-200 dark:border-white/10 text-[11px] font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#E5B842] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                  <option value="FRESH">FRESH</option>
                                  <option value="REVIVED_FRESH">REVIVED_FRESH (10% Quota)</option>
                                  <option value="INTERESTED">INTERESTED (Owner)</option>
                                  <option value="PROPOSAL_SHARED">PROPOSAL_SHARED</option>
                                  <option value="DIDNT_RECEIVE">DIDNT_RECEIVE (+48h)</option>
                                  <option value="SWITCH_OFF">SWITCH_OFF (Max 3)</option>
                                  <option value="FUTURE_REQUIREMENT">FUTURE_REQUIREMENT</option>
                                  <option value="NOT_INTERESTED">NOT_INTERESTED</option>
                                  <option value="NOT_A_SOLAR_COMPANY">NOT_A_SOLAR_COMPANY</option>
                                  <option value="CLOSED_WON">CLOSED_WON</option>
                                  <option value="LEAD_LOST">LEAD_LOST</option>
                                  <option value="SWITCH_OFF_DEAD">SWITCH_OFF_DEAD</option>
                                  <option value="DIDNT_RECEIVE_DEAD">DIDNT_RECEIVE_DEAD</option>
                                </select>

                                <button
                                  type="button"
                                  data-testid={`open-drawer-${lead.id}`}
                                  onClick={() => handleOpenPitchBrief(lead)}
                                  title="Generate AI Solar Pitch & Capacity Brief"
                                  className="px-2.5 py-1 rounded-lg bg-[#E5B842]/15 hover:bg-[#E5B842]/25 border border-[#E5B842]/30 text-[11px] font-semibold text-[#9A7110] dark:text-[#E5B842] flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                                >
                                  <Wand2 className="w-3 h-3" />
                                  <span>AI Pitch</span>
                                </button>
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Slide-Over Call Action & Gemini AI Telecalling Pitch Drawer (With Phase 10 Soft-Lock Concurrency) */}
      {selectedLeadForPitch && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Call Action & AI Solar Telecalling Drawer"
          data-testid="call-action-drawer"
          className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-xs"
        >
          <div className="w-full max-w-lg h-full bg-white dark:bg-[#12151C] border-l border-slate-200 dark:border-white/10 p-6 flex flex-col justify-between overflow-y-auto shadow-2xl">
            <div className="space-y-4">
              <div className="flex items-start justify-between border-b border-slate-200 dark:border-white/10 pb-4">
                <div>
                  <div className="text-[11px] font-mono uppercase tracking-wider text-[#B88917] dark:text-[#E5B842]">
                    Call Action Drawer · Soft-Lock Concurrency Guard
                  </div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white mt-0.5">
                    {selectedLeadForPitch.companyName}
                  </h3>
                  <p className="text-xs font-mono text-slate-500">
                    {selectedLeadForPitch.formattedPhone} · {selectedLeadForPitch.city},{' '}
                    {selectedLeadForPitch.state}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    releaseActiveLeadSoftLock(selectedLeadForPitch);
                    setSelectedLeadForPitch(null);
                  }}
                  className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                >
                  Close
                </button>
              </div>

              {/* Phase 10 Task 2: Soft-Lock Status & Multi-Tab Collision Testing Control */}
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="font-mono text-slate-600 dark:text-slate-300">
                  Soft Lock (10m TTL):{' '}
                  <strong className="text-slate-900 dark:text-white">
                    {selectedLeadForPitch.currentCallerName
                      ? selectedLeadForPitch.currentCallerName.split(' (')[0]
                      : user.name.split(' (')[0]}
                  </strong>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="simulate-peer-soft-lock-btn"
                    onClick={() =>
                      simulatePeerCollisionLock({
                        email: 'sales2@solarithmdesign.com',
                        name: 'Rohan Kulkarni (Sales Rep)',
                      })
                    }
                    className="px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-700 dark:text-amber-300 font-semibold cursor-pointer"
                  >
                    Simulate Peer Soft Lock (Rohan Kulkarni)
                  </button>
                </div>
              </div>

              {/* Phase 10 Task 2.2: Non-Blocking Amber Collision Warning Banner */}
              {activeLeadCollision.isLockedByAnotherRep && (
                <div
                  role="alert"
                  data-testid="soft-lock-collision-banner"
                  className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-800 dark:text-amber-200 space-y-2"
                >
                  <div className="flex items-start gap-2.5 text-xs font-semibold">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <span>{activeLeadCollision.bannerMessage}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] pl-6">
                    <span className="font-mono text-amber-700 dark:text-amber-300">
                      Expires in {Math.max(1, Math.ceil(activeLeadCollision.remainingMs / 60000))} min · Submit locked
                    </span>
                    {isOwner && (
                      <button
                        type="button"
                        data-testid="owner-override-soft-lock-btn"
                        onClick={overrideSoftLock}
                        className="px-2.5 py-1 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] text-white font-semibold cursor-pointer"
                      >
                        Owner Override Lock
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Phase 13 Task 1 & 2: 1-Click WhatsApp Quick Action, Dialer & Outreach Template Library */}
              <WhatsAppAction
                lead={selectedLeadForPitch}
                currentUser={user}
                onDispatched={(result) => {
                  handleUpdateSingleLeadInState(result.updatedLead);
                  setAuditLogs(loadLocalAuditLogs());
                  showToast(
                    `WhatsApp Dispatched (${result.subcollectionEntry.templateName.split(' (')[0]}) to ${selectedLeadForPitch.companyName} (+91 ${selectedLeadForPitch.phoneNumber})`
                  );
                }}
              />

              {/* Call Disposition & Field Notes Form inside Drawer */}
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-3">
                <div>
                  <label
                    htmlFor="drawer-disposition-select"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1"
                  >
                    Call Outcome / Disposition
                  </label>
                  <select
                    id="drawer-disposition-select"
                    value={drawerDisposition}
                    onChange={(e) => setDrawerDisposition(e.target.value as LeadStatus)}
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-900 dark:text-white"
                  >
                    <option value="INTERESTED">INTERESTED (Route to Owner Queue)</option>
                    <option value="PROPOSAL_SHARED">PROPOSAL_SHARED</option>
                    <option value="DIDNT_RECEIVE">DIDNT_RECEIVE (+48h Cooldown)</option>
                    <option value="SWITCH_OFF">SWITCH_OFF (Max 3)</option>
                    <option value="FUTURE_REQUIREMENT">FUTURE_REQUIREMENT</option>
                    <option value="NOT_INTERESTED">NOT_INTERESTED</option>
                    <option value="NOT_A_SOLAR_COMPANY">NOT_A_SOLAR_COMPANY</option>
                    <option value="CLOSED_WON">CLOSED_WON</option>
                    <option value="LEAD_LOST">LEAD_LOST</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="drawer-call-notes"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1"
                  >
                    Call Summary / Roof &amp; Sanctioned Load Notes
                  </label>
                  <input
                    id="drawer-call-notes"
                    type="text"
                    value={drawerCallNotes}
                    onChange={(e) => setDrawerCallNotes(e.target.value)}
                    placeholder="e.g., 800 kVA HT connection, requested 650 kWp CAPEX quote..."
                    className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              {isGeneratingPitch ? (
                <div className="space-y-3 py-6 text-center">
                  <Wand2 className="w-6 h-6 text-[#E5B842] mx-auto" />
                  <p className="text-xs text-slate-500">
                    Synthesizing C&amp;I DISCOM tariff savings &amp; kWp sizing script...
                  </p>
                </div>
              ) : (
                pitchBrief && (
                  <div className="space-y-3 text-xs">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10">
                      <div className="font-semibold text-slate-800 dark:text-slate-200 mb-1">
                        1. Opening Telecalling Hook
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                        &ldquo;{pitchBrief.openingHook}&rdquo;
                      </p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10">
                      <div className="font-semibold text-slate-800 dark:text-slate-200 mb-1">
                        2. Recommended Plant Sizing
                      </div>
                      <p className="font-mono text-[#B88917] dark:text-[#E5B842]">
                        {pitchBrief.estimatedCapacityKw}
                      </p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10">
                      <div className="font-semibold text-slate-800 dark:text-slate-200 mb-1">
                        3. Commercial CAPEX / OPEX Value Proposition
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                        {pitchBrief.keyValueProp}
                      </p>
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-white/10 flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="save-and-load-next-lead-btn"
                disabled={activeLeadCollision.isLockedByAnotherRep}
                onClick={() => {
                  const currentId = selectedLeadForPitch.id;
                  const currentIdx = displayedLeads.findIndex((l) => l.id === currentId);
                  releaseActiveLeadSoftLock(selectedLeadForPitch);
                  handleDispositionChange(currentId, drawerDisposition, drawerCallNotes);
                  const nextCandidate =
                    currentIdx >= 0 && currentIdx + 1 < displayedLeads.length
                      ? displayedLeads[currentIdx + 1]
                      : null;
                  if (nextCandidate && nextCandidate.id !== currentId) {
                    void handleOpenPitchBrief(nextCandidate);
                  } else {
                    setSelectedLeadForPitch(null);
                  }
                }}
                className="flex-1 py-2.5 px-3 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold cursor-pointer transition-colors"
              >
                Save &amp; Load Next Lead
              </button>
              <button
                type="button"
                onClick={() => {
                  releaseActiveLeadSoftLock(selectedLeadForPitch);
                  setSelectedLeadForPitch(null);
                }}
                className="py-2.5 px-3 rounded-xl border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 6 Task 2.3: Owner Emergency "Force Release Uncalled Leads Now" Confirmation Modal */}
      {isForceReleaseModalOpen && isOwner && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="force-release-modal-title"
          data-testid="force-release-confirmation-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-[#12161F] border border-slate-200 dark:border-white/15 shadow-2xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h3
                    id="force-release-modal-title"
                    className="text-base font-bold text-slate-900 dark:text-white"
                  >
                    Force Release Uncalled Leads Now
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Emergency Manual Trigger for <code className="font-mono">midnightReset.ts</code> &amp; <code className="font-mono">cooldownSweeper.ts</code>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsForceReleaseModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0E14] border border-slate-200 dark:border-white/10 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Uncalled FRESH leads to unlink (<code className="font-mono">assignedBatchId != null</code>):
                </span>
                <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                  {leads.filter((l) => l.assignedBatchId !== null && l.status === 'FRESH').length.toLocaleString()} leads
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Active / Available batches to transition to <code className="font-mono">CLOSED</code>:
                </span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  {batches.filter((b) => b.status === 'AVAILABLE' || b.status === 'IN_PROGRESS').length} batches
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Firestore Batch Write Limit:
                </span>
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  500 records / commit
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Confirming this operation will immediately reset{' '}
              <code className="font-mono">assignedBatchId = null</code>,{' '}
              <code className="font-mono">assignedRepEmail = null</code>, and{' '}
              <code className="font-mono">assignedRepName = null</code> on all untouched{' '}
              <code className="font-mono">FRESH</code> leads, retire today&apos;s active batches to{' '}
              <code className="font-mono">CLOSED</code>, and sweep expired 48-hour cooldowns.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-white/10">
              <button
                type="button"
                onClick={() => setIsForceReleaseModalOpen(false)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-white/15 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-force-release-btn"
                disabled={isExecutingForceRelease}
                onClick={handleConfirmForceReleaseUncalled}
                className="px-4 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>
                  {isExecutingForceRelease
                    ? 'Releasing Uncalled Leads...'
                    : 'Confirm & Force Release Now'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals (Owner-tier restricted for Ingestion) */}
      <AddLeadModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        existingLeads={leads}
        isOwnerTier={isOwner}
        onCreateLead={handleCreateSingleLead}
      />

      <ExcelUploadModal
        isOpen={isExcelModalOpen}
        onClose={() => setIsExcelModalOpen(false)}
        existingLeads={leads}
        isOwnerTier={isOwner}
        onCommitIngestion={handleCommitExcelIngestion}
      />

      <LeadTransferModal
        isOpen={isLeadTransferModalOpen}
        onClose={() => setIsLeadTransferModalOpen(false)}
        leads={leads}
        batches={batches}
        authorizedUsers={authorizedUsers}
        onTransferSelectedLeads={handleTransferSelectedLeads}
        onReleaseBatchOverride={handleReleaseBatchOverride}
      />

      <IntegrityDiagnosticModal
        isOpen={isIntegrityModalOpen}
        onClose={() => setIsIntegrityModalOpen(false)}
        leads={leads}
        authorizedUsers={authorizedUsers}
        onFixOrphanedAssignments={handleFixOrphanedAssignments}
        onEnforceDeadStatusCaps={handleEnforceDeadStatusCaps}
        onInjectTestAnomalies={handleInjectTestAnomalies}
      />

      <DisasterRecoveryModal
        isOpen={isDisasterRecoveryModalOpen}
        onClose={() => setIsDisasterRecoveryModalOpen(false)}
        leads={leads}
        batches={batches}
        auditLogs={auditLogs}
        importHistory={importHistory}
        onRollbackImportBatch={handleRollbackImportBatch}
      />

      <TargetSettings
        isOpen={isTargetSettingsModalOpen}
        onClose={() => setIsTargetSettingsModalOpen(false)}
        targets={teamTargets}
        actorEmail={user.email}
        onSaveTargets={(nextTargets) => {
          setTeamTargets(nextTargets);
          showToast(
            `Saved config/targets: ${nextTargets.dailyDialsTarget} daily dials · ${nextTargets.weeklyInterestedTarget} weekly interested · ${nextTargets.proposalTurnaroundTargetHours}h SLA`
          );
        }}
      />
    </div>
  );
}
