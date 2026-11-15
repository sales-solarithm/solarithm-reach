'use client';

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  X,
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRightLeft,
  FileWarning,
  Layers,
  History,
} from 'lucide-react';
import {
  DuplicateResolutionMode,
  LeadRecord,
  RawSheetRow,
  SanitizedRowItem,
} from '@/lib/types';
import {
  PreFlightIngestionAudit,
  mergeDuplicateLeadRecord,
  runPreFlightIngestionCheck,
} from '@/lib/leadStore';
import { sanitizeFirestorePayload } from '@/lib/firestoreSanitizer';
import {
  EXCEL_STREAM_CHUNK_SIZE,
  ExcelWorkerProgressEvent,
  PartialFailureCommitReport,
  commitIngestionIn500OpBatches,
  queryFirestoreDeduplicationBatched,
  streamSanitizeAndAuditRows,
} from '@/lib/workers/excelProcessor.worker';
import {
  EXCEL_TEMPLATE_HEADERS,
  EmployeeMatchCandidate,
  buildEmployeeMatchPool,
  buildLeadRecordFromSanitizedRowPure,
  computePreFlightBreakdownPure,
  extractExcelRowFieldsNormalized,
} from '@/lib/historicalImportParser';
import { getActiveSalesReps } from '@/lib/employeeQueries';

export { EXCEL_TEMPLATE_HEADERS };

export interface ExcelCommitMetadata {
  importBatchId: string;
  fileName: string;
  preOverwriteSnapshots: LeadRecord[];
  commitResult: PartialFailureCommitReport;
}

interface ExcelUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingLeads: LeadRecord[];
  isOwnerTier?: boolean;
  currentUser?: { email: string; name: string } | null;
  onCommitIngestion: (
    newLeads: LeadRecord[],
    updatedLeads: LeadRecord[],
    meta?: ExcelCommitMetadata
  ) => void;
}

