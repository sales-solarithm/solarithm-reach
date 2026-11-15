import { CANONICAL_NEXUS_EMPLOYEES, NexusEmployeeRecord } from './authService';
import { ActiveReachSalesRep } from './employeeQueries';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import { computeOperationalDatesForStatus } from './leadStore';
import { CallLogEntry, LeadRecord, LeadStatus, SanitizedRowItem } from './types';

export const EXCEL_TEMPLATE_HEADERS = [
  'Company Name',
  'Phone Number',
  'Date of Calling',
  'State',
  'City',
  'Email',
  'Alternative Number',
  'Status',
  'Sales Person',
  'Remarks',
] as const;

export interface EmployeeMatchCandidate {
  email: string;
  officialEmail?: string;
  personalEmail?: string;
  personalEmailAddress?: string;
  name: string;
  role?: string;
  status?: string;
}

/**
 * 2. Fuzzy Status Normalization Mapper:
 * Maps human-typed variations in the Excel `Status` column cleanly to `LeadStatus` enums:
 * - Empty / Blank / "fresh" / "new" -> 'FRESH'
 * - "proposal shared" / "proposal" / "quotation sent" / "quote shared" -> 'PROPOSAL_SHARED'
 * - "didnt receive" / "didn't receive" / "no answer" / "not answered" / "nr" / "ringing" -> 'DIDNT_RECEIVE'
 * - "interested" / "hot" / "qualified" -> 'INTERESTED'
 * - "future requirement" / "future" / "call later" / "after 1 month" -> 'FUTURE_REQUIREMENT'
 * - "not interested" / "ni" / "rejected" -> 'NOT_INTERESTED'
 * - "switch off" / "switched off" / "switchoff" / "so" -> 'SWITCH_OFF'
 * - "not a solar company" / "non solar" / "wrong industry" -> 'NOT_A_SOLAR_COMPANY'
 * - "closed" / "closed won" / "won" -> 'CLOSED_WON'
 * - "lost" / "lead lost" -> 'LEAD_LOST'
 */
