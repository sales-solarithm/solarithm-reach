import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  hasLiveReachFirebaseConfig,
  reachDb as db,
  reportCloudSyncError,
  withFirestoreNetworkRetry,
} from './firebaseDual';
import {
  AuthorizedUser,
  BatchRecord,
  DuplicateConflict,
  InterestedSubFilter,
  LeadRecord,
  LeadStatus,
  MalformedRowError,
  OwnerSubStatus,
  RawSheetRow,
  SanitizedRowItem,
} from './types';
import { INITIAL_AUTHORIZED_USERS, INITIAL_BATCHES, INITIAL_LEADS } from './seedData';
import { normalizeCompanyName, sanitizeIndianPhone } from './phoneSanitizer';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import {
  EmployeeMatchCandidate,
  buildLeadRecordFromSanitizedRowPure,
  enrichSanitizedRowWithHistoricalFieldsPure,
} from './historicalImportParser';
import {
  areRepEmailsEquivalentPure,
  resolveCanonicalRepIdentity,
} from './dailyStatsService';
import { doesLeadMatchWorkspaceDateFilterPure } from './dashboardMetrics';
import { formatRepName } from './utils';
import type { AnalyticsDateFilter } from './performanceAnalytics';

const STORAGE_KEYS = {
  LEADS: 'solarithm_reach_leads_v1',
  BATCHES: 'solarithm_reach_batches_v1',
  USERS: 'solarithm_reach_users_v1',
  CLEAN_RESET_MARKER: 'solarithm_reach_clean_reset_suryavega_v1',
};

const LEGACY_MOCK_LEAD_IDS = new Set([
  'lead-101',
  'lead-102',
  'lead-103',
  'lead-104',
  'lead-105',
  'lead-106',
  'lead-107',
  'lead-108',
  'lead-109',
  'lead-110',
  'lead-111',
  'lead-112',
  'lead-113',
  'lead-114',
  'lead-115',
  'lead-116',
  'lead-117',
  'lead-118',
  'lead-119',
]);

const LEGACY_MOCK_COMPANY_NAMES = new Set([
  'arvind polycot spinning mills pvt ltd',
  'kalyani forge & auto components ltd',
  'morbi vitrified ceramics llp',
  'shree cement & clinker grinding works',
  'narmada cold chain & agro logistics',
  'deccan precision textile processors',
  'coimbatore foundry & alloys pvt ltd',
  'surat diamond & laser tech park',
  'sanand pharma formulations ltd',
  'vapi specialty chemicals & dyes',
  'rajkot cnc castings & gears pvt ltd',
  'bhiwandi mega cold storage & warehousing',
  'bhavnagar shipbreakers & rolling mills',
  'jamnagar brass extrusion works llp',
  'dahej petrochemical & polymer complex ltd',
  'hazira heavy engineering & forging works',
  'silvassa plastic extrusion & packaging llp',
  'kolhapur foundry & sugar machinery co',
  'nashik cold chain & grape export park',
  'suryavega analytics test solar',
]);

const LEGACY_DUMMY_PHONE_NUMBERS = new Set(['9825099887']);

const LEGACY_DUMMY_COMPANY_SUBSTRINGS = [
  'suryavega',
  'analytics test solar',
  'bulk solar industry #',
];

export function isLegacyMockOrSyntheticLead(
  lead: Partial<LeadRecord> | null | undefined
): boolean {
  if (!lead) return true;
  const id = String(lead.id || '').trim();
  if (
    LEGACY_MOCK_LEAD_IDS.has(id) ||
    id.startsWith('bulk-') ||
    id.startsWith('bulk-lead-')
  ) {
    return true;
  }

  const rawCompany = String(lead.companyName || '').trim().toLowerCase();
  const normCompany = String(lead.companyNameNormalized || '')
    .trim()
    .toLowerCase();

  if (
    LEGACY_MOCK_COMPANY_NAMES.has(rawCompany) ||
    LEGACY_MOCK_COMPANY_NAMES.has(normCompany)
  ) {
    return true;
  }

  if (
    LEGACY_DUMMY_COMPANY_SUBSTRINGS.some(
      (sub) => rawCompany.includes(sub) || normCompany.includes(sub)
    )
  ) {
    return true;
  }

  const phoneCandidates = [
    lead.phoneNumber,
    lead.altNumber,
    lead.formattedPhone,
  ]
    .map((p) => String(p || '').replace(/\D/g, '').slice(-10))
    .filter((p) => p.length === 10);

  if (phoneCandidates.some((p) => LEGACY_DUMMY_PHONE_NUMBERS.has(p))) {
    return true;
  }

  return false;
}

export function isLegacyMockBatch(
  batch: Partial<BatchRecord> | null | undefined
): boolean {
  if (!batch) return true;
  const leadIds = Array.isArray(batch.leadIds) ? batch.leadIds : [];
  if (
    leadIds.some(
      (id) => LEGACY_MOCK_LEAD_IDS.has(id) || String(id).startsWith('bulk-')
    )
  ) {
    return true;
  }
  if (batch.claimedByEmail === 'rohan@solarithmdesign.com') {
    return true;
  }
  return false;
}

export function stripSystemIngestionNotePure(notes?: string | null): string {
  const trimmed = String(notes || '').trim();
  if (!trimmed) return '';
  if (
    trimmed.startsWith('Ingested via Excel/CSV Pre-Flight Pipeline') ||
    trimmed.startsWith('Historical status (')
  ) {
    return '';
  }
  return trimmed;
}

function purgeDeprecatedBrowserStorageKeys(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEYS.LEADS);
    window.localStorage.removeItem(STORAGE_KEYS.BATCHES);
    window.localStorage.removeItem(STORAGE_KEYS.USERS);
    window.localStorage.removeItem(STORAGE_KEYS.CLEAN_RESET_MARKER);
  } catch {
    // Ignore
  }
}

export function loadLocalLeads(): LeadRecord[] {
  purgeDeprecatedBrowserStorageKeys();
  return [];
}

export function saveLocalLeads(_leads: LeadRecord[]): void {
  purgeDeprecatedBrowserStorageKeys();
}

export function loadLocalBatches(): BatchRecord[] {
  purgeDeprecatedBrowserStorageKeys();
  return [];
}

export function saveLocalBatches(_batches: BatchRecord[]): void {
  purgeDeprecatedBrowserStorageKeys();
}

/**
 * Fetches all leads directly from the live Cloud Firestore server (`getDocsFromServer`)
 * so Browser 1 and Browser 2 always see the exact same server-acknowledged lead database.
 */
export async function fetchAllLeadsFromServerFirestore(): Promise<LeadRecord[]> {
  if (!hasLiveReachFirebaseConfig()) return [];
  try {
    const snap = await withFirestoreNetworkRetry(
      () => getDocs(collection(db, 'leads')),
      1500
    );
    const list: LeadRecord[] = [];
    snap.forEach((d) => {
      const record = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
      if (!isLegacyMockOrSyntheticLead(record)) {
        const sanitizedNotes = stripSystemIngestionNotePure(record.notes);
        list.push(
          sanitizedNotes !== record.notes
            ? { ...record, notes: sanitizedNotes }
            : record
        );
      }
    });
    return list;
  } catch (err) {
    reportCloudSyncError(err, 'Fetch Leads from Cloud DB');
    return [];
  }
}

/**
 * Fetches all batches directly from the live Cloud Firestore server (`getDocs` with `memoryLocalCache()` + 1.5s retry).
 */
export async function fetchAllBatchesFromServerFirestore(): Promise<BatchRecord[]> {
  if (!hasLiveReachFirebaseConfig()) return [];
  try {
    const snap = await withFirestoreNetworkRetry(
      () => getDocs(collection(db, 'batches')),
      1500
    );
    const list: BatchRecord[] = [];
    snap.forEach((d) => {
      const raw = d.data() as BatchRecord;
      if (raw && (raw.batchId || d.id) && !isLegacyMockBatch(raw)) {
        list.push({
          ...raw,
          batchId: d.id || raw.batchId,
          claimedByEmail:
            raw.status === 'AVAILABLE' ? null : (raw.claimedByEmail ?? null),
          claimedByName:
            raw.status === 'AVAILABLE' ? null : (raw.claimedByName ?? null),
          claimedAt:
            raw.status === 'AVAILABLE' ? null : (raw.claimedAt ?? null),
        });
      }
    });
    return list.sort((a, b) => a.batchNumber - b.batchNumber);
  } catch (err) {
    reportCloudSyncError(err, 'Fetch Batches from Cloud DB');
    return [];
  }
}

let hasAttemptedLegacyMockPurge = false;

/**
 * One-time administrative cleanup utility that deletes any leftover dummy/test documents
 * (including `"SuryaVega Analytics Test Solar"`, `"9825099887"`, `lead-101`..`lead-119`, `bulk-*`)
 * from the Firestore `leads` and `batches` collections in batched 450-op chunks.
 */
