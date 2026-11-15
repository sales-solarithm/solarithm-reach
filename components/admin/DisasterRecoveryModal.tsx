'use client';

import React, { useState } from 'react';
import {
  X,
  Download,
  RotateCcw,
  DatabaseBackup,
  CheckCircle2,
  AlertTriangle,
  FileArchive,
  History,
} from 'lucide-react';
import { BatchRecord, LeadRecord } from '@/lib/types';
import { AuditLogRecord } from '@/types/audit';
import {
  ImportBatchSnapshotRecord,
  downloadPipelineSnapshotGzip,
  formatSnapshotFilename,
} from '@/scripts/firestoreBackup';

interface DisasterRecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  leads: LeadRecord[];
  batches: BatchRecord[];
  auditLogs: AuditLogRecord[];
  importHistory: ImportBatchSnapshotRecord[];
  onRollbackImportBatch: (importBatchId: string) => Promise<void>;
}

export function DisasterRecoveryModal({
  isOpen,
  onClose,
  leads,
  batches,
  auditLogs,
  importHistory,
  onRollbackImportBatch,
}: DisasterRecoveryModalProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExportMeta, setLastExportMeta] = useState<{
    fileName: string;
    byteSize: number;
    isGzipCompressed: boolean;
  } | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  if (!isOpen) return null;

  const todaySnapshotName = formatSnapshotFilename(new Date());

  const handleExportSnapshot = async () => {
    setIsExporting(true);
    try {
      const meta = await downloadPipelineSnapshotGzip(
        leads,
        batches,
        auditLogs,
        new Date()
      );
      setLastExportMeta(meta);
    } finally {
      setIsExporting(false);
    }
  };

  const handleRollbackClick = async (importBatchId: string) => {
    setRollingBackId(importBatchId);
    try {
      await onRollbackImportBatch(importBatchId);
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="disaster-recovery-modal-title"
      data-testid="disaster-recovery-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs overflow-y-auto"
    >
      <div className="w-full max-w-4xl bg-white dark:bg-[#12151C] border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#E5B842]/15 border border-[#E5B842]/30 flex items-center justify-center">
              <DatabaseBackup className="w-4 h-4 text-[#E5B842]" />
            </div>
            <div>
              <h2
                id="disaster-recovery-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white"
              >
                Disaster Recovery, Pipeline GZIP Snapshot &amp; One-Click Import Rollback
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Automated snapshot exporter (<code className="font-mono">{todaySnapshotName}</code>) &amp; atomic rollback by <code className="font-mono">importBatchId</code>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Disaster Recovery Modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 max-h-[78vh] overflow-y-auto">
          {/* Section 1: Daily Pipeline JSON.GZ Snapshot Exporter */}
          <div className="p-5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#0B0D12] space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <FileArchive className="w-4 h-4 text-[#E5B842]" />
                  <span>Daily Pipeline JSON.GZ Snapshot Archive</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Exports complete Firestore collections (<code className="font-mono">leads</code>,{' '}
                  <code className="font-mono">batches</code>, and{' '}
                  <code className="font-mono">audit_logs</code>) into a compressed{' '}
                  <code className="font-mono">{todaySnapshotName}</code> archive for Cloud Storage / local disaster recovery.
                </p>
              </div>

              <button
                type="button"
                data-testid="download-snapshot-gz-btn"
                disabled={isExporting}
                onClick={handleExportSnapshot}
                className="px-4 py-2.5 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-2 transition-colors shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-4 h-4 text-[#E5B842]" />
                <span>
                  {isExporting ? 'Compressing Snapshot...' : `Export ${todaySnapshotName}`}
                </span>
              </button>
            </div>

            {/* Collection Telemetry Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-white dark:bg-[#12161F] border border-slate-200 dark:border-white/10">
                <div className="text-[11px] text-slate-500">Collection: leads</div>
                <div className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                  {leads.length.toLocaleString()} docs
                </div>
              </div>
              <div className="p-3 rounded-lg bg-white dark:bg-[#12161F] border border-slate-200 dark:border-white/10">
                <div className="text-[11px] text-slate-500">Collection: batches</div>
                <div className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                  {batches.length.toLocaleString()} docs
                </div>
              </div>
              <div className="p-3 rounded-lg bg-white dark:bg-[#12161F] border border-slate-200 dark:border-white/10">
                <div className="text-[11px] text-slate-500">Collection: audit_logs</div>
                <div className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                  {auditLogs.length.toLocaleString()} docs
                </div>
              </div>
            </div>

            {lastExportMeta && (
              <div
                data-testid="snapshot-export-confirmation"
                className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>
                    Snapshot generated: <code className="font-mono">{lastExportMeta.fileName}</code>
                  </span>
                </div>
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {(lastExportMeta.byteSize / 1024).toFixed(1)} KB ·{' '}
                  {lastExportMeta.isGzipCompressed ? 'GZIP Stream Compressed' : 'JSON Archive'}
                </span>
              </div>
            )}
          </div>

          {/* Section 2: One-Click Import Rollback by `importBatchId` */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <History className="w-4 h-4 text-[#E5B842]" />
                  <span>One-Click Rollback by Import Batch ID (`importBatchId`)</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Reverts accidental bulk overwrites or corrupted Excel imports by removing newly inserted leads and restoring pre-overwrite lead snapshots.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {importHistory.length} Recorded Import Batches
              </span>
            </div>

            {importHistory.length === 0 ? (
              <div className="p-8 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-[#0B0D12] text-center space-y-1.5">
                <AlertTriangle className="w-5 h-5 text-slate-400 mx-auto" />
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  No Bulk Excel Imports Recorded in This Session Yet
                </div>
                <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                  Every Excel / CSV ingestion commit automatically tags records with a unique{' '}
                  <code className="font-mono">importBatchId</code> and captures pre-overwrite snapshots so you can roll back in one click.
                </p>
              </div>
            ) : (
              <div className="border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 dark:bg-[#151922] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-white/10">
                      <th className="py-2.5 px-3 font-semibold">Import Batch ID</th>
                      <th className="py-2.5 px-3 font-semibold">Source Sheet &amp; Actor</th>
                      <th className="py-2.5 px-3 font-semibold">Inserted / Overwritten</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Emergency Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-white/5">
                    {importHistory.map((item) => {
                      const isRolledBack = Boolean(item.rolledBackAt);
                      return (
                        <tr
                          key={item.importBatchId}
                          className="bg-white dark:bg-[#10131A] hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                        >
                          <td className="py-3 px-3 font-mono align-top">
                            <div className="font-semibold text-[#B88917] dark:text-[#E5B842]">
                              {item.importBatchId}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {item.importedAt.slice(0, 19).replace('T', ' ')} UTC
                            </div>
                          </td>
                          <td className="py-3 px-3 align-top">
                            <div className="font-medium text-slate-900 dark:text-white">
                              {item.fileName}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              By {item.importedByName} ({item.importedByEmail})
                            </div>
                          </td>
                          <td className="py-3 px-3 font-mono align-top">
                            <div className="text-emerald-600 dark:text-emerald-400">
                              +{item.insertedLeadIds.length.toLocaleString()} inserted
                            </div>
                            <div className="text-[11px] text-amber-600 dark:text-amber-400">
                              {item.overwrittenLeadCount.toLocaleString()} overwritten snapshots saved
                            </div>
                          </td>
                          <td className="py-3 px-3 align-top text-right">
                            {isRolledBack ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/5 text-[11px] font-mono text-slate-500">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                <span>Rolled Back</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                data-testid={`rollback-import-btn-${item.importBatchId}`}
                                disabled={rollingBackId === item.importBatchId}
                                onClick={() => handleRollbackClick(item.importBatchId)}
                                className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/35 text-red-600 dark:text-red-400 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>
                                  {rollingBackId === item.importBatchId
                                    ? 'Rolling Back...'
                                    : 'Rollback Import Batch'}
                                </span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-50 dark:bg-[#0E1117] border-t border-slate-200 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Firestore Batch Limit: 500 operations per atomic commit
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