export function normalizeImportedStatus(rawStatus?: string | null): LeadStatus {
  if (rawStatus === undefined || rawStatus === null) return 'FRESH';
  const cleaned = String(rawStatus)
    .trim()
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (!cleaned || cleaned === 'fresh' || cleaned === 'new' || cleaned === 'untouched') {
    return 'FRESH';
  }

  if (cleaned === 'revived fresh') {
    return 'REVIVED_FRESH';
  }

  // Proposal Shared variations
  if (
    cleaned === 'proposal shared' ||
    cleaned === 'proposal' ||
    cleaned === 'quotation sent' ||
    cleaned === 'quote shared' ||
    cleaned === 'quotation shared' ||
    cleaned === 'proposal sent' ||
    cleaned === 'send details' ||
    cleaned === 'details shared' ||
    cleaned === 'whatsapp shared' ||
    cleaned === 'brochure shared' ||
    cleaned === 'profile shared' ||
    cleaned.includes('proposal') ||
    cleaned.includes('quotation') ||
    cleaned.includes('quote shared') ||
    cleaned.includes('details shared') ||
    cleaned.includes('whatsapp shared')
  ) {
    return 'PROPOSAL_SHARED';
  }

  // Didn't Receive variations
  if (
    cleaned === 'didnt receive' ||
    cleaned === 'did not receive' ||
    cleaned === 'no answer' ||
    cleaned === 'not answered' ||
    cleaned === 'nr' ||
    cleaned === 'ringing' ||
    cleaned === 'rnr' ||
    cleaned === 'busy' ||
    cleaned === 'line busy' ||
    cleaned === 'not picking' ||
    cleaned === 'didnt pick' ||
    cleaned === 'did not pick' ||
    cleaned === 'unanswered' ||
    cleaned === 'call not received' ||
    cleaned === 'voicemail' ||
    cleaned === 'voice mail'
  ) {
    return 'DIDNT_RECEIVE';
  }

  if (cleaned === 'didnt receive dead') {
    return 'DIDNT_RECEIVE_DEAD';
  }

  // Not Interested variations (must check before "interested" substring)
  if (
    cleaned === 'not interested' ||
    cleaned === 'ni' ||
    cleaned === 'rejected' ||
    cleaned === 'declined' ||
    cleaned === 'no requirement' ||
    cleaned === 'wrong number' ||
    cleaned === 'invalid number' ||
    cleaned === 'already installed' ||
    cleaned === 'do not call' ||
    cleaned === 'dnc'
  ) {
    return 'NOT_INTERESTED';
  }

  // Interested variations
  if (
    cleaned === 'interested' ||
    cleaned === 'hot' ||
    cleaned === 'qualified' ||
    cleaned === 'positive' ||
    cleaned === 'high interest' ||
    cleaned === 'very interested' ||
    cleaned === 'site visit' ||
    cleaned === 'meeting scheduled' ||
    cleaned.includes('interested')
  ) {
    return 'INTERESTED';
  }

  // Future Requirement variations
  if (
    cleaned === 'future requirement' ||
    cleaned === 'future' ||
    cleaned === 'call later' ||
    cleaned === 'call back' ||
    cleaned === 'callback' ||
    cleaned === 'follow up' ||
    cleaned === 'followup' ||
    cleaned === 'after 1 month' ||
    cleaned === 'next month' ||
    cleaned === 'next week' ||
    cleaned === 'follow up later' ||
    cleaned.includes('future') ||
    cleaned.includes('call back') ||
    cleaned.includes('follow up') ||
    cleaned.includes('after 1 month')
  ) {
    return 'FUTURE_REQUIREMENT';
  }

  // Switch Off variations
  if (
    cleaned === 'switch off' ||
    cleaned === 'switched off' ||
    cleaned === 'switchoff' ||
    cleaned === 'switchedoff' ||
    cleaned === 'so' ||
    cleaned === 'phone off' ||
    cleaned === 'mobile off' ||
    cleaned === 'not reachable' ||
    cleaned === 'out of coverage' ||
    cleaned === 'out of network' ||
    cleaned === 'unreachable'
  ) {
    return 'SWITCH_OFF';
  }

  if (cleaned === 'switch off dead') {
    return 'SWITCH_OFF_DEAD';
  }

  // Not a Solar Company variations
  if (
    cleaned === 'not a solar company' ||
    cleaned === 'non solar' ||
    cleaned === 'wrong industry' ||
    cleaned === 'not solar' ||
    cleaned === 'irrelevant' ||
    cleaned.includes('not a solar') ||
    cleaned.includes('non solar') ||
    cleaned.includes('wrong industry')
  ) {
    return 'NOT_A_SOLAR_COMPANY';
  }

  // Closed Won variations
  if (
    cleaned === 'closed' ||
    cleaned === 'closed won' ||
    cleaned === 'won' ||
    cleaned === 'deal won' ||
    cleaned === 'order booked' ||
    cleaned === 'client' ||
    cleaned === 'converted'
  ) {
    return 'CLOSED_WON';
  }

  // Lead Lost variations
  if (
    cleaned === 'lost' ||
    cleaned === 'lead lost' ||
    cleaned === 'deal lost' ||
    cleaned === 'closed lost'
  ) {
    return 'LEAD_LOST';
  }

  return 'FRESH';
}

/**
 * Case-insensitive, whitespace-normalized extractor for Excel / CSV row objects.
 * Prefers raw numeric serials for `Date of Calling` and `Phone Number` when `rawRow` is supplied.
 */