export async function purgeLegacySeededMockLeadsFromFirestore(
  forceRun = false
): Promise<string[]> {
  if (hasAttemptedLegacyMockPurge && !forceRun) return [];
  hasAttemptedLegacyMockPurge = true;

  // Always purge local storage immediately in browser environments
  if (typeof window !== 'undefined') {
    loadLocalLeads();
    loadLocalBatches();
  }

  const hasConfiguredProject = hasLiveReachFirebaseConfig();
  if (!hasConfiguredProject) return [];

  const deletedIds: string[] = [];

  try {
    const [leadsSnap, batchesSnap, byPhoneSnap, byAltPhoneSnap] =
      await Promise.all([
        getDocs(collection(db, 'leads')),
        getDocs(collection(db, 'batches')),
        getDocs(
          query(collection(db, 'leads'), where('phoneNumber', '==', '9825099887'))
        ),
        getDocs(
          query(collection(db, 'leads'), where('altNumber', '==', '9825099887'))
        ),
      ]);

    const docsToDeleteMap = new Map<string, ReturnType<typeof doc>>();

    leadsSnap.forEach((d) => {
      const data = { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) };
      if (isLegacyMockOrSyntheticLead(data)) {
        docsToDeleteMap.set(`leads/${d.id}`, doc(db, 'leads', d.id));
        deletedIds.push(d.id);
      }
    });

    byPhoneSnap.forEach((d) => {
      docsToDeleteMap.set(`leads/${d.id}`, doc(db, 'leads', d.id));
      if (!deletedIds.includes(d.id)) deletedIds.push(d.id);
    });

    byAltPhoneSnap.forEach((d) => {
      docsToDeleteMap.set(`leads/${d.id}`, doc(db, 'leads', d.id));
      if (!deletedIds.includes(d.id)) deletedIds.push(d.id);
    });

    batchesSnap.forEach((d) => {
      const data = d.data() as BatchRecord;
      if (isLegacyMockBatch(data)) {
        docsToDeleteMap.set(`batches/${d.id}`, doc(db, 'batches', d.id));
      }
    });

    const docsToDelete = Array.from(docsToDeleteMap.values());
    const chunks = chunkArray(docsToDelete, 450);
    for (const chunk of chunks) {
      const wb = writeBatch(db);
      for (const ref of chunk) {
        wb.delete(ref);
      }
      await wb.commit();
    }
  } catch {
    // Non-blocking if Firestore rules restrict delete or offline
  }

  return deletedIds;
}

export function loadAuthorizedUsers(): AuthorizedUser[] {
  purgeDeprecatedBrowserStorageKeys();
  return INITIAL_AUTHORIZED_USERS;
}

export function saveAuthorizedUsers(_users: AuthorizedUser[]): void {
  purgeDeprecatedBrowserStorageKeys();
}

/**
 * Pure helper to verify an entered email against an authorized roles array (`config/roles`).
 * Returns `{ success: false, error: 'Access denied. Unregistered email.' }` if not found or `status !== 'active'`.
 */
export function verifyEmailInRolesListPure(
  enteredEmail: string,
  roles: AuthorizedUser[] = INITIAL_AUTHORIZED_USERS
): {
  success: boolean;
  user?: { email: string; name: string; role: AuthorizedUser['role']; status: 'active' };
  error?: string;
} {
  const normalized = (enteredEmail || '').toLowerCase().trim();
  if (!normalized) {
    return {
      success: false,
      error: 'Access denied. Unregistered email.',
    };
  }

  const matched = roles.find(
    (u) => u.email.toLowerCase().trim() === normalized && u.status === 'active'
  );

  if (!matched) {
    return {
      success: false,
      error: 'Access denied. Unregistered email.',
    };
  }

  return {
    success: true,
    user: {
      email: matched.email.toLowerCase().trim(),
      name: matched.name,
      role: matched.role,
      status: 'active',
    },
  };
}

/**
 * Fetches authorized users from Firestore `config/roles` with fallback to initialized roles.
 */
