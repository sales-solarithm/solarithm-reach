export type BatchStatus = 'AVAILABLE' | 'IN_PROGRESS' | 'CLOSED';

export interface DailyBatchDocument {
  batchId: string; // Formatted: BATCH_YYYY_MM_DD_XX, e.g., BATCH_2026_10_28_01
  batchNumber: number; // 1, 2, 3...
  date: string; // ISO date string YYYY-MM-DD
  totalLeads: number; // Default: 3,000
  claimedByEmail: string | null; // Null when available
  claimedByName: string | null; // Null when available
  claimedAt: string | null; // ISO timestamp
  status: BatchStatus;
  completedCallsCount: number; // Live counter incremented as calls are logged
  remainingLeads?: number; // Live counter decremented by 1 whenever a FRESH lead in this batch is called
  // Extended operational fields for stratified tracking & nightly sweep audit
  totalLeadsAssigned?: number;
  untouchedCount?: number;
  retryCount?: number;
  leadIds?: string[];
  closedAt?: string | null;
  uncalledReturnedCount?: number;
  createdAt?: string;
}

export interface CooldownSweepSummary {
  sweptAt: string;
  cooldownClearedCount: number;
  didntReceiveDeadCount: number;
  switchOffDeadCount: number;
  clearedLeadIds: string[];
  retiredDeadLeadIds: string[];
  chunkWriteOperations: number;
}

export interface NightlySweepSummary {
  sweptAt: string;
  date: string;
  closedBatchesCount: number;
  totalDialedCallsCount: number;
  uncalledLeadsReleasedCount: number;
  closedBatchIds: string[];
  chunkWriteOperations: number;
  cooldownSweep?: CooldownSweepSummary;
}

/**
 * Formats a standardized batchId: BATCH_YYYY_MM_DD_XX (e.g., BATCH_2026_10_28_01)
 */
export function formatBatchId(dateStr: string, batchNumber: number): string {
  const sanitizedDate = dateStr.slice(0, 10).replace(/-/g, '_');
  const paddedNumber = String(batchNumber).padStart(2, '0');
  return `BATCH_${sanitizedDate}_${paddedNumber}`;
}

export interface DailyStateMetaDocument {
  activeDate: string; // "YYYY-MM-DD" evaluated strictly in IST Asia/Kolkata
  isProcessing: boolean;
  lastResetAt: string; // ISO timestamp
}

/**
 * Returns YYYY-MM-DD evaluated strictly in IST (Asia/Kolkata) timezone:
 * `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)`
 */
export function getTodayIstDateString(now: Date = new Date()): string {
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
      return formatted;
    }
  } catch {
    // Fallback to UTC+5:30 offset calculation
  }
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().slice(0, 10);
}