export function extractExcelRowFieldsNormalized(
  formattedRow: Record<string, unknown>,
  rawRow?: Record<string, unknown>,
  rowNumber = 2
): {
  rowNumber: number;
  companyName: string;
  phoneNumberRaw: string;
  dateOfCalling: string;
  state: string;
  city: string;
  email: string;
  altNumberRaw: string;
  statusRaw: string;
  salesPersonRaw: string;
  remarksRaw: string;
} {
  const normFormatted = new Map<string, unknown>();
  const normRaw = new Map<string, unknown>();

  for (const [k, v] of Object.entries(formattedRow || {})) {
    const cleanKey = k.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanKey && v !== undefined && v !== null && String(v).trim() !== '') {
      normFormatted.set(cleanKey, v);
    }
  }

  for (const [k, v] of Object.entries(rawRow || {})) {
    const cleanKey = k.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanKey && v !== undefined && v !== null && String(v).trim() !== '') {
      normRaw.set(cleanKey, v);
    }
  }

  const pickFormatted = (keys: string[]): string => {
    for (const k of keys) {
      const val = normFormatted.get(k) ?? normRaw.get(k);
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return String(val).trim();
      }
    }
    return '';
  };

  const pickRawFirst = (keys: string[]): string => {
    for (const k of keys) {
      const rVal = normRaw.get(k);
      if (rVal instanceof Date && !Number.isNaN(rVal.getTime())) {
        return rVal.toISOString().slice(0, 10);
      }
      if (typeof rVal === 'number' && !Number.isNaN(rVal)) {
        return String(rVal);
      }
      const fVal = normFormatted.get(k) ?? rVal;
      if (fVal !== undefined && fVal !== null && String(fVal).trim() !== '') {
        return String(fVal).trim();
      }
    }
    return '';
  };

  return {
    rowNumber,
    companyName: pickFormatted([
      'companyname',
      'company',
      'organization',
      'clientname',
      'businessname',
      'firmname',
      'name',
    ]),
    phoneNumberRaw: pickRawFirst([
      'phonenumber',
      'phone',
      'mobile',
      'mobilenumber',
      'contactnumber',
      'contact',
      'primaryphone',
      'number',
    ]),
    dateOfCalling: pickRawFirst([
      'dateofcalling',
      'callingdate',
      'calldate',
      'dateofcall',
      'calleddate',
      'lastcalleddate',
      'lastcalled',
      'date',
    ]),
    state: pickFormatted(['state', 'province', 'region']),
    city: pickFormatted(['city', 'location', 'district', 'town']),
    email: pickFormatted(['email', 'emailaddress', 'emailid', 'mail']),
    altNumberRaw: pickRawFirst([
      'alternativenumber',
      'altnumber',
      'alternatephone',
      'alternatemobile',
      'secondaryphone',
      'otherphone',
    ]),
    statusRaw: pickFormatted([
      'status',
      'leadstatus',
      'callstatus',
      'disposition',
      'outcome',
      'currentstatus',
      'finalstatus',
    ]),
    salesPersonRaw: pickFormatted([
      'salesperson',
      'salesrep',
      'calledby',
      'rep',
      'repname',
      'salesexecutive',
      'executive',
      'assignedto',
      'assignedrep',
      'telecaller',
      'caller',
      'agent',
    ]),
    remarksRaw: pickFormatted([
      'remarks',
      'remark',
      'notes',
      'note',
      'callnotes',
      'comment',
      'comments',
      'feedback',
      'description',
    ]),
  };
}

/**
 * Builds the default unified list of active employee match candidates from
 * canonical Nexus records + any live `/employees` & `/users` sales reps.
 */
export function buildEmployeeMatchPool(
  liveReps: (ActiveReachSalesRep | Partial<NexusEmployeeRecord>)[] = []
): EmployeeMatchCandidate[] {
  const byEmail = new Map<string, EmployeeMatchCandidate>();

  const register = (raw: Partial<NexusEmployeeRecord> | ActiveReachSalesRep) => {
    const rec = raw as Partial<NexusEmployeeRecord>;
    const statusUpper = String(rec.status || 'ACTIVE').trim().toUpperCase();
    if (statusUpper !== 'ACTIVE') return;

    const primaryEmail = String(
      rec.officialEmail || rec.email || rec.personalEmail || rec.personalEmailAddress || ''
    )
      .trim()
      .toLowerCase();
    const name = String(rec.name || '').trim();
    if (!primaryEmail || !name) return;

    const existing = byEmail.get(primaryEmail);
    byEmail.set(primaryEmail, {
      email: primaryEmail,
      officialEmail: String(rec.officialEmail || existing?.officialEmail || primaryEmail)
        .trim()
        .toLowerCase(),
      personalEmail: String(rec.personalEmail || existing?.personalEmail || '')
        .trim()
        .toLowerCase(),
      personalEmailAddress: String(
        rec.personalEmailAddress || existing?.personalEmailAddress || ''
      )
        .trim()
        .toLowerCase(),
      name: name || existing?.name || 'Sales Rep',
      role: String(rec.role || existing?.role || 'SALES').toUpperCase(),
      status: 'ACTIVE',
    });
  };

  for (const emp of CANONICAL_NEXUS_EMPLOYEES) {
    register(emp);
  }
  for (const rep of liveReps) {
    register(rep);
  }

  return Array.from(byEmail.values());
}