export async function fetchAuthorizedRolesFromFirestore(): Promise<AuthorizedUser[]> {
  const localUsers = loadAuthorizedUsers();
  try {
    const roleDoc = await getDoc(doc(db, 'config', 'roles'));
    if (roleDoc.exists()) {
      const data = roleDoc.data();
      if (Array.isArray(data?.users) && data.users.length > 0) {
        const mergedMap = new Map<string, AuthorizedUser>();
        for (const u of data.users as AuthorizedUser[]) {
          if (u?.email) mergedMap.set(u.email.toLowerCase(), u);
        }
        for (const u of localUsers) mergedMap.set(u.email.toLowerCase(), u);
        const merged = Array.from(mergedMap.values());
        saveAuthorizedUsers(merged);
        return merged;
      }
    } else {
      await setDoc(doc(db, 'config', 'roles'), {
        users: localUsers,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch {
    // Firestore offline or restricted rules -> return localUsers
  }
  return localUsers;
}

/**
 * Queries Firestore `config/roles` (both subcollection `config/roles/users` where `email == enteredEmail.toLowerCase().trim()`
 * and `config/roles` document) to verify user role and active status.
 */
export async function verifyRoleInFirestore(enteredEmail: string): Promise<{
  success: boolean;
  user?: AuthorizedUser;
  error?: string;
}> {
  const normalizedEmail = (enteredEmail || '').toLowerCase().trim();
  if (!normalizedEmail) {
    return {
      success: false,
      error: 'Access denied. Unregistered email.',
    };
  }

  try {
    const usersQuery = query(
      collection(db, 'config', 'roles', 'users'),
      where('email', '==', normalizedEmail)
    );
    const snap = await getDocs(usersQuery);
    if (!snap.empty) {
      const docData = snap.docs[0].data() as AuthorizedUser;
      if (docData && docData.status === 'active') {
        return {
          success: true,
          user: {
            email: docData.email.toLowerCase().trim(),
            name: docData.name,
            role: docData.role,
            status: 'active',
          },
        };
      }
      return {
        success: false,
        error: 'Access denied. Unregistered email.',
      };
    }
  } catch {
    // Fallback to config/roles document & synchronized roles
  }

  const currentRoles = await fetchAuthorizedRolesFromFirestore();
  const res = verifyEmailInRolesListPure(normalizedEmail, currentRoles);
  if (!res.success || !res.user) {
    return {
      success: false,
      error: 'Access denied. Unregistered email.',
    };
  }

  return {
    success: true,
    user: res.user,
  };
}

/**
 * Splits an array into chunks of `size` (e.g., 30 for Firestore `in` queries).
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Task 3: Computes `cooldownUntil` and `nextFollowUpDate` based on lead status:
 * - `cooldownUntil`: `baseDateIso + 48 hours` when status is `'DIDNT_RECEIVE'`
 * - `nextFollowUpDate`: `baseDateIso + 2 days` for `'PROPOSAL_SHARED'`, `baseDateIso + 30 days` for `'FUTURE_REQUIREMENT'`
 */
export function computeOperationalDatesForStatus(
  status: LeadStatus,
  baseDateIso: string
): { cooldownUntil: string | null; nextFollowUpDate: string | null } {
  const baseMs = new Date(baseDateIso).getTime();
  if (Number.isNaN(baseMs)) {
    return { cooldownUntil: null, nextFollowUpDate: null };
  }

  const cooldownUntil =
    status === 'DIDNT_RECEIVE' || status === 'SWITCH_OFF'
      ? new Date(baseMs + 48 * 60 * 60 * 1000).toISOString()
      : null;

  let nextFollowUpDate: string | null = null;
  if (status === 'PROPOSAL_SHARED') {
    nextFollowUpDate = new Date(baseMs + 2 * 24 * 60 * 60 * 1000).toISOString();
  } else if (status === 'FUTURE_REQUIREMENT') {
    nextFollowUpDate = new Date(baseMs + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  return { cooldownUntil, nextFollowUpDate };
}

/**
 * Permanently updates a lead's companyName and companyNameNormalized, setting `isNameManuallyEdited = true`
 * so future Excel re-uploads and daily reset sweeps never overwrite the corrected company name.
 */
export function applyManualCompanyNameEditPure(
  lead: LeadRecord,
  newCompanyName: string,
  nowIso: string = new Date().toISOString()
): LeadRecord {
  const newTrimmedCompanyName = String(newCompanyName || '').trim();
  if (!newTrimmedCompanyName) {
    return lead;
  }

  return sanitizeFirestorePayload({
    ...lead,
    companyName: newTrimmedCompanyName,
    companyNameNormalized: newTrimmedCompanyName.toLowerCase(),
    isNameManuallyEdited: true,
    updatedAt: nowIso,
  });
}

/**
 * Task 2.3 & Upgrade Section 5 Overwrite Duplicates:
 * - When the incoming row is a Fresh untouched row (`!incoming.importedStatus || incoming.importedStatus === 'FRESH'`),
 *   updates meta fields (`state`, `city`, `email`, `altNumber` if newly provided) while strictly preserving existing
 *   `status`, `assignedRepEmail`, `assignedRepName`, `callAttempts`, `didntReceiveCount`, `switchOffCount`, and historical `notes` / `callHistory`.
 * - When the incoming row carries a Historical Status (`incoming.importedStatus && incoming.importedStatus !== 'FRESH'`),
 *   applies the historical state machine rules so uploading an updated status sheet updates previously uploaded fresh leads.
 * - If `existing.isNameManuallyEdited === true`, NEVER overwrites `companyName` or `companyNameNormalized` with the spreadsheet's old company name.
 */
export function mergeDuplicateLeadRecord(
  existing: LeadRecord,
  incoming: SanitizedRowItem,
  nowIso: string = new Date().toISOString(),
  options?: {
    employees?: EmployeeMatchCandidate[];
    uploaderUser?: { email: string; name: string } | null;
  }
): LeadRecord {
  const enrichedIncoming =
    incoming.importedStatus !== undefined
      ? incoming
      : enrichSanitizedRowWithHistoricalFieldsPure(incoming, {
          employees: options?.employees,
          uploaderUser: options?.uploaderUser,
          nowIso,
        });

  const isManuallyEditedName = existing.isNameManuallyEdited === true;
  const incomingTrimmedName = (enrichedIncoming.companyName || '').trim();
  const resolvedCompanyName = isManuallyEditedName
    ? existing.companyName
    : incomingTrimmedName || existing.companyName;
  const resolvedCompanyNameNormalized = isManuallyEditedName
    ? existing.companyNameNormalized || existing.companyName.toLowerCase()
    : incomingTrimmedName
    ? enrichedIncoming.companyNameNormalized || incomingTrimmedName.toLowerCase()
    : existing.companyNameNormalized;

  const hasHistoricalActivity =
    (enrichedIncoming.importedStatus &&
      enrichedIncoming.importedStatus !== 'FRESH') ||
    Boolean(
      enrichedIncoming.dateOfCalling?.trim() ||
        enrichedIncoming.salesPersonRaw?.trim() ||
        enrichedIncoming.remarks?.trim()
    );

  if (hasHistoricalActivity) {
    const historicalUpdated = buildLeadRecordFromSanitizedRowPure(enrichedIncoming, {
      id: existing.id,
      employees: options?.employees,
      uploaderUser: options?.uploaderUser,
      nowIso,
    });

    const combinedHistory = [
      ...(existing.callHistory || []),
      ...(historicalUpdated.callHistory || []),
    ];

    return {
      ...existing,
      ...historicalUpdated,
      id: existing.id,
      companyName: resolvedCompanyName,
      companyNameNormalized: resolvedCompanyNameNormalized,
      isNameManuallyEdited: isManuallyEditedName ? true : existing.isNameManuallyEdited,
      altNumber: enrichedIncoming.altNumber || existing.altNumber || null,
      state: enrichedIncoming.state || existing.state || null,
      city: enrichedIncoming.city || existing.city || null,
      email: enrichedIncoming.email || existing.email || null,
      lastCalledByEmail:
        historicalUpdated.lastCalledByEmail || existing.lastCalledByEmail || null,
      lastCalledByName:
        historicalUpdated.lastCalledByName || existing.lastCalledByName || null,
      callAttempts: Math.max(
        (existing.callAttempts || 0) + 1,
        historicalUpdated.callAttempts || 1
      ),
      callCount: Math.max(
        (existing.callCount ?? existing.callAttempts ?? 0) + 1,
        historicalUpdated.callAttempts || 1
      ),
      didntReceiveCount:
        enrichedIncoming.importedStatus === 'DIDNT_RECEIVE'
          ? (existing.didntReceiveCount || 0) + 1
          : existing.didntReceiveCount || 0,
      switchOffCount:
        enrichedIncoming.importedStatus === 'SWITCH_OFF'
          ? (existing.switchOffCount || 0) + 1
          : existing.switchOffCount || 0,
      notes: enrichedIncoming.remarks
        ? existing.notes && !existing.notes.startsWith('Ingested via')
          ? `${existing.notes} | ${historicalUpdated.notes}`
          : historicalUpdated.notes
        : existing.notes || historicalUpdated.notes,
      callHistory: combinedHistory.length > 0 ? combinedHistory : existing.callHistory,
      createdAt: existing.createdAt || nowIso,
      updatedAt: nowIso,
    };
  }

  return {
    ...existing,
    companyName: resolvedCompanyName,
    companyNameNormalized: resolvedCompanyNameNormalized,
    isNameManuallyEdited: isManuallyEditedName ? true : existing.isNameManuallyEdited,
    altNumber: incoming.altNumber || existing.altNumber || null,
    state: incoming.state || existing.state || null,
    city: incoming.city || existing.city || null,
    email: incoming.email || existing.email || null,
    status: existing.status,
    assignedBatchId: existing.assignedBatchId,
    assignedRepEmail: existing.assignedRepEmail,
    assignedRepName: existing.assignedRepName,
    lastCalledByEmail: existing.lastCalledByEmail || null,
    lastCalledByName: existing.lastCalledByName || null,
    callAttempts: existing.callAttempts,
    didntReceiveCount: existing.didntReceiveCount,
    switchOffCount: existing.switchOffCount,
    lastCalledDate: existing.lastCalledDate,
    cooldownUntil: existing.cooldownUntil,
    nextFollowUpDate: existing.nextFollowUpDate,
    notes: existing.notes,
    callHistory: existing.callHistory,
    updatedAt: nowIso,
  };
}

export interface SingleLeadDuplicateMatch {
  lead: LeadRecord;
  matchType: 'PRIMARY_PHONE' | 'ALT_PHONE' | 'COMPANY_NAME';
  reason: string;
}

/**
 * Pure duplicate lookup for a single lead against an array of existing leads.
 */
export function checkSingleLeadDuplicatePure(
  params: {
    companyName?: string;
    cleanedPrimaryPhone?: string;
    formattedPrimaryPhone?: string;
    cleanedAltPhone?: string | null;
    formattedAltPhone?: string | null;
  },
  existingLeads: LeadRecord[]
): SingleLeadDuplicateMatch | null {
  const normCompany = params.companyName ? normalizeCompanyName(params.companyName) : '';
  const cleanPrimary = params.cleanedPrimaryPhone || '';
  const cleanAlt = params.cleanedAltPhone || '';

  if (!normCompany && !cleanPrimary && !cleanAlt) return null;

  for (const existing of existingLeads) {
    if (
      cleanPrimary &&
      (existing.phoneNumber === cleanPrimary || existing.altNumber === cleanPrimary)
    ) {
      return {
        lead: existing,
        matchType: 'PRIMARY_PHONE',
        reason: `Primary phone ${params.formattedPrimaryPhone || cleanPrimary} already belongs to "${existing.companyName}"`,
      };
    }
    if (
      cleanAlt &&
      (existing.phoneNumber === cleanAlt || existing.altNumber === cleanAlt)
    ) {
      return {
        lead: existing,
        matchType: 'ALT_PHONE',
        reason: `Alternative phone ${params.formattedAltPhone || cleanAlt} already belongs to "${existing.companyName}"`,
      };
    }
    if (normCompany.length >= 3 && existing.companyNameNormalized === normCompany) {
      return {
        lead: existing,
        matchType: 'COMPANY_NAME',
        reason: `Normalized company name matches existing record "${existing.companyName}" (${existing.formattedPhone})`,
      };
    }
  }

  return null;
}

/**
 * Task 2.4: Immediate Firestore + local duplicate check triggered on input blur in AddLeadModal.
 */
export async function checkSingleLeadDuplicateInFirestore(
  params: {
    companyName?: string;
    cleanedPrimaryPhone?: string;
    formattedPrimaryPhone?: string;
    cleanedAltPhone?: string | null;
    formattedAltPhone?: string | null;
  },
  existingLeadsInMemory: LeadRecord[]
): Promise<SingleLeadDuplicateMatch | null> {
  const combinedMap = new Map<string, LeadRecord>();
  for (const lead of existingLeadsInMemory) {
    combinedMap.set(lead.id, lead);
  }

  const phonesToCheck = [params.cleanedPrimaryPhone, params.cleanedAltPhone].filter(
    (p): p is string => Boolean(p && p.length === 10)
  );
  const normCompany = params.companyName ? normalizeCompanyName(params.companyName) : '';

  const hasConfiguredProject = hasLiveReachFirebaseConfig();

  if (hasConfiguredProject && (phonesToCheck.length > 0 || normCompany.length >= 3)) {
    try {
      await Promise.race([
        (async () => {
          if (phonesToCheck.length > 0) {
            const [snapPrimary, snapAlt] = await Promise.all([
              getDocs(query(collection(db, 'leads'), where('phoneNumber', 'in', phonesToCheck))),
              getDocs(query(collection(db, 'leads'), where('altNumber', 'in', phonesToCheck))),
            ]);
            snapPrimary.forEach((d) =>
              combinedMap.set(d.id, { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) })
            );
            snapAlt.forEach((d) =>
              combinedMap.set(d.id, { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) })
            );
          }
          if (normCompany.length >= 3) {
            const snapComp = await getDocs(
              query(collection(db, 'leads'), where('companyNameNormalized', '==', normCompany))
            );
            snapComp.forEach((d) =>
              combinedMap.set(d.id, { id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) })
            );
          }
        })().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 900)),
      ]);
    } catch {
      // Fallback to in-memory index
    }
  }

  return checkSingleLeadDuplicatePure(params, Array.from(combinedMap.values()));
}

export type LeadCollisionScenario =
  | 'SCENARIO_A_UNCLAIMED_OR_COLD'
  | 'SCENARIO_B_OWNED_BY_SAME_REP'
  | 'SCENARIO_C_OWNED_BY_ANOTHER_REP';

const UNCLAIMED_OR_COLD_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'FRESH',
  'REVIVED_FRESH',
  'DIDNT_RECEIVE',
  'SWITCH_OFF',
  'NOT_INTERESTED',
  'DIDNT_RECEIVE_DEAD',
  'SWITCH_OFF_DEAD',
  'NOT_A_SOLAR_COMPANY',
  'LEAD_LOST',
]);

const ACTIVE_REP_PIPELINE_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'PROPOSAL_SHARED',
  'FUTURE_REQUIREMENT',
  'INTERESTED',
  'CLOSED_WON',
]);

/**
 * Classifies an existing duplicate lead into one of the three collision scenarios:
 * - Scenario A (`SCENARIO_A_UNCLAIMED_OR_COLD`): Lead is in `FRESH`, `DIDNT_RECEIVE`, `SWITCH_OFF`,
 *   `NOT_INTERESTED`, `DIDNT_RECEIVE_DEAD`, `SWITCH_OFF_DEAD` (or has no assigned rep).
 * - Scenario B (`SCENARIO_B_OWNED_BY_SAME_REP`): Lead is owned by the same logged-in sales rep (`assignedRepEmail === currentUser.email`).
 * - Scenario C (`SCENARIO_C_OWNED_BY_ANOTHER_REP`): Lead is owned by another sales rep (`Sales Person A`)
 *   in `PROPOSAL_SHARED`, `FUTURE_REQUIREMENT`, or `INTERESTED` (or `CLOSED_WON`).
 */
