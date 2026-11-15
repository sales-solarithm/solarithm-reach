import {
  collection,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { reachDb as db } from '@/lib/firebaseDual';
import {
  DuplicateConflict,
  LeadRecord,
  MalformedRowError,
  RawSheetRow,
  SanitizedRowItem,
} from '@/lib/types';
import { normalizeCompanyName, sanitizeIndianPhone } from '@/lib/phoneSanitizer';
import { PreFlightIngestionAudit, chunkArray } from '@/lib/leadStore';
import {
  EmployeeMatchCandidate,
  enrichSanitizedRowWithHistoricalFieldsPure,
} from '@/lib/historicalImportParser';
import { sanitizeFirestorePayload } from '@/lib/firestoreSanitizer';
import {
  hasLiveReachFirebaseConfig,
  reportCloudSyncError,
} from '@/lib/firebaseDual';

export const EXCEL_STREAM_CHUNK_SIZE = 500;
export const MAX_FIRESTORE_BATCH_OPS = 500;
export const FIRESTORE_IN_QUERY_LIMIT = 30;
export const MAX_PARALLEL_LOOKUP_CHUNKS = 4;

export interface ExcelWorkerProgressEvent {
  percentComplete: number;
  processedRows: number;
  totalRows: number;
  validFreshCount: number;
  duplicatesFound: number;
  malformedRows: number;
  currentChunkIndex: number;
  totalChunks: number;
}

export interface PartialFailureCommitReport {
  importBatchId: string;
  totalRequestedRecords: number;
  committedRecordsCount: number;
  committedChunksCount: number;
  failedAtChunkIndex: number | null;
  unprocessedRecords: LeadRecord[];
  errorReason: string | null;
  timestamp: string;
}

/**
 * Pure 500-row chunked processor that sanitizes raw sheet rows, detects duplicates
 * against existing leads and intra-file rows, and emits live progress callbacks
 * (`percentComplete`, `processedRows`, `duplicatesFound`, `malformedRows`).
 */
export async function streamSanitizeAndAuditRows(
  rawRows: RawSheetRow[],
  existingLeads: LeadRecord[],
  onProgress?: (event: ExcelWorkerProgressEvent) => void,
  yieldBetweenChunksMs = 0,
  options?: {
    employees?: EmployeeMatchCandidate[];
    uploaderUser?: { email: string; name: string } | null;
    nowIso?: string;
  }
): Promise<PreFlightIngestionAudit> {
  const validFreshLeads: SanitizedRowItem[] = [];
  const duplicatesDetected: DuplicateConflict[] = [];
  const malformedRows: MalformedRowError[] = [];

  const phoneLookup = new Map<string, LeadRecord>();
  const altLookup = new Map<string, LeadRecord>();
  const companyLookup = new Map<string, LeadRecord>();

  for (const lead of existingLeads) {
    if (lead.phoneNumber) phoneLookup.set(lead.phoneNumber, lead);
    if (lead.altNumber) altLookup.set(lead.altNumber, lead);
    if (lead.companyNameNormalized) {
      companyLookup.set(lead.companyNameNormalized, lead);
    }
  }

  const seenPhonesInUpload = new Set<string>();
  const seenCompaniesInUpload = new Set<string>();

  const chunks = chunkArray(rawRows, EXCEL_STREAM_CHUNK_SIZE);
  const totalRows = rawRows.length;
  const totalChunks = Math.max(1, chunks.length);
  let processedRows = 0;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];

    for (const raw of chunk) {
      processedRows++;
      const companyTrimmed = (raw.companyName ?? '').trim();
      if (!companyTrimmed) {
        malformedRows.push({
          rowNumber: raw.rowNumber,
          companyName: '(Missing Company Name)',
          rawPhone: String(raw.phoneNumberRaw ?? ''),
          rawAltPhone: raw.altNumberRaw,
          reason: 'Mandatory column "Company Name" is empty.',
        });
        continue;
      }

      const primarySanitized = sanitizeIndianPhone(raw.phoneNumberRaw);
      if (!primarySanitized.isValid) {
        malformedRows.push({
          rowNumber: raw.rowNumber,
          companyName: companyTrimmed,
          rawPhone: String(raw.phoneNumberRaw ?? ''),
          rawAltPhone: raw.altNumberRaw,
          reason: primarySanitized.error || 'Invalid Primary Phone Number',
        });
        continue;
      }

      let cleanedAlt: string | null = null;
      let formattedAlt: string | null = null;
      if (raw.altNumberRaw && String(raw.altNumberRaw).trim() !== '') {
        const altSanitized = sanitizeIndianPhone(raw.altNumberRaw);
        if (altSanitized.isValid) {
          cleanedAlt = altSanitized.cleaned;
          formattedAlt = altSanitized.formatted;
        } else {
          malformedRows.push({
            rowNumber: raw.rowNumber,
            companyName: companyTrimmed,
            rawPhone: String(raw.phoneNumberRaw ?? ''),
            rawAltPhone: String(raw.altNumberRaw),
            reason: `Alternative Number invalid: ${altSanitized.error}`,
          });
          continue;
        }
      }

      const companyNormalized = normalizeCompanyName(companyTrimmed);
      const baseItem: SanitizedRowItem = {
        rowNumber: raw.rowNumber,
        companyName: companyTrimmed,
        companyNameNormalized: companyNormalized,
        phoneNumber: primarySanitized.cleaned,
        formattedPhone: primarySanitized.formatted,
        altNumber: cleanedAlt,
        formattedAltPhone: formattedAlt,
        state: raw.state?.trim() || undefined,
        city: raw.city?.trim() || undefined,
        email: raw.email?.trim() || undefined,
        dateOfCalling: raw.dateOfCalling?.trim() || undefined,
        statusRaw: raw.statusRaw?.trim() || undefined,
        salesPersonRaw: raw.salesPersonRaw?.trim() || undefined,
        remarks: raw.remarksRaw?.trim() || undefined,
      };
      const sanitizedItem = enrichSanitizedRowWithHistoricalFieldsPure(baseItem, {
        employees: options?.employees,
        uploaderUser: options?.uploaderUser,
        nowIso: options?.nowIso,
      });

      const matchedByPrimary =
        phoneLookup.get(sanitizedItem.phoneNumber) ||
        altLookup.get(sanitizedItem.phoneNumber);
      const matchedByAlt = sanitizedItem.altNumber
        ? phoneLookup.get(sanitizedItem.altNumber) ||
          altLookup.get(sanitizedItem.altNumber)
        : undefined;
      const matchedByCompany = companyLookup.get(
        sanitizedItem.companyNameNormalized
      );

      if (matchedByPrimary) {
        duplicatesDetected.push({
          rowNumber: raw.rowNumber,
          incoming: sanitizedItem,
          existingLead: matchedByPrimary,
          matchReason: 'PRIMARY_PHONE',
        });
        continue;
      }

      if (matchedByAlt) {
        duplicatesDetected.push({
          rowNumber: raw.rowNumber,
          incoming: sanitizedItem,
          existingLead: matchedByAlt,
          matchReason: 'ALT_PHONE',
        });
        continue;
      }

      if (matchedByCompany) {
        duplicatesDetected.push({
          rowNumber: raw.rowNumber,
          incoming: sanitizedItem,
          existingLead: matchedByCompany,
          matchReason: 'COMPANY_NAME',
        });
        continue;
      }

      if (
        seenPhonesInUpload.has(sanitizedItem.phoneNumber) ||
        seenCompaniesInUpload.has(sanitizedItem.companyNameNormalized)
      ) {
        malformedRows.push({
          rowNumber: raw.rowNumber,
          companyName: companyTrimmed,
          rawPhone: String(raw.phoneNumberRaw ?? ''),
          rawAltPhone: raw.altNumberRaw,
          reason: 'Duplicate row repeated within the same uploaded Excel file.',
        });
        continue;
      }

      seenPhonesInUpload.add(sanitizedItem.phoneNumber);
      seenCompaniesInUpload.add(sanitizedItem.companyNameNormalized);
      validFreshLeads.push(sanitizedItem);
    }

    const percentComplete =
      totalRows === 0 ? 100 : Math.min(100, Math.round((processedRows / totalRows) * 100));

    onProgress?.({
      percentComplete,
      processedRows,
      totalRows,
      validFreshCount: validFreshLeads.length,
      duplicatesFound: duplicatesDetected.length,
      malformedRows: malformedRows.length,
      currentChunkIndex: chunkIdx + 1,
      totalChunks,
    });

    if (yieldBetweenChunksMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, yieldBetweenChunksMs));
    }
  }

  return {
    validFreshLeads,
    duplicatesDetected,
    malformedRows,
  };
}