/**
 * 3. Sales Person Name / Email Matching against `/employees`:
 * Matches the Excel cell value (case-insensitive, trimmed) against:
 * 1. Employee `email`, `officialEmail`, `personalEmail`, or `personalEmailAddress`
 * 2. Employee full `name`
 * 3. Employee first name or name tokens (e.g., `"Hasti"` or `"Savani Hasti"` -> `"Savani Hasti Vijaybhai"`).
 */
export function matchSalesPersonToEmployeePure(
  rawSalesPerson: string | undefined | null,
  candidates: EmployeeMatchCandidate[] = buildEmployeeMatchPool()
): { email: string; name: string } | null {
  if (!rawSalesPerson) return null;
  const query = String(rawSalesPerson).trim().toLowerCase();
  if (!query) return null;

  // 1. Exact email match across all 4 mirrored email fields
  for (const emp of candidates) {
    if (
      emp.email.toLowerCase() === query ||
      emp.officialEmail?.toLowerCase() === query ||
      emp.personalEmail?.toLowerCase() === query ||
      emp.personalEmailAddress?.toLowerCase() === query
    ) {
      return { email: emp.email, name: emp.name.split(' (')[0].trim() };
    }
  }

  const cleanName = (n: string) =>
    n
      .split(' (')[0]
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  const cleanedQuery = cleanName(query);

  // 2. Exact full name match
  for (const emp of candidates) {
    if (cleanName(emp.name) === cleanedQuery) {
      return { email: emp.email, name: emp.name.split(' (')[0].trim() };
    }
  }

  const queryTokens = cleanedQuery.split(' ').filter(Boolean);
  if (queryTokens.length === 0) return null;

  // 3. Exact token subset match (e.g., "Hasti" or "Savani Hasti" matches tokens of "Savani Hasti Vijaybhai")
  for (const emp of candidates) {
    const empClean = cleanName(emp.name);
    const empTokens = empClean.split(' ').filter(Boolean);
    const allQueryTokensExactMatch = queryTokens.every((qt) =>
      empTokens.includes(qt)
    );
    if (allQueryTokensExactMatch) {
      return { email: emp.email, name: emp.name.split(' (')[0].trim() };
    }
  }

  // 4. Email local-part prefix or name token prefix match (for shortened names >= 3 chars)
  if (cleanedQuery.length >= 3) {
    for (const emp of candidates) {
      const empClean = cleanName(emp.name);
      const empTokens = empClean.split(' ').filter(Boolean);
      const allTokensPrefixMatch = queryTokens.every((qt) =>
        empTokens.some((et) => et.startsWith(qt))
      );
      if (allTokensPrefixMatch) {
        return { email: emp.email, name: emp.name.split(' (')[0].trim() };
      }
    }
  }

  return null;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function normalizeTwoDigitYear(rawYear: number): number {
  if (rawYear >= 100) return rawYear;
  return rawYear < 70 ? 2000 + rawYear : 1900 + rawYear;
}

/**
 * 4.1 Parse `Date of Calling`:
 * - Parses Excel date serial numbers (e.g., `46324` -> `new Date(Math.round((serial - 25569) * 86400 * 1000))`),
 * - Parses 4-digit and 2-digit year dates in `DD-MM-YYYY`, `DD/MM/YYYY`, `DD.MM.YYYY`, `MM/DD/YYYY`, `DD/MM/YY`, `MM/DD/YY`,
 * - Parses `YYYY-MM-DD` / `YYYY/MM/DD`, and named-month strings (`18-Oct-2026`, `18 Oct 26`, `Oct 18, 2026`)
 *   into a valid normalized ISO timestamp (`YYYY-MM-DDT10:00:00.000Z` whose `.slice(0, 10)` is the exact `YYYY-MM-DD`).
 * - ONLY falls back to `fallbackNowIso` if `Date of Calling` is completely blank on a non-FRESH lead.
 *   Never overwrites a valid past date from Excel with today's upload date.
 */
export function parseHistoricalCallingDate(
  rawDate: string | number | Date | undefined | null,
  status: LeadStatus,
  fallbackNowIso: string = new Date().toISOString()
): string | null {
  const isFresh = status === 'FRESH';

  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    const y = rawDate.getUTCFullYear();
    const m = rawDate.getUTCMonth();
    const d = rawDate.getUTCDate();
    return new Date(Date.UTC(y, m, d, 10, 0, 0)).toISOString();
  }

  const rawStr =
    rawDate !== undefined && rawDate !== null ? String(rawDate).trim() : '';

  if (!rawStr) {
    return isFresh ? null : fallbackNowIso;
  }

  // 1. Excel serial number (e.g., 46324 or 46324.5)
  if (/^\d+(\.\d+)?$/.test(rawStr)) {
    const serial = parseFloat(rawStr);
    if (serial > 20000 && serial < 90000) {
      // Excel epoch is 1899-12-30 UTC (25569 days before 1970-01-01)
      const utcMs = Math.round((Math.floor(serial) - 25569) * 86400 * 1000);
      const d = new Date(utcMs);
      if (!Number.isNaN(d.getTime())) {
        return new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0)
        ).toISOString();
      }
    }
  }

  // 2. YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD (with optional time suffix)
  const ymdMatch = rawStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1990 && year <= 2100) {
      if (rawStr.includes('T')) {
        const parsedFull = new Date(rawStr);
        if (!Number.isNaN(parsedFull.getTime())) {
          return parsedFull.toISOString();
        }
      }
      return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
    }
  }

  // 3. DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, DD-MM-YY, DD/MM/YY, MM/DD/YYYY, MM/DD/YY (with optional time suffix)
  const dmyOrMdyMatch = rawStr.match(
    /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s+.*)?$/
  );
  if (dmyOrMdyMatch) {
    const part1 = parseInt(dmyOrMdyMatch[1], 10);
    const part2 = parseInt(dmyOrMdyMatch[2], 10);
    const year = normalizeTwoDigitYear(parseInt(dmyOrMdyMatch[3], 10));

    let day = part1;
    let month = part2;

    // If part2 > 12 and part1 <= 12, it is unambiguously MM/DD/YYYY (e.g., 10/18/2026 or 10/18/26 from SheetJS)
    if (part2 > 12 && part1 >= 1 && part1 <= 12) {
      month = part1;
      day = part2;
    }

    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31 &&
      year >= 1990 &&
      year <= 2100
    ) {
      return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
    }
  }

  // 4. Named month formats: "18-Oct-2026", "18 Oct 26", "Oct 18, 2026", "October 18 2026"
  const dMonthY = rawStr.match(
    /^(\d{1,2})[-/\s.]+([A-Za-z]{3,9})[-/\s.,]+(\d{2}|\d{4})(?:\s+.*)?$/
  );
  if (dMonthY) {
    const day = parseInt(dMonthY[1], 10);
    const month = MONTH_NAME_MAP[dMonthY[2].toLowerCase()];
    const year = normalizeTwoDigitYear(parseInt(dMonthY[3], 10));
    if (month && day >= 1 && day <= 31 && year >= 1990 && year <= 2100) {
      return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
    }
  }

  const monthDY = rawStr.match(
    /^([A-Za-z]{3,9})[-/\s.]+(\d{1,2})[-/\s.,]+(\d{2}|\d{4})(?:\s+.*)?$/
  );
  if (monthDY) {
    const month = MONTH_NAME_MAP[monthDY[1].toLowerCase()];
    const day = parseInt(monthDY[2], 10);
    const year = normalizeTwoDigitYear(parseInt(monthDY[3], 10));
    if (month && day >= 1 && day <= 31 && year >= 1990 && year <= 2100) {
      return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
    }
  }

  // 5. Fallback standard Date.parse
  const fallbackParsed = new Date(rawStr);
  if (!Number.isNaN(fallbackParsed.getTime())) {
    return new Date(
      Date.UTC(
        fallbackParsed.getFullYear(),
        fallbackParsed.getMonth(),
        fallbackParsed.getDate(),
        10,
        0,
        0
      )
    ).toISOString();
  }

  return isFresh ? null : fallbackNowIso;
}