export function classifyLeadCollisionScenarioPure(
  existingLead: LeadRecord,
  currentUserEmail?: string | null
): LeadCollisionScenario {
  const actorEmail = String(currentUserEmail || '').trim().toLowerCase();
  const ownerEmail = String(existingLead.assignedRepEmail || '').trim().toLowerCase();
  const hasAssignedOwner = Boolean(
    ownerEmail || (existingLead.assignedRepName && existingLead.assignedRepName.trim())
  );

  // If lead status is in the active pipeline (PROPOSAL_SHARED, FUTURE_REQUIREMENT, INTERESTED, CLOSED_WON)
  if (ACTIVE_REP_PIPELINE_STATUSES.has(existingLead.status)) {
    if (actorEmail && ownerEmail && actorEmail === ownerEmail) {
      return 'SCENARIO_B_OWNED_BY_SAME_REP';
    }
    if (hasAssignedOwner) {
      return 'SCENARIO_C_OWNED_BY_ANOTHER_REP';
    }
    return 'SCENARIO_A_UNCLAIMED_OR_COLD';
  }

  // If lead is explicitly in an unclaimed or cold status, allow Claim & Update (Scenario A),
  // unless it is owned by the exact same logged-in sales rep and not FRESH/REVIVED_FRESH
  if (UNCLAIMED_OR_COLD_STATUSES.has(existingLead.status)) {
    return 'SCENARIO_A_UNCLAIMED_OR_COLD';
  }

  if (actorEmail && ownerEmail && actorEmail === ownerEmail) {
    return 'SCENARIO_B_OWNED_BY_SAME_REP';
  }

  return 'SCENARIO_A_UNCLAIMED_OR_COLD';
}

/**
 * Scenario A (`[Claim & Update Existing Lead]`) & Scenario B (`[Update My Existing Lead Status & Notes]`):
 * Updates the existing lead document in place without creating a duplicate.
 * - Sets `status` to the newly selected status (`PROPOSAL_SHARED`, `INTERESTED`, etc.).
 * - Assigns `assignedRepEmail = currentUser.email` and `assignedRepName = currentUser.name`.
 * - Appends the call note and updates `lastCalledDate = nowIso`.
 */
export function applyClaimOrUpdateExistingLeadPure(
  existingLead: LeadRecord,
  params: {
    newStatus: LeadStatus;
    currentUser: { email: string; name: string };
    noteText?: string;
    altNumber?: string | null;
    state?: string | null;
    city?: string | null;
    email?: string | null;
    nowIso?: string;
  }
): LeadRecord {
  const nowIso = params.nowIso || new Date().toISOString();
  const repEmail = params.currentUser.email.trim().toLowerCase();
  const repName = params.currentUser.name.split(' (')[0].trim() || 'Sales Rep';
  const trimmedNote = (params.noteText || '').trim();
  const { cooldownUntil, nextFollowUpDate } = computeOperationalDatesForStatus(
    params.newStatus,
    nowIso
  );

  const appendedNotes = trimmedNote
    ? existingLead.notes && !existingLead.notes.startsWith('Ingested via')
      ? `${existingLead.notes} | ${trimmedNote}`
      : trimmedNote
    : existingLead.notes || `Updated status to ${params.newStatus} by ${repName}`;

  const logEntry = {
    id: `log-${Date.now()}`,
    timestamp: nowIso,
    repEmail,
    repName,
    previousStatus: existingLead.status,
    newStatus: params.newStatus,
    note: trimmedNote || `Claimed & updated to ${params.newStatus}`,
  };

  return {
    ...existingLead,
    altNumber: params.altNumber || existingLead.altNumber || null,
    state: params.state || existingLead.state || null,
    city: params.city || existingLead.city || null,
    email: params.email || existingLead.email || null,
    status: params.newStatus,
    assignedRepEmail: repEmail,
    assignedRepName: repName,
    lastCalledDate: nowIso,
    lastCalledByEmail: repEmail,
    lastCalledByName: repName,
    callAttempts: (existingLead.callAttempts || 0) + 1,
    callCount: (existingLead.callCount ?? existingLead.callAttempts ?? 0) + 1,
    didntReceiveCount:
      params.newStatus === 'DIDNT_RECEIVE'
        ? (existingLead.didntReceiveCount || 0) + 1
        : existingLead.didntReceiveCount || 0,
    switchOffCount:
      params.newStatus === 'SWITCH_OFF'
        ? (existingLead.switchOffCount || 0) + 1
        : existingLead.switchOffCount || 0,
    interestedAt:
      params.newStatus === 'INTERESTED' || params.newStatus === 'CLOSED_WON'
        ? existingLead.interestedAt || nowIso
        : existingLead.interestedAt || null,
    closedWonAt:
      params.newStatus === 'CLOSED_WON'
        ? existingLead.closedWonAt || nowIso
        : existingLead.closedWonAt || null,
    ownerSubStatus:
      params.newStatus === 'INTERESTED'
        ? existingLead.ownerSubStatus || 'PENDING_FIRST_CALL'
        : params.newStatus === 'CLOSED_WON'
        ? 'WON'
        : existingLead.ownerSubStatus || null,
    ownerCallAttempts: existingLead.ownerCallAttempts || 0,
    cooldownUntil,
    nextFollowUpDate,
    notes: appendedNotes,
    callHistory: [...(existingLead.callHistory || []), logEntry],
    updatedAt: nowIso,
  };
}

/**
 * Scenario C (`[Escalate to Owner Queue (Client Ready Now)]`):
 * Atomically updates an existing lead owned by Sales Person A (`PROPOSAL_SHARED`, `FUTURE_REQUIREMENT`, `INTERESTED`)
 * when Sales Person B speaks with the client and the client commits to awarding a project immediately:
 * 1. Sets `status = 'INTERESTED'` so it surfaces at the top of the Owner Closing Queue.
 * 2. Preserves `assignedRepEmail` and `assignedRepName` as Sales Person A (Originating / Proposal Rep).
 * 3. Saves `escalatedByEmail`, `escalatedByName`, `isDualRepEscalation = true`, `hotEscalationNote`, and `interestedAt`.
 * 4. Appends audit entry: `"[HOT ESCALATION by Sales Person B]: Client ready to award project now. Originally in [STATUS] with [Sales Person A]. Note: ..."`
 */
export function applyHotClientCrossRepEscalationPure(
  existingLead: LeadRecord,
  params: {
    escalatingUser: { email: string; name: string };
    urgentHandoverNote: string;
    altNumber?: string | null;
    state?: string | null;
    city?: string | null;
    email?: string | null;
    nowIso?: string;
  }
): LeadRecord {
  const noteText = (params.urgentHandoverNote || '').trim();
  if (!noteText) {
    throw new Error('Urgent Handover Note is mandatory to escalate this client.');
  }

  const nowIso = params.nowIso || new Date().toISOString();
  const repBEmail = params.escalatingUser.email.trim().toLowerCase();
  const repBName = params.escalatingUser.name.split(' (')[0].trim() || 'Sales Rep';
  const repAName =
    (existingLead.assignedRepName || existingLead.assignedRepEmail || 'Assigned Rep')
      .split(' (')[0]
      .trim();
  const previousStatus = existingLead.status;

  const auditEntry = `[HOT ESCALATION by ${repBName}]: Client ready to award project now. Originally in ${previousStatus} with ${repAName}. Note: ${noteText}`;
  const updatedNotes =
    existingLead.notes && !existingLead.notes.startsWith('Ingested via')
      ? `${existingLead.notes} | ${auditEntry}`
      : auditEntry;

  const logEntry = {
    id: `log-hot-${Date.now()}`,
    timestamp: nowIso,
    repEmail: repBEmail,
    repName: repBName,
    previousStatus,
    newStatus: 'INTERESTED' as LeadStatus,
    note: auditEntry,
  };

  return {
    ...existingLead,
    altNumber: params.altNumber || existingLead.altNumber || null,
    state: params.state || existingLead.state || null,
    city: params.city || existingLead.city || null,
    email: params.email || existingLead.email || null,
    status: 'INTERESTED',
    // Strictly preserve Sales Person A as Originating / Proposal Rep
    assignedRepEmail: existingLead.assignedRepEmail,
    assignedRepName: existingLead.assignedRepName,
    // Dual-rep escalation metadata for Sales Person B
    escalatedByEmail: repBEmail,
    escalatedByName: repBName,
    isDualRepEscalation: true,
    hotEscalationNote: noteText,
    ownerSubStatus: existingLead.ownerSubStatus || 'PENDING_FIRST_CALL',
    ownerCallAttempts: existingLead.ownerCallAttempts || 0,
    interestedAt: nowIso,
    lastCalledDate: nowIso,
    callAttempts: (existingLead.callAttempts || 0) + 1,
    callCount: (existingLead.callCount ?? existingLead.callAttempts ?? 0) + 1,
    cooldownUntil: null,
    nextFollowUpDate: null,
    notes: updatedNotes,
    callHistory: [...(existingLead.callHistory || []), logEntry],
    updatedAt: nowIso,
  };
}

/**
 * Formats the `"Co-Escalated: [Rep A] + [Rep B]"` pill text for dual-rep escalated leads.
 */
export function formatCoEscalatedPillText(
  lead: Partial<LeadRecord> | null | undefined
): string | null {
  if (!lead || !lead.isDualRepEscalation || !lead.escalatedByName) {
    return null;
  }
  const repA =
    (lead.assignedRepName || lead.assignedRepEmail || 'Rep A')
      .split(' (')[0]
      .trim();
  const repB = lead.escalatedByName.split(' (')[0].trim();
  return `Co-Escalated: ${repA} + ${repB}`;
}

export interface PreFlightIngestionAudit {
  validFreshLeads: SanitizedRowItem[];
  duplicatesDetected: DuplicateConflict[];
  malformedRows: MalformedRowError[];
}

