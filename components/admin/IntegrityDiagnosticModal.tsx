'use client';

import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  ShieldAlert,
  Sparkles,
  UserX,
  Wrench,
  X,
} from 'lucide-react';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import { runDataIntegrityDiagnostics } from '@/lib/integrityChecker';

interface IntegrityDiagnosticModalProps {
  isOpen: boolean;
  onClose: () => void;
  leads: LeadRecord[];
  authorizedUsers: AuthorizedUser[];
  onFixOrphanedAssignments: () => Promise<number>;
  onEnforceDeadStatusCaps: () => Promise<number>;
  onInjectTestAnomalies: () => void;
}

export function IntegrityDiagnosticModal({
  isOpen,
  onClose,
  leads,
  authorizedUsers,
  onFixOrphanedAssignments,
  onEnforceDeadStatusCaps,
  onInjectTestAnomalies,
}: IntegrityDiagnosticModalProps) {
  const [isRemediatingOrphans, setIsRemediatingOrphans] = useState(false);
  const [isRemediatingDeadCaps, setIsRemediatingDeadCaps] = useState(false);
  const [remediationBanner, setRemediationBanner] = useState<string | null>(
    null
  );

  const report = useMemo(
    () => runDataIntegrityDiagnostics(leads, authorizedUsers, new Date()),
    [leads, authorizedUsers]
  );

  if (!isOpen) return null;

  const handleFixOrphans = async () => {
    setIsRemediatingOrphans(true);
    try {
      const count = await onFixOrphanedAssignments();
      setRemediationBanner(
        `Remediated ${count} orphaned lead assignment(s): cleared rep email & moved uncalled leads to Fresh Pool.`
      );
    } finally {
      setIsRemediatingOrphans(false);
    }
  };

  const handleEnforceCaps = async () => {
    setIsRemediatingDeadCaps(true);
    try {
      const count = await onEnforceDeadStatusCaps();
      setRemediationBanner(
        `Enforced dead-status caps on ${count} lead(s): transitioned overdue counts to DIDNT_RECEIVE_DEAD / SWITCH_OFF_DEAD.`
      );
    } finally {
      setIsRemediatingDeadCaps(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="integrity-diagnostic-modal-title"
      data-testid="integrity-diagnostic-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div className="w-full max-w-4xl max-h-[90vh] rounded-2xl bg-white dark:bg-[#11151E] border border-slate-200 dark:border-white/15 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center shrink-0">
              <Activity className="w-5 h-5 text-[#E5B842]" />
            </div>
            <div>
              <h2
                id="integrity-diagnostic-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white"
              >
                Data Integrity Health Check &amp; Orphan Cleaner
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                On-demand diagnostic scanner for orphaned reps, dead-cap thresholds, overdue follow-ups (&gt;14d), and duplicate numbers
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="inject-test-anomalies-btn"
              onClick={() => {
                onInjectTestAnomalies();
                setRemediationBanner(
                  'Injected sample diagnostic anomalies (orphaned rep, >10 DIDNT_RECEIVE, >14d overdue follow-up) for verification.'
                );
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Seed Test Anomalies</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Integrity Diagnostic Modal"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {remediationBanner && (
            <div
              role="status"
              data-testid="integrity-remediation-banner"
              className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-xs font-medium flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{remediationBanner}</span>
              </div>
              <button
                type="button"
                onClick={() => setRemediationBanner(null)}
                className="text-[11px] underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* 4-Metric Diagnostic Summary Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Orphaned Assignments</span>
                <UserX className="w-4 h-4 text-amber-400" />
              </div>
              <div
                data-testid="diag-orphaned-count"
                className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1.5"
              >
                {report.orphanedLeads.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Assigned to deleted / revoked reps
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Unenforced Dead Caps</span>
                <ShieldAlert className="w-4 h-4 text-red-400" />
              </div>
              <div
                data-testid="diag-deadcap-count"
                className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1.5"
              >
                {report.invalidDeadCapLeads.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                NR &gt; 10 or SO &ge; 3 still active
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Expired Follow-Ups (&gt;14d)</span>
                <Clock className="w-4 h-4 text-sky-400" />
              </div>
              <div
                data-testid="diag-expired-count"
                className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1.5"
              >
                {report.expiredFollowUpLeads.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Overdue &gt; 14 days without call log
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0D1017] border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Duplicate Phone Collisions</span>
                <Copy className="w-4 h-4 text-purple-400" />
              </div>
              <div
                data-testid="diag-duplicate-count"
                className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1.5"
              >
                {report.duplicateNumberGroups.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Primary / Alt 10-digit overlaps
              </div>
            </div>
          </div>

          {/* 1-Click Remediation Action Bar */}
          <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-500/25 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                1-Click Automated Remediation Actions
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Executes atomic state reconciliation and appends immutable compliance entries to{' '}
                <code className="font-mono">audit_logs</code>.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                data-testid="fix-orphaned-assignments-btn"
                disabled={
                  report.orphanedLeads.length === 0 || isRemediatingOrphans
                }
                onClick={handleFixOrphans}
                className="px-3.5 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Wrench className="w-3.5 h-3.5 text-[#E5B842]" />
                <span>
                  {isRemediatingOrphans
                    ? 'Fixing Orphans...'
                    : `Fix Orphaned Assignments (${report.orphanedLeads.length})`}
                </span>
              </button>

              <button
                type="button"
                data-testid="enforce-dead-status-caps-btn"
                disabled={
                  report.invalidDeadCapLeads.length === 0 ||
                  isRemediatingDeadCaps
                }
                onClick={handleEnforceCaps}
                className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-white/10 dark:hover:bg-white/15 border border-slate-700 dark:border-white/15 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>
                  {isRemediatingDeadCaps
                    ? 'Enforcing Caps...'
                    : `Enforce Dead-Status Caps (${report.invalidDeadCapLeads.length})`}
                </span>
              </button>
            </div>
          </div>

          {/* Detailed Diagnostic Findings */}
          <div className="space-y-4">
            {/* 1. Orphaned Leads List */}
            <div className="rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0D1017] border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  1. Orphaned Rep Assignments ({report.orphanedLeads.length})
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  assignedRepEmail not in active config/roles
                </span>
              </div>
              {report.orphanedLeads.length === 0 ? (
                <div className="p-4 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Zero orphaned rep assignments detected.</span>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/5">
                  {report.orphanedLeads.map((item) => (
                    <div
                      key={item.lead.id}
                      className="px-4 py-2.5 flex items-center justify-between gap-4 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {item.lead.companyName}
                        </span>{' '}
                        <span className="font-mono text-slate-400">
                          ({item.lead.formattedPhone})
                        </span>
                        <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                          {item.reason}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        Status: {item.lead.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 2. Invalid Dead-Status Caps List */}
            <div className="rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0D1017] border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  2. Stuck Dead-Threshold Leads ({report.invalidDeadCapLeads.length})
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  didntReceiveCount &gt; 10 or switchOffCount &ge; 3
                </span>
              </div>
              {report.invalidDeadCapLeads.length === 0 ? (
                <div className="p-4 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>All retry counters comply with dead-lead thresholds.</span>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/5">
                  {report.invalidDeadCapLeads.map((item) => (
                    <div
                      key={item.lead.id}
                      className="px-4 py-2.5 flex items-center justify-between gap-4 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {item.lead.companyName}
                        </span>{' '}
                        <span className="font-mono text-slate-400">
                          ({item.lead.formattedPhone})
                        </span>
                        <div className="text-[11px] text-red-500 dark:text-red-400 mt-0.5">
                          {item.reason}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-amber-500">
                        Target &rarr; {item.expectedDeadStatus}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 3. Expired Follow-Ups (> 14 Days Overdue) */}
            <div className="rounded-xl border border-slate-200 dark:border-white/10 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0D1017] border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  3. Expired Follow-Ups Overdue &gt; 14 Days ({report.expiredFollowUpLeads.length})
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  nextFollowUpDate overdue &gt; 14d without recent call log
                </span>
              </div>
              {report.expiredFollowUpLeads.length === 0 ? (
                <div className="p-4 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Zero follow-ups overdue beyond 14 days.</span>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/5">
                  {report.expiredFollowUpLeads.map((item) => (
                    <div
                      key={item.lead.id}
                      className="px-4 py-2.5 flex items-center justify-between gap-4 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {item.lead.companyName}
                        </span>{' '}
                        <span className="font-mono text-slate-400">
                          ({item.lead.formattedPhone})
                        </span>
                        <div className="text-[11px] text-sky-600 dark:text-sky-400 mt-0.5">
                          Follow-up scheduled for {item.referenceDate.slice(0, 10)} ({item.daysOverdue} days overdue) · Rep:{' '}
                          {item.lead.assignedRepName || 'Unassigned'}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        {item.lead.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#0D1017] flex items-center justify-between">
          <span className="text-[11px] font-mono text-slate-500">
            Last scanned: {report.checkedAt.slice(0, 19).replace('T', ' ')} UTC
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-slate-200 dark:border-white/15 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
          >
            Close Report
          </button>
        </div>
      </div>
    </div>
  );
}