/**
 * Enriches a `SanitizedRowItem` with normalized `importedStatus`, matched `Sales Person`,
 * fallback uploader assignment when `PROPOSAL_SHARED` or `FUTURE_REQUIREMENT` has a blank `Sales Person`,
 * parsed `lastCalledDate`, and cleaned `remarks`.
 */
export function enrichSanitizedRowWithHistoricalFieldsPure(
  item: SanitizedRowItem,
  options?: {
    employees?: EmployeeMatchCandidate[];
    uploaderUser?: { email: string; name: string } | null;
    nowIso?: string;
  }
): SanitizedRowItem {
  const nowIso = options?.nowIso || new Date().toISOString();
  const candidates = options?.employees || buildEmployeeMatchPool();
  const uploader = options?.uploaderUser || null;

  const importedStatus = normalizeImportedStatus(item.statusRaw);
  const matchedRep = matchSalesPersonToEmployeePure(item.salesPersonRaw, candidates);
  let assignedRepEmail: string | null = matchedRep ? matchedRep.email : null;
  let assignedRepName: string | null = matchedRep ? matchedRep.name : null;
  let repFallbackWarning = false;
  let unmatchedSalesPersonWarning: string | null = null;

  if (item.salesPersonRaw && item.salesPersonRaw.trim() !== '' && !matchedRep) {
    unmatchedSalesPersonWarning = `Unmatched Sales Person "${item.salesPersonRaw.trim()}"`;
  }

  // Requirement 3.4: If status is 'PROPOSAL_SHARED' or 'FUTURE_REQUIREMENT' and Sales Person was left blank (or unmatched),
  // assign it to the currently logged-in uploader and flag a warning in the pre-flight preview.
  if (
    (importedStatus === 'PROPOSAL_SHARED' || importedStatus === 'FUTURE_REQUIREMENT') &&
    !assignedRepEmail
  ) {
    repFallbackWarning = true;
    if (uploader?.email) {
      assignedRepEmail = uploader.email.toLowerCase().trim();
      assignedRepName = uploader.name.split(' (')[0].trim();
    }
  }

  const parsedLastCalledDate = parseHistoricalCallingDate(
    item.dateOfCalling,
    importedStatus,
    nowIso
  );

  const isHistoricalCalled =
    importedStatus !== 'FRESH' ||
    Boolean(parsedLastCalledDate && assignedRepEmail);

  return {
    ...item,
    importedStatus,
    isHistoricalCalled,
    assignedRepEmail,
    assignedRepName,
    repFallbackWarning,
    unmatchedSalesPersonWarning,
    remarks: item.remarks?.trim() || undefined,
    parsedLastCalledDate,
  };
}