/**
 * Performs Pre-Flight Sanitization & Batched Duplicate Check against Firestore + Local Store:
 * 1. Runs `sanitizeIndianPhone` (`sanitizePhoneNumber`) on `Phone Number` and `Alternative Number`.
 * 2. Queries Firestore `leads` in batched chunks comparing incoming cleaned 10-digit numbers
 *    against stored `phoneNumber` and `altNumber`, plus secondary check on `companyNameNormalized`.
 * 3. Returns structured pre-flight audit results.
 */
export async function runPreFlightIngestionCheck(
  rawRows: RawSheetRow[],
  existingLeadsInMemory: LeadRecord[],
  options?: {
    employees?: EmployeeMatchCandidate[];
    uploaderUser?: { email: string; name: string } | null;
    nowIso?: string;
  }
): Promise<PreFlightIngestionAudit> {
  const validCandidates: SanitizedRowItem[] = [];
  const malformedRows: MalformedRowError[] = [];
  const seenPhonesInSheet = new Set<string>();
  const seenCompaniesInSheet = new Set<string>();

  for (const row of rawRows) {
    const companyTrimmed = (row.companyName || '').trim();
    if (!companyTrimmed) {
      malformedRows.push({
        rowNumber: row.rowNumber,
        companyName: '(Missing Company Name)',
        rawPhone: row.phoneNumberRaw || '',
        rawAltPhone: row.altNumberRaw,
        reason: 'Missing mandatory Company Name',
      });
      continue;
    }

    const primarySanitized = sanitizeIndianPhone(row.phoneNumberRaw);
    if (!primarySanitized.isValid) {
      malformedRows.push({
        rowNumber: row.rowNumber,
        companyName: companyTrimmed,
        rawPhone: row.phoneNumberRaw || '',
        rawAltPhone: row.altNumberRaw,
        reason: `Primary Phone invalid: ${primarySanitized.error || 'Malformed phone'}`,
      });
      continue;
    }

    let altCleaned: string | null = null;
    let altFormatted: string | null = null;
    if (row.altNumberRaw && String(row.altNumberRaw).trim() !== '') {
      const altSanitized = sanitizeIndianPhone(row.altNumberRaw);
      if (!altSanitized.isValid) {
        malformedRows.push({
          rowNumber: row.rowNumber,
          companyName: companyTrimmed,
          rawPhone: row.phoneNumberRaw || '',
          rawAltPhone: row.altNumberRaw,
          reason: `Alternative Number invalid: ${altSanitized.error}`,
        });
        continue;
      }
      altCleaned = altSanitized.cleaned;
      altFormatted = altSanitized.formatted;
    }

    const companyNormalized = normalizeCompanyName(companyTrimmed);

    if (
      seenPhonesInSheet.has(primarySanitized.cleaned) ||
      seenCompaniesInSheet.has(companyNormalized)
    ) {
      malformedRows.push({
        rowNumber: row.rowNumber,
        companyName: companyTrimmed,
        rawPhone: row.phoneNumberRaw || '',
        rawAltPhone: row.altNumberRaw,
        reason: `Duplicate phone (${primarySanitized.cleaned}) or company name repeated within the same upload file`,
      });
      continue;
    }
    seenPhonesInSheet.add(primarySanitized.cleaned);
    seenCompaniesInSheet.add(companyNormalized);

    const baseItem: SanitizedRowItem = {
      rowNumber: row.rowNumber,
      companyName: companyTrimmed,
      companyNameNormalized: companyNormalized,
      phoneNumber: primarySanitized.cleaned,
      formattedPhone: primarySanitized.formatted,
      altNumber: altCleaned,
      formattedAltPhone: altFormatted,
      state: row.state?.trim() || undefined,
      city: row.city?.trim() || undefined,
      email: row.email?.trim() || undefined,
      dateOfCalling: row.dateOfCalling?.trim() || undefined,
      statusRaw: row.statusRaw?.trim() || undefined,
      salesPersonRaw: row.salesPersonRaw?.trim() || undefined,
      remarks: row.remarksRaw?.trim() || undefined,
    };

    validCandidates.push(
      enrichSanitizedRowWithHistoricalFieldsPure(baseItem, {
        employees: options?.employees,
        uploaderUser: options?.uploaderUser,
        nowIso: options?.nowIso,
      })
    );
  }

  // Build lookup indexes from existing leads + batched Firestore queries
  const byPrimaryPhone = new Map<string, LeadRecord>();
  const byAltPhone = new Map<string, LeadRecord>();
  const byCompanyNormalized = new Map<string, LeadRecord>();

  const indexLead = (lead: LeadRecord) => {
    if (lead.phoneNumber) byPrimaryPhone.set(lead.phoneNumber, lead);
    if (lead.altNumber) byAltPhone.set(lead.altNumber, lead);
    if (lead.companyNameNormalized) {
      byCompanyNormalized.set(lead.companyNameNormalized, lead);
    }
  };

  for (const lead of existingLeadsInMemory) {
    indexLead(lead);
  }

  const hasConfiguredProject = hasLiveReachFirebaseConfig();

  if (hasConfiguredProject && validCandidates.length > 0) {
    const allCandidateNumbers = Array.from(
      new Set(
        validCandidates.flatMap((c) =>
          c.altNumber ? [c.phoneNumber, c.altNumber] : [c.phoneNumber]
        )
      )
    );
    const allCandidateCompanies = Array.from(
      new Set(validCandidates.map((c) => c.companyNameNormalized).filter(Boolean))
    );

    const phoneChunks = chunkArray(allCandidateNumbers, 25);
    const companyChunks = chunkArray(allCandidateCompanies, 25);

    try {
      await Promise.race([
        (async () => {
          for (const chunk of phoneChunks) {
            if (chunk.length === 0) continue;
            const [snapPrimary, snapAlt] = await Promise.all([
              getDocs(query(collection(db, 'leads'), where('phoneNumber', 'in', chunk))),
              getDocs(query(collection(db, 'leads'), where('altNumber', 'in', chunk))),
            ]);
            snapPrimary.forEach((docSnap) => {
              indexLead({ id: docSnap.id, ...(docSnap.data() as Omit<LeadRecord, 'id'>) });
            });
            snapAlt.forEach((docSnap) => {
              indexLead({ id: docSnap.id, ...(docSnap.data() as Omit<LeadRecord, 'id'>) });
            });
          }
          for (const compChunk of companyChunks) {
            if (compChunk.length === 0) continue;
            const snapComp = await getDocs(
              query(collection(db, 'leads'), where('companyNameNormalized', 'in', compChunk))
            );
            snapComp.forEach((docSnap) => {
              indexLead({ id: docSnap.id, ...(docSnap.data() as Omit<LeadRecord, 'id'>) });
            });
          }
        })().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {
      // Firestore query skipped or restricted; memory index already populated
    }
  }

  const validFreshLeads: SanitizedRowItem[] = [];
  const duplicatesDetected: DuplicateConflict[] = [];

  for (const candidate of validCandidates) {
    const primaryHit =
      byPrimaryPhone.get(candidate.phoneNumber) ||
      byAltPhone.get(candidate.phoneNumber) ||
      (candidate.altNumber ? byPrimaryPhone.get(candidate.altNumber) : undefined);

    const altHit =
      !primaryHit && candidate.altNumber ? byAltPhone.get(candidate.altNumber) : undefined;

    const companyHit =
      !primaryHit && !altHit
        ? byCompanyNormalized.get(candidate.companyNameNormalized)
        : undefined;

    if (primaryHit) {
      duplicatesDetected.push({
        rowNumber: candidate.rowNumber,
        incoming: candidate,
        existingLead: primaryHit,
        matchReason: 'PRIMARY_PHONE',
      });
    } else if (altHit) {
      duplicatesDetected.push({
        rowNumber: candidate.rowNumber,
        incoming: candidate,
        existingLead: altHit,
        matchReason: 'ALT_PHONE',
      });
    } else if (companyHit) {
      duplicatesDetected.push({
        rowNumber: candidate.rowNumber,
        incoming: candidate,
        existingLead: companyHit,
        matchReason: 'COMPANY_NAME',
      });
    } else {
      validFreshLeads.push(candidate);
    }
  }

  return {
    validFreshLeads,
    duplicatesDetected,
    malformedRows,
  };
}

/**
 * Persists created/updated leads to Firestore (`reachDb`) in batched chunks of 400,
 * sanitizing payloads via `sanitizeFirestorePayload` and awaiting real server acknowledgment.
 * Surfaces any permission-denied or network error via `reportCloudSyncError`.
 */
export async function syncLeadsToFirestore(leadsToSync: LeadRecord[]): Promise<void> {
  const hasConfiguredProject = hasLiveReachFirebaseConfig();
  if (!hasConfiguredProject || leadsToSync.length === 0) return;

  const chunks = chunkArray(leadsToSync, 400);
  for (const chunk of chunks) {
    try {
      const batch = writeBatch(db);
      for (const lead of chunk) {
        const sanitizedLead = sanitizeFirestorePayload(lead);
        batch.set(doc(db, 'leads', lead.id), sanitizedLead, { merge: true });
      }
      await batch.commit();
    } catch (err) {
      reportCloudSyncError(err, 'syncLeadsToFirestore');
      throw err;
    }
  }
}

/**
 * Builds the explicit Firestore update payload for `doc(reachDb, 'leads', lead.id)`
 * with atomic `increment(1)` counters and 48-hour `cooldownUntil` for `DIDNT_RECEIVE` and `SWITCH_OFF`.
 */
export function buildLeadCallStatusUpdatePayloadPure(params: {
  existingLead?: Partial<LeadRecord> | null;
  updatedLead: LeadRecord;
  newStatus?: LeadStatus;
  currentUser?: { email: string; name: string } | null;
  nowIso?: string;
}): Record<string, unknown> {
  const nowIso =
    params.nowIso || params.updatedLead.updatedAt || new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  const baseMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
  const effectiveStatus = params.updatedLead.status;
  const rawNewStatus = params.newStatus || effectiveStatus;
  const existing = params.existingLead || params.updatedLead;

  const actorName =
    params.currentUser?.name ||
    params.updatedLead.lastCalledBy ||
    params.updatedLead.lastCalledByName ||
    params.updatedLead.assignedRepName ||
    '';
  const actorEmail = (
    params.currentUser?.email ||
    params.updatedLead.repEmail ||
    params.updatedLead.lastCalledByEmail ||
    params.updatedLead.assignedRepEmail ||
    ''
  )
    .trim()
    .toLowerCase();

  const isCooldownStatus =
    effectiveStatus === 'DIDNT_RECEIVE' || effectiveStatus === 'SWITCH_OFF';
  const cooldownUntil = isCooldownStatus
    ? params.updatedLead.cooldownUntil &&
      new Date(params.updatedLead.cooldownUntil).getTime() > baseMs
      ? params.updatedLead.cooldownUntil
      : new Date(baseMs + 48 * 60 * 60 * 1000).toISOString()
    : null;

  const formattedRepShortName = actorName ? formatRepName(actorName) : '';

  return {
    ...sanitizeFirestorePayload(params.updatedLead),
    status: effectiveStatus,
    assignedBatchId:
      effectiveStatus === 'FRESH' || effectiveStatus === 'REVIVED_FRESH'
        ? params.updatedLead.assignedBatchId || null
        : null,
    lastCalled: nowIso,
    lastCalledDate: params.updatedLead.lastCalledDate || nowIso,
    lastCalledBy: formattedRepShortName,
    lastCalledByName:
      params.updatedLead.lastCalledByName || actorName.split(' (')[0].trim(),
    repEmail: actorEmail,
    lastCalledByEmail: params.updatedLead.lastCalledByEmail || actorEmail,
    callAttempts: increment(1),
    didntReceiveCount:
      rawNewStatus === 'DIDNT_RECEIVE'
        ? increment(1)
        : existing.didntReceiveCount || 0,
    switchOffCount:
      rawNewStatus === 'SWITCH_OFF'
        ? increment(1)
        : existing.switchOffCount || 0,
    cooldownUntil,
    updatedAt: nowIso,
  };
}

/**
 * Direct Firestore helper to persist a lead call status update (`doc(reachDb, 'leads', lead.id)`).
 * Strictly awaits the Firestore write inside `try / catch`, reports errors via
 * `reportCloudSyncError(err, 'Lead Status Update')`, and rethrows so the UI surfaces a red error toast.
 */
export async function updateLeadCallStatus(params: {
  existingLead?: Partial<LeadRecord> | null;
  updatedLead: LeadRecord;
  newStatus?: LeadStatus;
  currentUser: { email: string; name: string };
  nowIso?: string;
}): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;
  try {
    const payload = buildLeadCallStatusUpdatePayloadPure(params);
    await setDoc(doc(db, 'leads', params.updatedLead.id), payload, {
      merge: true,
    });
  } catch (err) {
    reportCloudSyncError(err, 'Lead Status Update');
    throw err;
  }
}

/**
 * Requirement 1 & 2: Fast, Non-Blocking Atomic Call Outcome Persistence
 * Atomically commits the updated `LeadRecord` (with explicit `increment(1)` counters and 48h `cooldownUntil`),
 * the updated `BatchRecord` (`completedCallsCount` & `remainingLeads`),
 * and the rep's `daily_stats/{date}_{repEmail}` increment within the exact same Firestore `writeBatch`.
 * Strictly awaits `wb.commit()` inside `try / catch` and calls `reportCloudSyncError(err, 'Lead Status Update')` on failure.
 */
export async function commitCallOutcomeAtomicToFirestore(params: {
  updatedLead: LeadRecord;
  existingLead?: Partial<LeadRecord> | null;
  rawSelectedStatus?: LeadStatus;
  updatedBatch?: BatchRecord | null;
  actorUser?: { email: string; name: string } | null;
  isFirstTransitionFromFresh?: boolean;
}): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;
  try {
    const wb = writeBatch(db);
    const leadPayload = buildLeadCallStatusUpdatePayloadPure({
      existingLead: params.existingLead,
      updatedLead: params.updatedLead,
      newStatus: params.rawSelectedStatus || params.updatedLead.status,
      currentUser: params.actorUser,
      nowIso: params.updatedLead.updatedAt,
    });
    wb.set(doc(db, 'leads', params.updatedLead.id), leadPayload, {
      merge: true,
    });
    if (params.updatedBatch && params.updatedBatch.batchId) {
      wb.set(
        doc(db, 'batches', params.updatedBatch.batchId),
        sanitizeFirestorePayload(params.updatedBatch),
        { merge: true }
      );
    }
    if (params.actorUser && params.actorUser.email) {
      const resolved = resolveCanonicalRepIdentity(
        params.actorUser.email,
        params.actorUser.name
      );
      const emailLower = (resolved?.email || params.actorUser.email)
        .trim()
        .toLowerCase();
      const cleanName =
        resolved?.name ||
        String(params.actorUser.name || emailLower)
          .split(' (')[0]
          .trim();
      const dateYmd = (
        params.updatedLead.lastCalledDate ||
        params.updatedLead.updatedAt ||
        new Date().toISOString()
      ).slice(0, 10);

      if (emailLower && /^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
        const statId = `${dateYmd}_${emailLower}`;
        const newStatus = params.updatedLead.status;
        wb.set(
          doc(db, 'daily_stats', statId),
          {
            id: statId,
            date: dateYmd,
            repEmail: emailLower,
            repName: cleanName,
            callsCount: params.isFirstTransitionFromFresh
              ? increment(1)
              : increment(0),
            proposalsCount:
              newStatus === 'PROPOSAL_SHARED' ? increment(1) : increment(0),
            interestedCount:
              newStatus === 'INTERESTED' || newStatus === 'CLOSED_WON'
                ? increment(1)
                : increment(0),
            wonCount: newStatus === 'CLOSED_WON' ? increment(1) : increment(0),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }
    }
    await wb.commit();
  } catch (err) {
    reportCloudSyncError(err, 'Lead Status Update');
    throw err;
  }
}

export function formatOwnerSubStatusBadgePure(
  subStatus?: OwnerSubStatus | null
): { label: string; classes: string; effectiveSubStatus: OwnerSubStatus } {
  const effective: OwnerSubStatus = subStatus || 'PENDING_FIRST_CALL';
  switch (effective) {
    case 'DIDNT_RECEIVE_RETRY':
      return {
        label: "Owner Retry (Didn't Receive)",
        classes:
          'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/35',
        effectiveSubStatus: effective,
      };
    case 'SWITCH_OFF_RETRY':
      return {
        label: 'Owner Retry (Switch Off)',
        classes:
          'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/35',
        effectiveSubStatus: effective,
      };
    case 'QUOTE_SHARED':
      return {
        label: 'Quote Shared',
        classes: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/35',
        effectiveSubStatus: effective,
      };
    case 'SITE_VISIT_SCHEDULED':
      return {
        label: 'Site Visit Scheduled',
        classes:
          'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/35',
        effectiveSubStatus: effective,
      };
    case 'NEGOTIATION':
      return {
        label: 'Negotiation',
        classes:
          'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35',
        effectiveSubStatus: effective,
      };
    case 'FUTURE_PROJECT':
      return {
        label: 'Future Project',
        classes:
          'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/35',
        effectiveSubStatus: effective,
      };
    case 'WON':
      return {
        label: 'Closed Won',
        classes:
          'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
        effectiveSubStatus: effective,
      };
    case 'LOST':
      return {
        label: 'Lead Lost',
        classes:
          'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/35',
        effectiveSubStatus: effective,
      };
    case 'PENDING_FIRST_CALL':
    default:
      return {
        label: 'New Handover',
        classes:
          'bg-[#E5B842]/15 text-amber-800 dark:text-[#E5B842] border-[#E5B842]/40',
        effectiveSubStatus: 'PENDING_FIRST_CALL',
      };
  }
}

export function doesLeadMatchInterestedSubFilterPure(
  lead: LeadRecord,
  subFilter: InterestedSubFilter = 'ALL'
): boolean {
  if (subFilter === 'ALL') return true;
  const effectiveSub: OwnerSubStatus = lead.ownerSubStatus || 'PENDING_FIRST_CALL';
  if (subFilter === 'NEW_HANDOVER') {
    return effectiveSub === 'PENDING_FIRST_CALL';
  }
  if (subFilter === 'OWNER_RETRY') {
    return (
      effectiveSub === 'DIDNT_RECEIVE_RETRY' ||
      effectiveSub === 'SWITCH_OFF_RETRY'
    );
  }
  if (subFilter === 'QUOTE_NEGOTIATION') {
    return (
      effectiveSub === 'QUOTE_SHARED' ||
      effectiveSub === 'SITE_VISIT_SCHEDULED' ||
      effectiveSub === 'NEGOTIATION' ||
      effectiveSub === 'FUTURE_PROJECT'
    );
  }
  return true;
}

export type WorkspaceFilterTab =
  | 'TO_CALL_TODAY'
  | 'FRESH'
  | 'ALL_LEADS'
  | 'PROPOSAL_SHARED'
  | 'FUTURE_REQUIREMENT'
  | 'INTERESTED'
  | 'CALLS_DIALED_TODAY'
  | 'DEAD_CLOSED_OUT';

export interface WorkspaceTableFilterParams {
  leads: LeadRecord[];
  batches: BatchRecord[];
  tab: WorkspaceFilterTab;
  isOwner: boolean;
  userEmail: string;
  todayDate: string;
  nowIso?: string;
  dateFilter?: AnalyticsDateFilter | null;
  selectedBatchIdFilter?: string | null;
  selectedRepEmailFilter?: string | null;
  interestedSubFilter?: InterestedSubFilter;
  searchQuery?: string;
}

export interface WorkspaceTableFilterResult {
  filteredLeads: LeadRecord[];
  todayActiveBatches: BatchRecord[];
  repClaimedTodayBatch: BatchRecord | null;
  emptyStateMessage: string;
}

const DEAD_CLOSED_STATUSES_SET: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  'LEAD_LOST',
  'NOT_INTERESTED',
  'NOT_A_SOLAR_COMPANY',
  'SWITCH_OFF_DEAD',
  'DIDNT_RECEIVE_DEAD',
  'CLOSED_WON',
]);

function matchesSearchQueryOnLead(lead: LeadRecord, q: string): boolean {
  if (!q) return true;
  const matchName = lead.companyName.toLowerCase().includes(q);
  const matchPhone =
    lead.phoneNumber.includes(q) ||
    Boolean(lead.altNumber && lead.altNumber.includes(q));
  const matchLoc =
    Boolean(lead.city && lead.city.toLowerCase().includes(q)) ||
    Boolean(lead.state && lead.state.toLowerCase().includes(q));
  return matchName || matchPhone || matchLoc;
}

function isUntouchedFreshBatchLead(lead: LeadRecord): boolean {
  return (
    lead.status === 'FRESH' &&
    (lead.callAttempts || 0) === 0 &&
    (lead.didntReceiveCount || 0) === 0 &&
    (lead.switchOffCount || 0) === 0
  );
}

function sortBatchQueueUntouchedFirstRetriesTail(
  leads: LeadRecord[],
  batchLeadIds?: string[]
): LeadRecord[] {
  const indexMap = new Map<string, number>();
  if (Array.isArray(batchLeadIds)) {
    for (let i = 0; i < batchLeadIds.length; i++) {
      indexMap.set(batchLeadIds[i], i);
    }
  }
  return [...leads].sort((a, b) => {
    const priorityA = isUntouchedFreshBatchLead(a) ? 0 : 1;
    const priorityB = isUntouchedFreshBatchLead(b) ? 0 : 1;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    const idxA = indexMap.get(a.id);
    const idxB = indexMap.get(b.id);
    if (idxA !== undefined && idxB !== undefined && idxA !== idxB) {
      return idxA - idxB;
    }
    return 0;
  });
}

/**
 * Pure query/filter engine for the Outreach Workspace tabs & Top Metric Card Inspectors:
 * 0. `🔥 To-Call Today` (`TO_CALL_TODAY`): Strictly due/overdue warm follow-ups (`PROPOSAL_SHARED` & `FUTURE_REQUIREMENT`)
 * 1. `Today's Batch / Fresh` (`FRESH`)
 * 2. `All Leads & Attempt History` (`ALL_LEADS` — Owner Master Lead Table showing all leads with latest status updated)
 * 3. `Proposals Shared` (`PROPOSAL_SHARED`)
 * 4. `Future Requirement` (`FUTURE_REQUIREMENT`)
 * 5. `Interested (Owner Queue)` (`INTERESTED`)
 * 6. `Calls Dialed Today` (`CALLS_DIALED_TODAY`)
 * 7. `Dead / Closed Out` (`DEAD_CLOSED_OUT`)
 */
export function filterAndSortWorkspaceTableLeadsPure(
  params: WorkspaceTableFilterParams
): WorkspaceTableFilterResult {
  const {
    leads,
    batches,
    tab,
    isOwner,
    userEmail,
    todayDate,
    nowIso,
    dateFilter = null,
    selectedBatchIdFilter = null,
    selectedRepEmailFilter = null,
    interestedSubFilter = 'ALL',
    searchQuery = '',
  } = params;

  const userEmailLower = String(userEmail || '').trim().toLowerCase();
  const repFilterLower =
    selectedRepEmailFilter && selectedRepEmailFilter !== 'ALL'
      ? selectedRepEmailFilter.trim().toLowerCase()
      : null;
  const batchFilterId =
    selectedBatchIdFilter && selectedBatchIdFilter !== 'ALL'
      ? selectedBatchIdFilter.trim()
      : null;
  const q = String(searchQuery || '').trim().toLowerCase();

  // Today's active (non-closed) batches
  const todayActiveBatches = batches
    .filter((b) => b.date === todayDate && b.status !== 'CLOSED')
    .sort((a, b) => a.batchNumber - b.batchNumber);

  const todayBatchIdSet = new Set(todayActiveBatches.map((b) => b.batchId));
  const todayBatchById = new Map(todayActiveBatches.map((b) => [b.batchId, b]));

  // Sales Rep's claimed batch for TODAY (matched canonically by email/name)
  const repClaimedTodayBatch = !isOwner
    ? todayActiveBatches.find(
        (b) =>
          (b.status === 'IN_PROGRESS' || Boolean(b.claimedByEmail)) &&
          areRepEmailsEquivalentPure(b.claimedByEmail, userEmailLower, b.claimedByName)
      ) || null
    : null;

  // TAB 0: 🔥 To-Call Today (Strictly Warm Follow-Ups: PROPOSAL_SHARED & FUTURE_REQUIREMENT due today or overdue)
  // NEVER displays DIDNT_RECEIVE, SWITCH_OFF, or FRESH leads—even if their cooldown has expired.
  if (tab === 'TO_CALL_TODAY') {
    const priorityLeads = leads.filter((lead) => {
      if (
        lead.status !== 'PROPOSAL_SHARED' &&
        lead.status !== 'FUTURE_REQUIREMENT'
      ) {
        return false;
      }

      if (!matchesSearchQueryOnLead(lead, q)) return false;

      const belongsToRep = isOwner
        ? !repFilterLower ||
          areRepEmailsEquivalentPure(
            lead.assignedRepEmail || lead.lastCalledByEmail,
            repFilterLower,
            lead.assignedRepName || lead.lastCalledByName
          )
        : areRepEmailsEquivalentPure(
            lead.assignedRepEmail || lead.lastCalledByEmail,
            userEmailLower,
            lead.assignedRepName || lead.lastCalledByName
          );

      if (!belongsToRep) return false;

      // Due for follow-up today or overdue
      if (!lead.nextFollowUpDate) return true;
      return lead.nextFollowUpDate.slice(0, 10) <= todayDate;
    });

    const sortedPriority = [...priorityLeads].sort((a, b) => {
      const rank = (l: LeadRecord) => {
        if (l.status === 'PROPOSAL_SHARED') return 1;
        if (l.status === 'FUTURE_REQUIREMENT') return 2;
        return 3;
      };
      const rDiff = rank(a) - rank(b);
      if (rDiff !== 0) return rDiff;
      const dateA = a.nextFollowUpDate || a.lastCalledDate || a.updatedAt || '';
      const dateB = b.nextFollowUpDate || b.lastCalledDate || b.updatedAt || '';
      return String(dateA).localeCompare(String(dateB));
    });

    return {
      filteredLeads: sortedPriority,
      todayActiveBatches,
      repClaimedTodayBatch,
      emptyStateMessage:
        'No due Proposal Shared or Future Requirement follow-ups for today. Proceed to Today’s Batch / Fresh.',
    };
  }

  // TAB: Owner Master Lead Table (`ALL_LEADS` — All Leads & Attempt History with latest status updated)
  if (tab === 'ALL_LEADS') {
    const batchLeadIdsSet = new Set<string>();
    if (batchFilterId) {
      const targetBatch = batches.find((b) => b.batchId === batchFilterId);
      for (const lid of targetBatch?.leadIds || []) {
        batchLeadIdsSet.add(lid);
      }
    }

    const masterLeads = leads.filter((lead) => {
      if (!matchesSearchQueryOnLead(lead, q)) return false;

      if (
        dateFilter &&
        dateFilter.preset !== 'ALL_TIME' &&
        !doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)
      ) {
        return false;
      }

      if (batchFilterId) {
        const inSelectedBatch =
          lead.assignedBatchId === batchFilterId || batchLeadIdsSet.has(lead.id);
        if (!inSelectedBatch) return false;
      }

      if (repFilterLower) {
        const parentBatch = lead.assignedBatchId
          ? todayBatchById.get(lead.assignedBatchId)
          : undefined;
        const matchesLeadRep = areRepEmailsEquivalentPure(
          lead.assignedRepEmail || lead.lastCalledByEmail,
          repFilterLower,
          lead.assignedRepName || lead.lastCalledByName
        );
        const matchesBatchRep = parentBatch
          ? areRepEmailsEquivalentPure(
              parentBatch.claimedByEmail,
              repFilterLower,
              parentBatch.claimedByName
            )
          : false;
        if (!matchesLeadRep && !matchesBatchRep) return false;
      }

      return true;
    });

    const sortedMaster = [...masterLeads].sort((a, b) => {
      // Show called/updated leads with attempt history or most recent activity first
      const attemptsDiff = (b.callAttempts || 0) - (a.callAttempts || 0);
      if (attemptsDiff !== 0) return attemptsDiff;
      return String(b.lastCalledDate || b.updatedAt || '').localeCompare(
        String(a.lastCalledDate || a.updatedAt || '')
      );
    });

    return {
      filteredLeads: sortedMaster,
      todayActiveBatches,
      repClaimedTodayBatch,
      emptyStateMessage: 'No leads match the current Master Lead Table filters.',
    };
  }

  // TAB: Calls Dialed Today (`CALLS_DIALED_TODAY` — Top Metric Card Inspector)
  if (tab === 'CALLS_DIALED_TODAY') {
    const todayUtc = new Date(nowIso || Date.now()).toISOString().slice(0, 10);
    const isRangePreset =
      dateFilter &&
      dateFilter.preset !== 'TODAY' &&
      dateFilter.preset !== 'ALL_TIME';

    const dialedTodayLeads = leads.filter((lead) => {
      if (lead.status === 'FRESH' || lead.status === 'REVIVED_FRESH') return false;
      if (!matchesSearchQueryOnLead(lead, q)) return false;

      const matchesDate = isRangePreset
        ? Boolean(lead.lastCalledDate) &&
          doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)
        : Boolean(
            lead.lastCalledDate &&
              (lead.lastCalledDate.startsWith(todayDate) ||
                lead.lastCalledDate.startsWith(todayUtc))
          );
      if (!matchesDate) return false;

      if (!isOwner) {
        return areRepEmailsEquivalentPure(
          lead.lastCalledByEmail || lead.assignedRepEmail,
          userEmailLower,
          lead.lastCalledByName || lead.assignedRepName
        );
      }
      if (repFilterLower) {
        return areRepEmailsEquivalentPure(
          lead.lastCalledByEmail || lead.assignedRepEmail,
          repFilterLower,
          lead.lastCalledByName || lead.assignedRepName
        );
      }
      return true;
    });

    const sortedDialed = [...dialedTodayLeads].sort((a, b) =>
      String(b.lastCalledDate || b.updatedAt || '').localeCompare(
        String(a.lastCalledDate || a.updatedAt || '')
      )
    );

    return {
      filteredLeads: sortedDialed,
      todayActiveBatches,
      repClaimedTodayBatch,
      emptyStateMessage: 'No calls dialed today yet.',
    };
  }

  // TAB: Dead / Closed Out (`DEAD_CLOSED_OUT` — Top Metric Card Inspector)
  if (tab === 'DEAD_CLOSED_OUT') {
    const deadLeads = leads.filter((lead) => {
      if (!DEAD_CLOSED_STATUSES_SET.has(lead.status)) return false;
      if (!matchesSearchQueryOnLead(lead, q)) return false;
      if (!doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)) {
        return false;
      }

      if (!isOwner) {
        return areRepEmailsEquivalentPure(
          lead.assignedRepEmail || lead.lastCalledByEmail,
          userEmailLower,
          lead.assignedRepName || lead.lastCalledByName
        );
      }
      if (repFilterLower) {
        return areRepEmailsEquivalentPure(
          lead.assignedRepEmail || lead.lastCalledByEmail,
          repFilterLower,
          lead.assignedRepName || lead.lastCalledByName
        );
      }
      return true;
    });

    const sortedDead = [...deadLeads].sort((a, b) =>
      String(b.lastCalledDate || b.updatedAt || '').localeCompare(
        String(a.lastCalledDate || a.updatedAt || '')
      )
    );

    return {
      filteredLeads: sortedDead,
      todayActiveBatches,
      repClaimedTodayBatch,
      emptyStateMessage: 'No leads currently in Dead / Closed Out.',
    };
  }

  // TAB 1: Today's Batch / Fresh
  if (tab === 'FRESH') {
    if (!isOwner) {
      // Sales Rep before claiming today's morning batch: 0 leads + clean prompt
      if (!repClaimedTodayBatch) {
        return {
          filteredLeads: [],
          todayActiveBatches,
          repClaimedTodayBatch: null,
          emptyStateMessage:
            "Claim your morning batch above to load today's calling queue.",
        };
      }

      const repBatchLeads = leads.filter((lead) => {
        if (lead.status !== 'FRESH' && lead.status !== 'REVIVED_FRESH') {
          return false;
        }
        const matchesBatch =
          lead.assignedBatchId === repClaimedTodayBatch.batchId ||
          Boolean(repClaimedTodayBatch.leadIds?.includes(lead.id));
        if (!matchesBatch) return false;
        return matchesSearchQueryOnLead(lead, q);
      });

      const sortedRepBatchLeads = sortBatchQueueUntouchedFirstRetriesTail(
        repBatchLeads,
        repClaimedTodayBatch.leadIds
      );

      return {
        filteredLeads: sortedRepBatchLeads,
        todayActiveBatches,
        repClaimedTodayBatch,
        emptyStateMessage:
          "All fresh leads in your today's batch have been called.",
      };
    }

    // Owner View for Today's Batch / Fresh:
    // Show ONLY leads currently assigned to today's active batches (never dump unassigned global pool)
    const ownerBatchLeads = leads.filter((lead) => {
      if (lead.status !== 'FRESH' && lead.status !== 'REVIVED_FRESH') {
        return false;
      }
      if (!lead.assignedBatchId || !todayBatchIdSet.has(lead.assignedBatchId)) {
        return false;
      }
      if (batchFilterId && lead.assignedBatchId !== batchFilterId) {
        return false;
      }
      if (repFilterLower) {
        const parentBatch = todayBatchById.get(lead.assignedBatchId);
        const matchesLeadRep = areRepEmailsEquivalentPure(
          lead.assignedRepEmail,
          repFilterLower,
          lead.assignedRepName
        );
        const matchesBatchRep = parentBatch
          ? areRepEmailsEquivalentPure(
              parentBatch.claimedByEmail,
              repFilterLower,
              parentBatch.claimedByName
            )
          : false;
        if (!matchesLeadRep && !matchesBatchRep) {
          return false;
        }
      }
      return matchesSearchQueryOnLead(lead, q);
    });

    const selectedBatchLeadIds = batchFilterId
      ? todayBatchById.get(batchFilterId)?.leadIds
      : undefined;
    const sortedOwnerBatchLeads = sortBatchQueueUntouchedFirstRetriesTail(
      ownerBatchLeads,
      selectedBatchLeadIds
    );

    return {
      filteredLeads: sortedOwnerBatchLeads,
      todayActiveBatches,
      repClaimedTodayBatch: null,
      emptyStateMessage:
        todayActiveBatches.length === 0
          ? "No active batches for today. Upload fresh leads via Excel / CSV to generate today's batches."
          : 'No uncalled fresh leads remaining in the selected batch.',
    };
  }

  // TAB 2 & TAB 3: Historical Follow-Up Tabs (`PROPOSAL_SHARED` & `FUTURE_REQUIREMENT`)
  if (tab === 'PROPOSAL_SHARED' || tab === 'FUTURE_REQUIREMENT') {
    const matching = leads.filter((lead) => {
      if (lead.status !== tab) return false;
      if (!doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)) {
        return false;
      }

      if (!isOwner) {
        if (
          !areRepEmailsEquivalentPure(
            lead.assignedRepEmail,
            userEmailLower,
            lead.assignedRepName
          )
        ) {
          return false;
        }
      } else if (repFilterLower) {
        if (
          !areRepEmailsEquivalentPure(
            lead.assignedRepEmail,
            repFilterLower,
            lead.assignedRepName
          )
        ) {
          return false;
        }
      }

      return matchesSearchQueryOnLead(lead, q);
    });

    // Sort by nextFollowUpDate ascending so overdue 2-day / 30-day follow-ups appear at the top
    const sorted = [...matching].sort((a, b) => {
      const dateA = a.nextFollowUpDate || a.lastCalledDate || a.updatedAt || '9999-12-31';
      const dateB = b.nextFollowUpDate || b.lastCalledDate || b.updatedAt || '9999-12-31';
      return String(dateA).localeCompare(String(dateB));
    });

    return {
      filteredLeads: sorted,
      todayActiveBatches,
      repClaimedTodayBatch,
      emptyStateMessage:
        tab === 'PROPOSAL_SHARED'
          ? 'No leads currently in Proposals Shared.'
          : 'No leads currently in Future Requirement.',
    };
  }

  // TAB 4: Interested (Owner Queue) (`INTERESTED`)
  const interestedLeads = leads.filter((lead) => {
    if (lead.status !== 'INTERESTED') return false;
    if (!doesLeadMatchWorkspaceDateFilterPure(lead, dateFilter, nowIso)) {
      return false;
    }

    if (!doesLeadMatchInterestedSubFilterPure(lead, interestedSubFilter)) {
      return false;
    }

    if (!isOwner) {
      // Visible as read-only handover status for the originating or escalating Sales Rep
      const isOriginatingRep = areRepEmailsEquivalentPure(
        lead.assignedRepEmail,
        userEmailLower,
        lead.assignedRepName
      );
      const isEscalatingRep = areRepEmailsEquivalentPure(
        lead.escalatedByEmail,
        userEmailLower,
        lead.escalatedByName
      );
      if (!isOriginatingRep && !isEscalatingRep) return false;
    } else if (repFilterLower) {
      const matchesAssigned = areRepEmailsEquivalentPure(
        lead.assignedRepEmail,
        repFilterLower,
        lead.assignedRepName
      );
      const matchesEscalated = areRepEmailsEquivalentPure(
        lead.escalatedByEmail,
        repFilterLower,
        lead.escalatedByName
      );
      if (!matchesAssigned && !matchesEscalated) return false;
    }

    return matchesSearchQueryOnLead(lead, q);
  });

  const sortedInterested = [...interestedLeads].sort((a, b) => {
    if (Boolean(a.isDualRepEscalation) !== Boolean(b.isDualRepEscalation)) {
      return a.isDualRepEscalation ? -1 : 1;
    }
    return String(b.interestedAt || b.updatedAt || '').localeCompare(
      String(a.interestedAt || a.updatedAt || '')
    );
  });

  return {
    filteredLeads: sortedInterested,
    todayActiveBatches,
    repClaimedTodayBatch,
    emptyStateMessage: isOwner
      ? 'No leads currently in Interested (Owner Queue).'
      : 'No handed-over Interested leads in your queue yet.',
  };
}


