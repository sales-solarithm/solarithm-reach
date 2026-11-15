'use client';

import React, { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  CheckSquare,
  Square,
  Unlock,
  UserCheck,
  X,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import { DailyBatchDocument } from '@/types/batch';

interface LeadTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  leads: LeadRecord[];
  batches: DailyBatchDocument[];
  authorizedUsers: AuthorizedUser[];
  onTransferSelectedLeads: (
    selectedLeadIds: string[],
    targetRep: AuthorizedUser
  ) => Promise<void>;
  onReleaseBatchOverride: (batchId: string) => Promise<void>;
}

export function LeadTransferModal({
  isOpen,
  onClose,
  leads,
  batches,
  authorizedUsers,
  onTransferSelectedLeads,
  onReleaseBatchOverride,
}: LeadTransferModalProps) {
  const activeSalesReps = useMemo(
    () =>
      authorizedUsers.filter((u) => u.role === 'sales' && u.status === 'active'),
    [authorizedUsers]
  );

  // Filter leads in PROPOSAL_SHARED or FUTURE_REQUIREMENT status
  const transferableLeads = useMemo(
    () =>
      leads.filter(
        (l) =>
          l.status === 'PROPOSAL_SHARED' || l.status === 'FUTURE_REQUIREMENT'
      ),
    [leads]
  );

  // Unique source reps currently holding PROPOSAL_SHARED or FUTURE_REQUIREMENT leads
  const sourceRepEmails = useMemo(() => {
    const emails = new Set<string>();
    for (const l of transferableLeads) {
      if (l.assignedRepEmail) emails.add(l.assignedRepEmail);
    }
    return Array.from(emails);
  }, [transferableLeads]);

  const [sourceRepFilter, setSourceRepFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'PROPOSAL_SHARED' | 'FUTURE_REQUIREMENT'
  >('ALL');
  const [targetRepEmail, setTargetRepEmail] = useState<string>(
    activeSalesReps[0]?.email || 'rohan@solarithmdesign.com'
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [releasingBatchId, setReleasingBatchId] = useState<string | null>(null);

  const filteredTransferableLeads = useMemo(() => {
    return transferableLeads.filter((l) => {
      if (
        sourceRepFilter !== 'ALL' &&
        l.assignedRepEmail?.toLowerCase() !== sourceRepFilter.toLowerCase()
      ) {
        return false;
      }
      if (statusFilter !== 'ALL' && l.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [transferableLeads, sourceRepFilter, statusFilter]);

  // Active IN_PROGRESS batches (or batches with uncalled FRESH leads) for Mid-Day Override
  const releasableBatches = useMemo(() => {
    return batches.filter(
      (b) =>
        b.status === 'IN_PROGRESS' ||
        leads.some(
          (l) => l.assignedBatchId === b.batchId && l.status === 'FRESH'
        )
    );
  }, [batches, leads]);

  if (!isOpen) return null;

  const toggleLeadSelection = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllVisible = () => {
    const visibleIds = filteredTransferableLeads.map((l) => l.id);
    const allSelected =
      visibleIds.length > 0 &&
      visibleIds.every((id) => selectedIds.includes(id));

    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      const merged = new Set([...selectedIds, ...visibleIds]);
      setSelectedIds(Array.from(merged));
    }
  };

  const handleExecuteTransfer = async () => {
    if (selectedIds.length === 0) return;
    const targetRep =
      activeSalesReps.find(
        (r) => r.email.toLowerCase() === targetRepEmail.toLowerCase()
      ) || activeSalesReps[0];
    if (!targetRep) return;

    setIsSubmitting(true);
    try {
      await onTransferSelectedLeads(selectedIds, targetRep);
      setSelectedIds([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecuteBatchOverride = async (batchId: string) => {
    setReleasingBatchId(batchId);
    try {
      await onReleaseBatchOverride(batchId);
    } finally {
      setReleasingBatchId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lead-transfer-modal-title"
      data-testid="lead-transfer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div className="w-full max-w-4xl max-h-[90vh] rounded-2xl bg-white dark:bg-[#11151E] border border-slate-200 dark:border-white/15 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center shrink-0">
              <ArrowRightLeft className="w-5 h-5 text-[#E5B842]" />
            </div>
            <div>
              <h2
                id="lead-transfer-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white"
              >
                Lead Re-Assignment &amp; Rep Handover Engine
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Selective pipeline transfer (<code className="font-mono">PROPOSAL_SHARED</code> /{' '}
                <code className="font-mono">FUTURE_REQUIREMENT</code>) &amp; Mid-Day Batch Release Override
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Lead Transfer Modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Section 1: Selective Batch Transfer */}
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  1. Selective Rep Handover (PROPOSAL_SHARED &amp; FUTURE_REQUIREMENT)
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Reassign pipeline leads while preserving <code className="font-mono">lastCalledDate</code>,{' '}
                  <code className="font-mono">nextFollowUpDate</code>, notes, and call counters. Writes{' '}
                  <code className="font-mono">MANUALLY_TRANSFERRED</code> to <code className="font-mono">audit_logs</code>.
                </p>
              </div>

              {/* Filter Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Filter by Source Sales Rep"
                  data-testid="transfer-source-rep-select"
                  value={sourceRepFilter}
                  onChange={(e) => setSourceRepFilter(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-[#171C28] border border-slate-200 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200"
                >
                  <option value="ALL">All Source Reps ({transferableLeads.length})</option>
                  {sourceRepEmails.map((email) => (
                    <option key={email} value={email}>
                      From: {email}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter by Transferable Status"
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(
                      e.target.value as 'ALL' | 'PROPOSAL_SHARED' | 'FUTURE_REQUIREMENT'
                    )
                  }
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-[#171C28] border border-slate-200 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200"
                >
                  <option value="ALL">All Eligible Statuses</option>
                  <option value="PROPOSAL_SHARED">PROPOSAL_SHARED Only</option>
                  <option value="FUTURE_REQUIREMENT">FUTURE_REQUIREMENT Only</option>
                </select>
              </div>
            </div>

            {/* Selection Table */}
            <div className="rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden">
              <div className="bg-slate-50 dark:bg-[#0D1017] px-4 py-2.5 border-b border-slate-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  data-testid="transfer-select-all-btn"
                  onClick={handleSelectAllVisible}
                  className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2 cursor-pointer"
                >
                  {filteredTransferableLeads.length > 0 &&
                  filteredTransferableLeads.every((l) =>
                    selectedIds.includes(l.id)
                  ) ? (
                    <CheckSquare className="w-4 h-4 text-[#E5B842]" />
                  ) : (
                    <Square className="w-4 h-4 text-slate-400" />
                  )}
                  <span>
                    Select All Visible ({filteredTransferableLeads.length} leads)
                  </span>
                </button>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Reassign <strong className="text-slate-900 dark:text-white">{selectedIds.length}</strong> selected to:
                  </span>
                  <div className="relative flex items-center">
                    <UserCheck className="w-3.5 h-3.5 text-[#E5B842] absolute left-2.5 pointer-events-none" />
                    <select
                      aria-label="Target Active Sales Rep"
                      data-testid="transfer-target-rep-select"
                      value={targetRepEmail}
                      onChange={(e) => setTargetRepEmail(e.target.value)}
                      className="pl-8 pr-3 py-1.5 rounded-lg bg-white dark:bg-[#171C28] border border-slate-200 dark:border-white/15 text-xs font-medium text-slate-900 dark:text-white"
                    >
                      {activeSalesReps.map((rep) => (
                        <option key={rep.email} value={rep.email}>
                          {rep.name} ({rep.email})
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    data-testid="execute-lead-transfer-btn"
                    disabled={selectedIds.length === 0 || isSubmitting}
                    onClick={handleExecuteTransfer}
                    className="px-3.5 py-1.5 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#E5B842]" />
                    <span>
                      {isSubmitting
                        ? 'Transferring...'
                        : `Transfer ${selectedIds.length} Lead${selectedIds.length === 1 ? '' : 's'}`}
                    </span>
                  </button>
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
                {filteredTransferableLeads.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    No leads match the selected PROPOSAL_SHARED / FUTURE_REQUIREMENT filter.
                  </div>
                ) : (
                  filteredTransferableLeads.map((lead) => {
                    const isChecked = selectedIds.includes(lead.id);
                    return (
                      <div
                        key={lead.id}
                        onClick={() => toggleLeadSelection(lead.id)}
                        className={`px-4 py-3 flex items-center justify-between gap-4 cursor-pointer transition-colors ${
                          isChecked
                            ? 'bg-amber-500/[0.06]'
                            : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="mt-0.5">
                            {isChecked ? (
                              <CheckSquare className="w-4 h-4 text-[#E5B842]" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-400" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                                {lead.companyName}
                              </span>
                              <span className="text-[11px] font-mono text-sky-600 dark:text-sky-400">
                                {lead.status}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                              {lead.formattedPhone} · Attempts: {lead.callAttempts} · Last Called:{' '}
                              {lead.lastCalledDate
                                ? lead.lastCalledDate.slice(0, 10)
                                : 'N/A'}{' '}
                              · Follow-Up:{' '}
                              {lead.nextFollowUpDate
                                ? lead.nextFollowUpDate.slice(0, 10)
                                : 'Unscheduled'}
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                            {lead.assignedRepName
                              ? lead.assignedRepName.split(' (')[0]
                              : 'Unassigned'}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400">
                            {lead.assignedRepEmail || '—'}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Section 2: Daily Batch Release Override */}
          <div className="pt-4 border-t border-slate-200 dark:border-white/10 space-y-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                2. Daily Batch Release Override (Mid-Day Rep Departure)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                If a sales rep leaves mid-day after claiming a 3,000-lead batch, manually release their uncalled{' '}
                <code className="font-mono">FRESH</code> leads back to the global pool immediately without waiting for the 11:59 PM cron job.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {releasableBatches.length === 0 ? (
                <div className="col-span-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10 text-xs text-slate-500 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    All active batches have already been released or have 0 uncalled FRESH leads remaining.
                  </span>
                </div>
              ) : (
                releasableBatches.map((batch) => {
                  const uncalledCount = leads.filter(
                    (l) =>
                      l.assignedBatchId === batch.batchId &&
                      l.status === 'FRESH'
                  ).length;

                  return (
                    <div
                      key={batch.batchId}
                      className="p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10 flex flex-col justify-between gap-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-900 dark:text-white">
                            Batch #{batch.batchNumber} ({batch.batchId})
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            Claimed By:{' '}
                            <strong className="text-slate-800 dark:text-slate-200">
                              {batch.claimedByName
                                ? batch.claimedByName.split(' (')[0]
                                : 'Unclaimed (Allocated)'}
                            </strong>
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-amber-600 dark:text-amber-400">
                          {uncalledCount} uncalled FRESH
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Dialed: {batch.completedCallsCount} /{' '}
                          {batch.totalLeads.toLocaleString()}
                        </span>
                        <span>Status: {batch.status}</span>
                      </div>

                      <button
                        type="button"
                        data-testid={`override-release-batch-${batch.batchNumber}`}
                        disabled={releasingBatchId === batch.batchId}
                        onClick={() => handleExecuteBatchOverride(batch.batchId)}
                        className="w-full py-2 px-3 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-700 dark:text-amber-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <Unlock className="w-3.5 h-3.5 text-amber-500" />
                        <span>
                          {releasingBatchId === batch.batchId
                            ? 'Releasing Uncalled Leads...'
                            : `Release Batch #${batch.batchNumber} Uncalled Leads Now`}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#0D1017] flex items-center justify-between">
          <span className="text-[11px] font-mono text-slate-500">
            Audit Trail Hook: <code className="font-mono">logLeadEvent()</code> &rarr;{' '}
            <code className="font-mono">audit_logs</code>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-slate-200 dark:border-white/15 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