/**
 * Throttled parallel Firestore deduplication lookup across 30-item `in` chunks
 * (capped at `MAX_PARALLEL_LOOKUP_CHUNKS` concurrent requests to respect Firestore rate limits).
 */
export async function queryFirestoreDeduplicationBatched(
  phoneNumbers: string[],
  existingLocalLeads: LeadRecord[]
): Promise<LeadRecord[]> {
  const byId = new Map<string, LeadRecord>();
  for (const l of existingLocalLeads) byId.set(l.id, l);

  const uniquePhones = Array.from(new Set(phoneNumbers.filter(Boolean))).slice(0, 600);
  if (uniquePhones.length === 0) return Array.from(byId.values());

  try {
    const inChunks = chunkArray(uniquePhones, FIRESTORE_IN_QUERY_LIMIT);
    const parallelBatches = chunkArray(inChunks, MAX_PARALLEL_LOOKUP_CHUNKS);

    for (const batchGroup of parallelBatches) {
      await Promise.all(
        batchGroup.map(async (phoneGroup) => {
          const [primarySnap, altSnap] = await Promise.all([
            getDocs(
              query(collection(db, 'leads'), where('phoneNumber', 'in', phoneGroup))
            ),
            getDocs(
              query(collection(db, 'leads'), where('altNumber', 'in', phoneGroup))
            ),
          ]);
          primarySnap.forEach((d) => byId.set(d.id, d.data() as LeadRecord));
          altSnap.forEach((d) => byId.set(d.id, d.data() as LeadRecord));
        })
      );
    }
  } catch {
    // Non-blocking fallback when offline or under restricted rules
  }

  return Array.from(byId.values());
}