/**
 * 4.2 & 4.3 State Machine Rules & Remarks Preservation on Import:
 * Converts an enriched `SanitizedRowItem` into a complete `LeadRecord` adhering to:
 * - 'FRESH': callAttempts = 0, assignedRepEmail = null, assignedBatchId = null (unless explicit Date of Calling + Sales Person was provided)
 * - 'DIDNT_RECEIVE': didntReceiveCount = 1, callAttempts = 1, status = 'FRESH' (retry pool), assignedRepEmail = null,
 *   PRESERVES `lastCalledByEmail` & `lastCalledByName`, cooldownUntil = lastCalledDate + 48h
 * - 'SWITCH_OFF': switchOffCount = 1, callAttempts = 1, status = 'FRESH', assignedRepEmail = null,
 *   PRESERVES `lastCalledByEmail` & `lastCalledByName`
 * - 'PROPOSAL_SHARED': status = 'PROPOSAL_SHARED', callAttempts = 1, retains assignedRepEmail & assignedRepName, nextFollowUpDate = lastCalledDate + 2 days
 * - 'FUTURE_REQUIREMENT': status = 'FUTURE_REQUIREMENT', callAttempts = 1, retains assignedRepEmail & assignedRepName, nextFollowUpDate = lastCalledDate + 30 days
 * - 'INTERESTED': status = 'INTERESTED', callAttempts = 1, retains originating assignedRepEmail & assignedRepName (surfaces in Owner Closing Queue)
 * - 'NOT_INTERESTED' | 'NOT_A_SOLAR_COMPANY' | 'CLOSED_WON' | 'LEAD_LOST': sets exact status, callAttempts = 1,
 *   PRESERVES `lastCalledByEmail` & `lastCalledByName`
 */