export function ExcelUploadModal({
  isOpen,
  onClose,
  existingLeads,
  isOwnerTier = true,
  currentUser = null,
  onCommitIngestion,
}: ExcelUploadModalProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [workerProgress, setWorkerProgress] = useState<ExcelWorkerProgressEvent | null>(null);
  const [auditResult, setAuditResult] = useState<PreFlightIngestionAudit | null>(null);
  const [resolutionMode, setResolutionMode] = useState<DuplicateResolutionMode>('SKIP');
  const [reviewDecisions, setReviewDecisions] = useState<Record<number, boolean>>({});
  const [partialFailureResult, setPartialFailureResult] =
    useState<PartialFailureCommitReport | null>(null);
  const [employeePool, setEmployeePool] = useState<EmployeeMatchCandidate[]>(() =>
    buildEmployeeMatchPool([])
  );

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    getActiveSalesReps({ includeOwners: true })
      .then((reps) => {
        if (isMounted) {
          setEmployeePool(buildEmployeeMatchPool(reps));
        }
      })
      .catch(() => {
        // Fallback pool already contains canonical Nexus employees
      });
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const preFlightBreakdown = useMemo(() => {
    if (!auditResult) return null;
    return computePreFlightBreakdownPure({
      validFreshLeads: auditResult.validFreshLeads,
      duplicatesCount: auditResult.duplicatesDetected.length,
      malformedCount: auditResult.malformedRows.length,
    });
  }, [auditResult]);

  if (!isOpen || !isOwnerTier) return null;

  /**
   * Generates and downloads an `.xlsx` workbook with the 10 standard headers:
   * 1. Company Name (Mandatory)
   * 2. Phone Number (Mandatory)
   * 3. Date of Calling (Optional)
   * 4. State (Optional)
   * 5. City (Optional)
   * 6. Email (Optional)
   * 7. Alternative Number (Optional)
   * 8. Status (Optional)
   * 9. Sales Person (Optional)
   * 10. Remarks (Optional)
   * (No dummy rows are pre-filled in the template.)
   */
  const handleDownloadTemplate = () => {
    const worksheet = XLSX.utils.aoa_to_sheet([[...EXCEL_TEMPLATE_HEADERS]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Solarithm_Leads_Template');
    XLSX.writeFile(workbook, 'Solarithm_Reach_Lead_Template.xlsx');
  };

  /**
   * Downloads a CSV error log for malformed/invalid rows.
   */
  const handleDownloadErrorLog = () => {
    if (!auditResult || auditResult.malformedRows.length === 0) return;
    const csvLines = [
      'Row Number,Company Name,Raw Phone Number,Raw Alternative Number,Error Reason',
      ...auditResult.malformedRows.map(
        (err) =>
          `${err.rowNumber},"${(err.companyName || '').replace(/"/g, '""')}","${(
            err.rawPhone || ''
          ).replace(/"/g, '""')}","${(err.rawAltPhone || '').replace(/"/g, '""')}","${err.reason.replace(
            /"/g,
            '""'
          )}"`
      ),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Solarithm_Ingestion_Malformed_Errors.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /**
   * Downloads the atomic partial-failure log detailing unprocessed rows when an import fails midway.
   */
  const handleDownloadPartialFailureLog = () => {
    if (!partialFailureResult || partialFailureResult.unprocessedRecords.length === 0) return;
    const csvLines = [
      'Unprocessed Index,Lead ID,Company Name,Phone Number,Failure Reason',
      ...partialFailureResult.unprocessedRecords.map(
        (item, idx) =>
          `${idx + 1},"${item.id}","${item.companyName.replace(
            /"/g,
            '""'
          )}","${item.phoneNumber}","${(partialFailureResult.errorReason || 'Mid-import batch failure').replace(/"/g, '""')}"`
      ),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Partial_Import_Unprocessed_${partialFailureResult.importBatchId}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /**
   * Executes streamed 500-row chunked sanitization, historical status/rep enrichment, and deduplication.
   */
  const executeAuditOnRows = async (rows: RawSheetRow[], label: string) => {
    setFileName(label);
    setIsAuditing(true);
    setPartialFailureResult(null);
    setWorkerProgress({
      percentComplete: 0,
      processedRows: 0,
      totalRows: rows.length,
      currentChunkIndex: 0,
      totalChunks: Math.max(1, Math.ceil(rows.length / EXCEL_STREAM_CHUNK_SIZE)),
      validFreshCount: 0,
      duplicatesFound: 0,
      malformedRows: 0,
    });

    try {
      const enrichOpts = {
        employees: employeePool,
        uploaderUser: currentUser,
      };

      const res = await streamSanitizeAndAuditRows(
        rows,
        existingLeads,
        (progress) => {
          setWorkerProgress(progress);
        },
        0,
        enrichOpts
      );

      setAuditResult(res);
      const hasHistoricalUpdatesInDups = res.duplicatesDetected.some(
        (d) =>
          d.incoming.isHistoricalCalled ||
          (d.incoming.importedStatus && d.incoming.importedStatus !== 'FRESH')
      );
      if (hasHistoricalUpdatesInDups) {
        setResolutionMode('OVERWRITE');
      } else {
        setResolutionMode('SKIP');
      }

      const initialDecisions: Record<number, boolean> = {};
      for (const dup of res.duplicatesDetected) {
        initialDecisions[dup.rowNumber] = Boolean(dup.incoming.isHistoricalCalled);
      }
      setReviewDecisions(initialDecisions);
    } finally {
      setIsAuditing(false);
    }
  };

  const processFileObject = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const formattedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: true,
    });

    const mappedRows: RawSheetRow[] = formattedRows.map((row, idx) =>
      extractExcelRowFieldsNormalized(row, rawRows[idx], idx + 2)
    );

    await executeAuditOnRows(mappedRows, file.name);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFileObject(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await processFileObject(file);
  };

  const buildIngestedLeadRecord = (
    item: SanitizedRowItem,
    indexOffset: number,
    importBatchId: string,
    nowIso: string
  ): LeadRecord => {
    const built = buildLeadRecordFromSanitizedRowPure(item, {
      id: `ingested-${Date.now()}-${indexOffset}`,
      importBatchId,
      nowIso,
      employees: employeePool,
      uploaderUser: currentUser,
    });
    return sanitizeFirestorePayload(built);
  };

  const handleCommit = async () => {
    if (!auditResult) return;
    setIsCommitting(true);

    let shouldCloseModal = false;
    try {
      const nowIso = new Date().toISOString();
      const datePart = nowIso.slice(0, 10).replace(/-/g, '_');
      const importBatchId = `IMP_${datePart}_${String(Date.now()).slice(-5)}`;

      const newLeads: LeadRecord[] = auditResult.validFreshLeads.map((item, idx) =>
        buildIngestedLeadRecord(item, idx, importBatchId, nowIso)
      );

      const updatedLeads: LeadRecord[] = [];
      const preOverwriteSnapshots: LeadRecord[] = [];

      for (const conflict of auditResult.duplicatesDetected) {
        const shouldOverwrite =
          resolutionMode === 'OVERWRITE' ||
          (resolutionMode === 'REVIEW' && reviewDecisions[conflict.rowNumber] === true);

        if (shouldOverwrite) {
          const existing = conflict.existingLead;
          preOverwriteSnapshots.push({ ...existing });
          const merged = mergeDuplicateLeadRecord(existing, conflict.incoming, nowIso, {
            employees: employeePool,
            uploaderUser: currentUser,
          });
          updatedLeads.push(sanitizeFirestorePayload(merged));
        }
      }

      const commitResult = await commitIngestionIn500OpBatches(
        [...newLeads, ...updatedLeads],
        importBatchId
      );

      if (commitResult.failedAtChunkIndex !== null) {
        setPartialFailureResult(commitResult);
        return;
      }

      shouldCloseModal = true;
      onCommitIngestion(newLeads, updatedLeads, {
        importBatchId,
        fileName: fileName || 'Sheet_Upload.xlsx',
        preOverwriteSnapshots,
        commitResult,
      });
    } finally {
      setIsCommitting(false);
      if (shouldCloseModal) {
        setAuditResult(null);
        setWorkerProgress(null);
        setFileName(null);
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="excel-upload-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs overflow-y-auto"
    >
      <div className="w-full max-w-4xl bg-white dark:bg-[#12151C] border border-slate-200 dark:border-white/10 rounded-lg shadow-2xl overflow-hidden my-8">
        {/* Top Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-[#E5B842]/15 border border-[#E5B842]/30 flex items-center justify-center">
              <FileSpreadsheet className="w-4 h-4 text-[#E5B842]" />
            </div>
            <div>
              <h2
                id="excel-upload-modal-title"
                className="text-sm font-semibold text-slate-900 dark:text-white tracking-tight"
              >
                Excel / CSV Lead Ingestion &amp; Historical Status Parser
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Supports untouched fresh leads &amp; historical sheets with Status, Sales Person &amp; Remarks
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="download-template-btn"
              onClick={handleDownloadTemplate}
              className="px-3 py-1.5 rounded border border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Download Template</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Excel ingestion modal"
              className="p-1.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 max-h-[78vh] overflow-y-auto">
          {/* Drag-and-Drop File Ingestion Zone */}
          <label
            htmlFor="excel-file-input"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border border-dashed rounded-md p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors ${
              isDragging
                ? 'border-[#E5B842] bg-[#E5B842]/10'
                : 'border-slate-300 dark:border-white/15 hover:border-[#E5B842] bg-slate-50/50 dark:bg-[#0B0D12]/60'
            }`}
          >
            <Upload className="w-5 h-5 text-[#E5B842] mb-2" />
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 break-words max-w-full px-2">
              {fileName
                ? `Loaded File: ${fileName}`
                : 'Drag and drop .xlsx or .csv file here, or click to browse'}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
              Headers: Company Name, Phone Number, Date of Calling, State, City, Email, Alternative Number, Status, Sales Person, Remarks
            </span>
            <input
              id="excel-file-input"
              data-testid="excel-file-input"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="sr-only"
            />
          </label>

          {/* Zerodha-Style Minimal Linear Progress Bar */}
          {workerProgress && isAuditing && (
            <div
              data-testid="excel-worker-progress-panel"
              className="p-3.5 rounded border border-slate-200 dark:border-white/10 bg-slate-50/90 dark:bg-[#0D1017] space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                  <Layers className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>
                    Pre-Flight Verification: Chunk {workerProgress.currentChunkIndex}/
                    {workerProgress.totalChunks}
                  </span>
                </div>
                <div className="font-mono text-xs font-bold text-[#B88917] dark:text-[#E5B842] tabular-nums">
                  {workerProgress.percentComplete}% ({workerProgress.processedRows.toLocaleString()}{' '}
                  / {workerProgress.totalRows.toLocaleString()} rows)
                </div>
              </div>

              <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                <div
                  role="progressbar"
                  aria-valuenow={workerProgress.percentComplete}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={{ width: `${workerProgress.percentComplete}%` }}
                  className="h-full bg-[#E5B842] transition-all duration-150"
                />
              </div>
            </div>
          )}

          {/* Atomic Partial-Failure Banner */}
          {partialFailureResult && partialFailureResult.failedAtChunkIndex !== null && (
            <div className="p-4 rounded border border-red-500/40 bg-red-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="space-y-1">
                <div className="font-bold text-red-600 dark:text-red-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    Mid-Import Atomic Boundary Halted ({partialFailureResult.committedChunksCount} chunks committed)
                  </span>
                </div>
                <p className="text-slate-600 dark:text-slate-300">
                  {partialFailureResult.committedRecordsCount.toLocaleString()} records committed atomically.{' '}
                  {partialFailureResult.unprocessedRecords.length.toLocaleString()} rows remained unprocessed.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDownloadPartialFailureLog}
                className="px-3 py-2 rounded bg-red-600 hover:bg-red-700 text-white font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Partial-Failure Log (.csv)</span>
              </button>
            </div>
          )}

          {/* Pre-Flight Import Preview Modal Breakdown (Zerodha Kite Style) */}
          {auditResult && preFlightBreakdown && (
            <div className="space-y-5">
              {/* 3 Primary Breakdown Cards: Fresh Untouched Leads, Historical / Already Called Leads, Duplicates Found */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                {/* Card 1: Fresh Untouched Leads */}
                <div
                  data-testid="summary-valid-fresh"
                  className="p-3.5 rounded border border-emerald-500/25 bg-emerald-500/[0.04]"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                      Fresh Untouched Leads
                    </span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  </div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                    {preFlightBreakdown.freshUntouchedCount.toLocaleString()}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    callAttempts = 0 · Enters fresh calling pool
                  </p>
                </div>

                {/* Card 2: Historical / Already Called Leads (with Status) */}
                <div
                  data-testid="summary-historical-called"
                  className="p-3.5 rounded border border-[#E5B842]/35 bg-[#E5B842]/[0.05]"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-[#E5B842]">
                      Historical / Already Called Leads (with Status)
                    </span>
                    <History className="w-4 h-4 text-[#E5B842]" />
                  </div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                    {preFlightBreakdown.historicalCalledCount.toLocaleString()}
                  </div>
                  {preFlightBreakdown.historicalCalledCount > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-1.5 text-[10px] font-mono">
                      {preFlightBreakdown.historicalBreakdown.INTERESTED > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-[#E5B842]/20 text-amber-800 dark:text-[#E5B842]">
                          Interested: {preFlightBreakdown.historicalBreakdown.INTERESTED}
                        </span>
                      )}
                      {preFlightBreakdown.historicalBreakdown.PROPOSAL_SHARED > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300">
                          Proposals: {preFlightBreakdown.historicalBreakdown.PROPOSAL_SHARED}
                        </span>
                      )}
                      {preFlightBreakdown.historicalBreakdown.FUTURE_REQUIREMENT > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
                          Future Req: {preFlightBreakdown.historicalBreakdown.FUTURE_REQUIREMENT}
                        </span>
                      )}
                      {preFlightBreakdown.historicalBreakdown.DIDNT_RECEIVE > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-700 dark:text-slate-300">
                          Didnt Receive: {preFlightBreakdown.historicalBreakdown.DIDNT_RECEIVE}
                        </span>
                      )}
                      {preFlightBreakdown.historicalBreakdown.SWITCH_OFF > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-700 dark:text-slate-300">
                          Switch Off: {preFlightBreakdown.historicalBreakdown.SWITCH_OFF}
                        </span>
                      )}
                      {preFlightBreakdown.historicalBreakdown.NOT_INTERESTED +
                        preFlightBreakdown.historicalBreakdown.NOT_A_SOLAR_COMPANY +
                        preFlightBreakdown.historicalBreakdown.CLOSED_WON +
                        preFlightBreakdown.historicalBreakdown.LEAD_LOST >
                        0 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-600 dark:text-slate-400">
                          Archived/Closed:{' '}
                          {preFlightBreakdown.historicalBreakdown.NOT_INTERESTED +
                            preFlightBreakdown.historicalBreakdown.NOT_A_SOLAR_COMPANY +
                            preFlightBreakdown.historicalBreakdown.CLOSED_WON +
                            preFlightBreakdown.historicalBreakdown.LEAD_LOST}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Interested, Proposals, Future Req, Retry &amp; Archived
                    </p>
                  )}
                </div>

                {/* Card 3: Duplicates Found */}
                <div
                  data-testid="summary-duplicates-detected"
                  className="p-3.5 rounded border border-amber-500/25 bg-amber-500/[0.04]"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                      Duplicates Found
                    </span>
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="flex items-baseline justify-between mt-1">
                    <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                      {preFlightBreakdown.duplicatesCount.toLocaleString()}
                    </span>
                    {auditResult.malformedRows.length > 0 && (
                      <span
                        data-testid="summary-malformed-rows"
                        className="text-[11px] font-mono text-red-600 dark:text-red-400"
                      >
                        Malformed: {auditResult.malformedRows.length}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Select &ldquo;Overwrite Existing Leads&rdquo; below to update status sheets
                  </p>
                </div>
              </div>

              {/* Warning Banner if PROPOSAL_SHARED / FUTURE_REQUIREMENT had blank Sales Person */}
              {preFlightBreakdown.repFallbackWarningsCount > 0 && (
                <div
                  data-testid="rep-fallback-warning-banner"
                  className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <strong>Sales Person Blank Warning:</strong>{' '}
                    {preFlightBreakdown.repFallbackWarningsCount} row(s) with status{' '}
                    <code className="font-mono">Proposal Shared</code> or{' '}
                    <code className="font-mono">Future Requirement</code> had no Sales Person specified in Excel and will be assigned to uploader{' '}
                    <strong>{currentUser?.name || currentUser?.email || 'Current User'}</strong>.
                  </div>
                </div>
              )}

              {/* Duplicate Conflict Resolution Policy */}
              {auditResult.duplicatesDetected.length > 0 && (
                <div className="p-4 rounded border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#0B0D12] space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        Duplicate Handling Actions
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {auditResult.duplicatesDetected.length.toLocaleString()} conflicting record(s) matched existing pipeline leads
                      </p>
                    </div>

                    <div
                      role="group"
                      aria-label="Duplicate Resolution Mode"
                      className="flex items-center gap-1.5 p-1 rounded bg-slate-200/70 dark:bg-[#161A23]"
                    >
                      <button
                        type="button"
                        data-testid="mode-skip-duplicates"
                        onClick={() => setResolutionMode('SKIP')}
                        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                          resolutionMode === 'SKIP'
                            ? 'bg-white dark:bg-[#252B39] text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                        }`}
                      >
                        Skip Duplicates (Default)
                      </button>
                      <button
                        type="button"
                        data-testid="mode-overwrite-duplicates"
                        onClick={() => setResolutionMode('OVERWRITE')}
                        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                          resolutionMode === 'OVERWRITE'
                            ? 'bg-white dark:bg-[#252B39] text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                        }`}
                      >
                        Overwrite Existing Leads
                      </button>
                      <button
                        type="button"
                        data-testid="mode-review-duplicates"
                        onClick={() => setResolutionMode('REVIEW')}
                        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1 cursor-pointer ${
                          resolutionMode === 'REVIEW'
                            ? 'bg-[#E5B842] text-slate-950 font-semibold shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                        }`}
                      >
                        <ArrowRightLeft className="w-3 h-3" />
                        <span>Side-by-Side Review Table</span>
                      </button>
                    </div>
                  </div>

                  {resolutionMode === 'SKIP' && (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      Retains existing database records, call notes, and rep assignments untouched; commits only the{' '}
                      <strong className="text-slate-900 dark:text-white">
                        {auditResult.validFreshLeads.length.toLocaleString()} new leads
                      </strong>
                      .
                    </p>
                  )}

                  {resolutionMode === 'OVERWRITE' && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Updates existing leads with incoming metadata (<code className="font-mono">state</code>,{' '}
                      <code className="font-mono">city</code>, <code className="font-mono">email</code>,{' '}
                      <code className="font-mono">altNumber</code>) and applies any historical{' '}
                      <code className="font-mono">Status</code>, <code className="font-mono">Sales Person</code>,{' '}
                      follow-up schedules, and <code className="font-mono">Remarks</code> from the uploaded sheet.
                    </p>
                  )}

                  {/* Side-by-Side Review Table */}
                  {resolutionMode === 'REVIEW' && (
                    <div
                      data-testid="side-by-side-review-table"
                      className="overflow-x-auto border border-slate-200 dark:border-white/10 rounded max-h-60 overflow-y-auto"
                    >
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-100 dark:bg-[#151922] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-white/10">
                            <th className="py-2 px-3 font-semibold">Row / Match</th>
                            <th className="py-2 px-3 font-semibold">
                              Existing Lead (Status · Original Rep · Last Call Date)
                            </th>
                            <th className="py-2 px-3 font-semibold">Incoming Sheet Row Data</th>
                            <th className="py-2 px-3 font-semibold text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-white/5">
                          {auditResult.duplicatesDetected.slice(0, 50).map((dup) => {
                            const isOverwriteRow = reviewDecisions[dup.rowNumber] === true;
                            return (
                              <tr
                                key={dup.rowNumber}
                                className="bg-white dark:bg-[#10131A] hover:bg-slate-50 dark:hover:bg-white/[0.02]"
                              >
                                <td className="py-2 px-3 align-top font-mono">
                                  <div className="font-semibold text-slate-800 dark:text-slate-200">
                                    Row #{dup.rowNumber}
                                  </div>
                                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                                    {dup.matchReason}
                                  </div>
                                </td>
                                <td className="py-2 px-3 align-top">
                                  <div className="font-semibold text-slate-900 dark:text-white">
                                    {dup.existingLead.companyName}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-500">
                                    {dup.existingLead.formattedPhone} · Status:{' '}
                                    <span className="text-[#B88917] dark:text-[#E5B842]">
                                      {dup.existingLead.status}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-500">
                                    Rep: {dup.existingLead.assignedRepName || 'Unassigned'} · Last Call:{' '}
                                    {dup.existingLead.lastCalledDate
                                      ? dup.existingLead.lastCalledDate.slice(0, 10)
                                      : 'Never'}
                                  </div>
                                </td>
                                <td className="py-2 px-3 align-top">
                                  <div className="font-semibold text-slate-900 dark:text-white">
                                    {dup.incoming.companyName}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-500">
                                    {dup.incoming.formattedPhone}
                                    {dup.incoming.importedStatus && dup.incoming.importedStatus !== 'FRESH'
                                      ? ` · Status: ${dup.incoming.importedStatus}`
                                      : ''}
                                  </div>
                                  <div className="text-[11px] text-slate-500">
                                    {dup.incoming.assignedRepName
                                      ? `Rep: ${dup.incoming.assignedRepName} · `
                                      : ''}
                                    {dup.incoming.city || '—'}, {dup.incoming.state || '—'}
                                  </div>
                                </td>
                                <td className="py-2 px-3 align-top text-right">
                                  <div className="inline-flex rounded border border-slate-200 dark:border-white/10 overflow-hidden">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setReviewDecisions((prev) => ({
                                          ...prev,
                                          [dup.rowNumber]: false,
                                        }))
                                      }
                                      className={`px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                                        !isOverwriteRow
                                          ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900'
                                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                                      }`}
                                    >
                                      Skip
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setReviewDecisions((prev) => ({
                                          ...prev,
                                          [dup.rowNumber]: true,
                                        }))
                                      }
                                      className={`px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                                        isOverwriteRow
                                          ? 'bg-[#7C6328] text-white'
                                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                                      }`}
                                    >
                                      Overwrite
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Preview of Valid Leads + Malformed Rows */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Valid Leads Table (Fresh + Historical) */}
                <div className="border border-slate-200 dark:border-white/10 rounded overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 dark:bg-[#151922] border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Ready to Commit ({auditResult.validFreshLeads.length.toLocaleString()} Leads)
                    </span>
                    <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                      {preFlightBreakdown.freshUntouchedCount} Fresh ·{' '}
                      {preFlightBreakdown.historicalCalledCount} Historical
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
                    {auditResult.validFreshLeads.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-400">
                        No valid new leads in this upload.
                      </div>
                    ) : (
                      auditResult.validFreshLeads.slice(0, 60).map((fresh) => (
                        <div
                          key={fresh.rowNumber}
                          className="px-4 py-2 text-xs flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 dark:text-white truncate flex items-center gap-1.5">
                              <span>{fresh.companyName}</span>
                              {fresh.isHistoricalCalled && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#E5B842]/15 text-amber-700 dark:text-[#E5B842]">
                                  {fresh.importedStatus}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">
                              Row #{fresh.rowNumber} · {fresh.city || '—'}, {fresh.state || '—'}
                              {fresh.assignedRepName ? ` · Rep: ${fresh.assignedRepName}` : ''}
                              {fresh.remarks ? ` · Note: "${fresh.remarks}"` : ''}
                            </div>
                          </div>
                          <div className="text-right font-mono shrink-0">
                            <div className="text-emerald-600 dark:text-emerald-400 font-semibold">
                              {fresh.formattedPhone}
                            </div>
                            <div className="text-[10px] text-slate-400">DB: {fresh.phoneNumber}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Malformed Rows List */}
                <div className="border border-slate-200 dark:border-white/10 rounded overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 dark:bg-[#151922] border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <FileWarning className="w-3.5 h-3.5 text-red-500" />
                      <span>
                        Malformed / Invalid Rows ({auditResult.malformedRows.length.toLocaleString()})
                      </span>
                    </span>
                    {auditResult.malformedRows.length > 0 && (
                      <button
                        type="button"
                        data-testid="download-error-csv-btn"
                        onClick={handleDownloadErrorLog}
                        className="text-[11px] font-medium text-red-600 dark:text-red-400 hover:underline cursor-pointer"
                      >
                        Download Error CSV
                      </button>
                    )}
                  </div>
                  <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
                    {auditResult.malformedRows.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-400">
                        Zero malformed rows detected.
                      </div>
                    ) : (
                      auditResult.malformedRows.slice(0, 60).map((err) => (
                        <div key={err.rowNumber} className="px-4 py-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-800 dark:text-slate-200">
                              Row #{err.rowNumber}: {err.companyName}
                            </span>
                            <span className="font-mono text-[11px] text-red-500">
                              Raw: &quot;{err.rawPhone || 'empty'}&quot;
                            </span>
                          </div>
                          <div className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">
                            {err.reason}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sticky Footer */}
        <div className="sticky bottom-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-4 sm:px-5 py-3.5 bg-slate-50 dark:bg-[#0E1117] border-t border-slate-200 dark:border-white/10 shrink-0">
          <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
            {auditResult && preFlightBreakdown
              ? `Ready to commit ${preFlightBreakdown.freshUntouchedCount.toLocaleString()} fresh untouched + ${preFlightBreakdown.historicalCalledCount.toLocaleString()} historical leads`
              : 'Upload an .xlsx or .csv file to run pre-flight normalization and historical status audit'}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 sm:py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="commit-excel-ingestion-btn"
              disabled={!auditResult || isCommitting}
              onClick={handleCommit}
              className="px-4 py-2 sm:py-1.5 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] disabled:opacity-40 text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              {isCommitting ? 'Committing Batches...' : 'Confirm Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