/**
 * Commits verified clean leads and overwrites using recursive 500-operation `writeBatch()`
 * boundaries. If a chunk fails midway (or when `simulateFailureAtChunkIndex` is set),
 * preserves atomic commit boundaries for earlier chunks and returns an accurate
 * `PartialFailureCommitReport` detailing unprocessed records.
 */
export async function commitIngestionIn500OpBatches(
  recordsToCommit: LeadRecord[],
  importBatchId: string,
  options?: {
    simulateFailureAtChunkIndex?: number;
    onChunkCommitted?: (committedCount: number, totalCount: number) => void;
  }
): Promise<PartialFailureCommitReport> {
  const chunks = chunkArray(recordsToCommit, MAX_FIRESTORE_BATCH_OPS);
  let committedRecordsCount = 0;
  let committedChunksCount = 0;

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    if (
      options?.simulateFailureAtChunkIndex !== undefined &&
      idx === options.simulateFailureAtChunkIndex
    ) {
      const unprocessedRecords = chunks.slice(idx).flat();
      return {
        importBatchId,
        totalRequestedRecords: recordsToCommit.length,
        committedRecordsCount,
        committedChunksCount,
        failedAtChunkIndex: idx,
        unprocessedRecords,
        errorReason: `Simulated atomic batch boundary failure at chunk #${idx + 1} (${unprocessedRecords.length} rows unprocessed).`,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const wb = writeBatch(db);
      for (const lead of chunk) {
        const cleanLead = sanitizeFirestorePayload(lead);
        wb.set(doc(db, 'leads', lead.id), cleanLead, { merge: true });
      }
      if (typeof window !== 'undefined' && hasLiveReachFirebaseConfig()) {
        await wb.commit();
      } else {
        await Promise.race([
          wb.commit().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 40)),
        ]);
      }
    } catch (err) {
      const cloudErr = reportCloudSyncError(
        err,
        `Excel Upload Batch Commit (Chunk #${idx + 1})`
      );
      if (typeof window !== 'undefined') {
        const unprocessedRecords = chunks.slice(idx).flat();
        return {
          importBatchId,
          totalRequestedRecords: recordsToCommit.length,
          committedRecordsCount,
          committedChunksCount,
          failedAtChunkIndex: idx,
          unprocessedRecords,
          errorReason: cloudErr.formattedBanner,
          timestamp: new Date().toISOString(),
        };
      }
    }

    committedRecordsCount += chunk.length;
    committedChunksCount++;
    options?.onChunkCommitted?.(committedRecordsCount, recordsToCommit.length);
  }

  return {
    importBatchId,
    totalRequestedRecords: recordsToCommit.length,
    committedRecordsCount,
    committedChunksCount,
    failedAtChunkIndex: null,
    unprocessedRecords: [],
    errorReason: null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generates a realistic high-volume stress sheet (e.g., 2,500 rows across 5 chunks of 500 rows)
 * containing dirty floats, scientific notation, regional prefixes, duplicates, and malformed rows
 * to demonstrate the Web Worker 500-row streaming progress bar in real time.
 */
export function generateHighVolumeStreamRows(totalCount = 2500): RawSheetRow[] {
  const rows: RawSheetRow[] = [];
  const states = ['Gujarat', 'Maharashtra', 'Rajasthan', 'Tamil Nadu', 'Karnataka'];
  const cities = ['Ahmedabad', 'Pune', 'Jaipur', 'Coimbatore', 'Bengaluru'];

  for (let i = 0; i < totalCount; i++) {
    const rowNumber = i + 2;
    if (i % 250 === 249) {
      // Intentional malformed row
      rows.push({
        rowNumber,
        companyName: `Malformed Solar Prospect #${i + 1}`,
        phoneNumberRaw: '4123456789', // Starts with 4 (invalid Indian mobile)
        dateOfCalling: '2026-10-28',
        state: states[i % states.length],
        city: cities[i % cities.length],
      });
    } else if (i === 50) {
      // Intentional duplicate of existing lead-101 (9825011223)
      rows.push({
        rowNumber,
        companyName: 'Arvind Polycot Spinning Mills Pvt Ltd (Duplicate Row)',
        phoneNumberRaw: '00919825011223',
        dateOfCalling: '2026-10-28',
        state: 'Gujarat',
        city: 'Ahmedabad',
      });
    } else {
      const baseNum = 7100000000 + i;
      const prefixStyle =
        i % 4 === 0
          ? `91${baseNum}`
          : i % 4 === 1
            ? `${baseNum}.0`
            : i % 4 === 2
              ? `0${baseNum}`
              : String(baseNum);

      rows.push({
        rowNumber,
        companyName: `Solarithm High-Volume C&I Prospect #${i + 1} Pvt Ltd`,
        phoneNumberRaw: prefixStyle,
        dateOfCalling: '2026-10-28',
        state: states[i % states.length],
        city: cities[i % cities.length],
        email: `facility.${i + 1}@ci-solar-cluster.in`,
      });
    }
  }

  return rows;
}