export function buildLeadRecordFromSanitizedRowPure(
  rawItem: SanitizedRowItem,
  options?: {
    id?: string;
    importBatchId?: string;
    employees?: EmployeeMatchCandidate[];
    uploaderUser?: { email: string; name: string } | null;
    nowIso?: string;
  }
): LeadRecord {
  const nowIso = options?.nowIso || new Date().toISOString();
  const item =
    rawItem.importedStatus !== undefined
      ? rawItem
      : enrichSanitizedRowWithHistoricalFieldsPure(rawItem, {
          employees: options?.employees,
          uploaderUser: options?.uploaderUser,
          nowIso,
        });

  const importedStatus: LeadStatus = item.importedStatus || 'FRESH';
  const lastCalledDate =
    item.parsedLastCalledDate !== undefined
      ? item.parsedLastCalledDate
      : parseHistoricalCallingDate(item.dateOfCalling, importedStatus, nowIso);

  const hasHistoricalCallActivity =
    importedStatus !== 'FRESH' ||
    Boolean(lastCalledDate && item.assignedRepEmail);

  let finalStatus: LeadStatus = importedStatus;
  let callAttempts = hasHistoricalCallActivity ? 1 : 0;
  let didntReceiveCount = 0;
  let switchOffCount = 0;
  let assignedRepEmail: string | null = item.assignedRepEmail || null;
  let assignedRepName: string | null = item.assignedRepName || null;
  let cooldownUntil: string | null = null;
  let nextFollowUpDate: string | null = null;

  if (importedStatus === 'FRESH') {
    finalStatus = 'FRESH';
    didntReceiveCount = 0;
    switchOffCount = 0;
    assignedRepEmail = null;
    assignedRepName = null;
    cooldownUntil = null;
    nextFollowUpDate = null;
  } else if (importedStatus === 'DIDNT_RECEIVE') {
    finalStatus = 'FRESH'; // Enters retry pool (Bucket B) once 48h cooldown expires
    callAttempts = 1;
    didntReceiveCount = 1;
    switchOffCount = 0;
    assignedRepEmail = null;
    assignedRepName = null;
    const dates = computeOperationalDatesForStatus(
      'DIDNT_RECEIVE',
      lastCalledDate || nowIso
    );
    cooldownUntil = dates.cooldownUntil;
    nextFollowUpDate = null;
  } else if (importedStatus === 'SWITCH_OFF') {
    finalStatus = 'FRESH';
    callAttempts = 1;
    didntReceiveCount = 0;
    switchOffCount = 1;
    assignedRepEmail = null;
    assignedRepName = null;
    cooldownUntil = null;
    nextFollowUpDate = null;
  } else if (importedStatus === 'PROPOSAL_SHARED') {
    finalStatus = 'PROPOSAL_SHARED';
    callAttempts = 1;
    const dates = computeOperationalDatesForStatus(
      'PROPOSAL_SHARED',
      lastCalledDate || nowIso
    );
    cooldownUntil = null;
    nextFollowUpDate = dates.nextFollowUpDate;
  } else if (importedStatus === 'FUTURE_REQUIREMENT') {
    finalStatus = 'FUTURE_REQUIREMENT';
    callAttempts = 1;
    const dates = computeOperationalDatesForStatus(
      'FUTURE_REQUIREMENT',
      lastCalledDate || nowIso
    );
    cooldownUntil = null;
    nextFollowUpDate = dates.nextFollowUpDate;
  } else if (importedStatus === 'INTERESTED') {
    finalStatus = 'INTERESTED';
    callAttempts = 1;
    cooldownUntil = null;
    nextFollowUpDate = null;
  } else {
    // 'NOT_INTERESTED' | 'NOT_A_SOLAR_COMPANY' | 'CLOSED_WON' | 'LEAD_LOST' | etc.
    finalStatus = importedStatus;
    callAttempts = 1;
    cooldownUntil = null;
    nextFollowUpDate = null;
  }

  const remarksText = (item.remarks || '').trim();
  const remarksAuthor = item.assignedRepName || 'Historical Import';
  const remarksTimestamp = lastCalledDate || nowIso;

  const formattedNotes = remarksText
    ? `[${remarksAuthor} · ${remarksTimestamp.slice(0, 10)}]: ${remarksText}`
    : '';

  const callHistory: CallLogEntry[] | undefined =
    hasHistoricalCallActivity || remarksText
      ? [
          {
            id: `hist-${Date.now()}-${item.rowNumber}`,
            timestamp: remarksTimestamp,
            repEmail: item.assignedRepEmail || 'historical@solarithmdesign.com',
            repName: remarksAuthor,
            previousStatus: 'FRESH',
            newStatus: importedStatus,
            note: remarksText || `Historical import (${importedStatus})`,
          },
        ]
      : undefined;

  return sanitizeFirestorePayload({
    id: options?.id || `ingested-${Date.now()}-${item.rowNumber}`,
    companyName: item.companyName,
    companyNameNormalized: item.companyNameNormalized,
    phoneNumber: item.phoneNumber,
    formattedPhone: item.formattedPhone,
    altNumber: item.altNumber || null,
    state: item.state?.trim() || null,
    city: item.city?.trim() || null,
    email: item.email?.trim() || null,
    status: finalStatus,
    assignedBatchId: null,
    assignedRepEmail,
    assignedRepName,
    callAttempts,
    callCount: callAttempts,
    didntReceiveCount,
    switchOffCount,
    lastCalledDate: !hasHistoricalCallActivity ? null : lastCalledDate || nowIso,
    // ALWAYS preserve lastCalledByEmail and lastCalledByName when Sales Person is matched on any historical/called row
    lastCalledByEmail: !hasHistoricalCallActivity
      ? null
      : item.assignedRepEmail || null,
    lastCalledByName: !hasHistoricalCallActivity
      ? null
      : item.assignedRepName || null,
    interestedAt:
      importedStatus === 'INTERESTED' || importedStatus === 'CLOSED_WON'
        ? lastCalledDate || nowIso
        : null,
    closedWonAt:
      importedStatus === 'CLOSED_WON' ? lastCalledDate || nowIso : null,
    cooldownUntil,
    nextFollowUpDate,
    createdAt: nowIso,
    updatedAt: nowIso,
    notes: formattedNotes,
    lastCallNotes: remarksText || null,
    remarks: remarksText || null,
    remarksAuthor: remarksText ? remarksAuthor : null,
    remarksTimestamp: remarksText ? remarksTimestamp : null,
    callHistory,
    importBatchId: options?.importBatchId || null,
  });
}

export interface PreFlightBreakdownSummary {
  freshUntouchedCount: number;
  historicalCalledCount: number;
  historicalByStatus: Record<string, number>;
  historicalBreakdown: Record<LeadStatus, number>;
  repFallbackWarningsCount: number;
  unmatchedSalesPersonWarningsCount: number;
  duplicatesCount: number;
  malformedCount: number;
}

/**
 * 5. Pre-Flight Import Preview Breakdown Calculator:
 * Computes:
 * - `freshUntouchedCount`: Fresh Untouched Leads
 * - `historicalCalledCount`: Historical / Already Called Leads (with Status) + per-status breakdown
 * - `duplicatesCount`: Duplicates Found
 */
export function computePreFlightBreakdownPure(params: {
  validFreshLeads: SanitizedRowItem[];
  duplicatesCount: number;
  malformedCount: number;
}): PreFlightBreakdownSummary {
  let freshUntouchedCount = 0;
  let historicalCalledCount = 0;
  let repFallbackWarningsCount = 0;
  let unmatchedSalesPersonWarningsCount = 0;
  const historicalByStatus: Record<string, number> = {};
  const historicalBreakdown: Record<LeadStatus, number> = {
    FRESH: 0,
    REVIVED_FRESH: 0,
    DIDNT_RECEIVE: 0,
    DIDNT_RECEIVE_DEAD: 0,
    SWITCH_OFF: 0,
    SWITCH_OFF_DEAD: 0,
    PROPOSAL_SHARED: 0,
    INTERESTED: 0,
    FUTURE_REQUIREMENT: 0,
    NOT_INTERESTED: 0,
    NOT_A_SOLAR_COMPANY: 0,
    CLOSED_WON: 0,
    LEAD_LOST: 0,
  };

  for (const row of params.validFreshLeads) {
    const status = row.importedStatus || normalizeImportedStatus(row.statusRaw);
    if (row.repFallbackWarning) {
      repFallbackWarningsCount++;
    }
    if (row.unmatchedSalesPersonWarning) {
      unmatchedSalesPersonWarningsCount++;
    }
    if (status === 'FRESH' && !row.remarks && !row.salesPersonRaw) {
      freshUntouchedCount++;
    } else if (status === 'FRESH') {
      freshUntouchedCount++;
    } else {
      historicalCalledCount++;
      historicalByStatus[status] = (historicalByStatus[status] || 0) + 1;
      historicalBreakdown[status] = (historicalBreakdown[status] || 0) + 1;
    }
  }

  return {
    freshUntouchedCount,
    historicalCalledCount,
    historicalByStatus,
    historicalBreakdown,
    repFallbackWarningsCount,
    unmatchedSalesPersonWarningsCount,
    duplicatesCount: params.duplicatesCount,
    malformedCount: params.malformedCount,
  };
}
