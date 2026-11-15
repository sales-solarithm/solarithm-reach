import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
} from 'firebase/firestore';
import {
  adminDb,
  assertAdminDbReadOnlyOperation,
  hasLiveAdminFirebaseConfig,
} from './firebaseDual';
import { UserRole } from './types';

export type NexusAuthorizedRole = 'OWNER' | 'ADMIN' | 'SALES' | 'LEAD_SALES';

export interface NexusEmployeeRecord {
  employeeId: string;
  empId?: string;
  id?: string;
  uid?: string | null;
  authUid?: string | null;
  name: string;
  email: string;
  officialEmail?: string;
  personalEmail?: string | null;
  personalEmailAddress?: string | null;
  authEmail?: string | null;
  phoneNumber?: string | null;
  phone?: string | null;
  role: string;
  assignedRole?: string;
  systemRole?: string;
  department?: string;
  designation?: string;
  status: 'ACTIVE' | 'INACTIVE' | string;
  accessibleApps?: string[];
  allowedApps?: string[];
  apps?: string[];
  joinedDate?: string;
  joiningDate?: string;
  dateOfJoining?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastLoginAt?: unknown;
}

export interface NexusAppRegistryRecord {
  appId?: string;
  id?: string;
  appName?: string;
  description?: string;
  status?: string;
  url?: string;
  allowedEmployees?: string[];
  assignedEmployees?: string[];
  users?: string[];
}

export interface ReachSessionUser {
  employeeId: string;
  uid: string | null;
  name: string;
  email: string;
  role: UserRole;
  department: string;
  designation: string;
  isOwnerTier: boolean;
  isSalesTier: boolean;
  status: 'ACTIVE' | 'active';
}

/**
 * Canonical mirror of the Solarithm Nexus `/employees` & `/users` directory.
 * Reflects the real organization records in Firestore (`SDM-JS-001`, `SDM-DD-002`,
 * `SOL-SGM-001`, `SOL-HS-001`, `SOL-SO-007`, `SOL-SO-008`, `SOL-KP-005`, `SOL-PS-002`, `SOL-SO-006`).
 */
export const CANONICAL_NEXUS_EMPLOYEES: NexusEmployeeRecord[] = [
  {
    employeeId: 'SDM-JS-001',
    empId: 'SDM-JS-001',
    uid: 'oIZpuLeftqaj3j5KS9ZIvurklEE2',
    authUid: 'oIZpuLeftqaj3j5KS9ZIvurklEE2',
    name: 'Jay Jalpa (Owner)',
    email: 'jayshah.03@solarithmdesign.com',
    officialEmail: 'jayshah.03@solarithmdesign.com',
    personalEmail: 'jayjalpa2002@gmail.com',
    personalEmailAddress: 'jayjalpa2002@gmail.com',
    authEmail: 'jayjalpa2002@gmail.com',
    role: 'OWNER',
    assignedRole: 'OWNER',
    systemRole: 'owner',
    department: 'Executive Management',
    designation: 'Owner',
    status: 'ACTIVE',
    accessibleApps: [
      'reach',
      'solarithm-design-studio',
      'solarithm-flow',
      'solarithm-quotecraft',
    ],
  },
  {
    employeeId: 'SDM-DD-002',
    empId: 'SDM-DD-002',
    uid: 'sdm-dd-002-master',
    authUid: 'sdm-dd-002-master',
    name: 'Davara Deep Arvindbhai',
    email: 'deepdavara.23@solarithmdesign.com',
    officialEmail: 'deepdavara.23@solarithmdesign.com',
    personalEmail: 'deepdavara23@gmail.com',
    personalEmailAddress: 'deepdavara23@gmail.com',
    authEmail: 'deepdavara23@gmail.com',
    role: 'OWNER',
    assignedRole: 'OWNER',
    systemRole: 'owner',
    department: 'Executive Management',
    designation: 'Company Partner & Senior Solar Designer',
    status: 'ACTIVE',
    accessibleApps: [
      'reach',
      'solarithm-design-studio',
      'solarithm-flow',
      'solarithm-quotecraft',
    ],
  },
  {
    employeeId: 'SOL-SGM-001',
    empId: 'SOL-SGM-001',
    uid: 'SOL-SGM-001',
    authUid: 'SOL-SGM-001',
    name: 'Solarithm Owner',
    email: 'connect@solarithmdesign.com',
    officialEmail: 'connect@solarithmdesign.com',
    personalEmail: '',
    personalEmailAddress: '',
    role: 'OWNER',
    assignedRole: 'OWNER',
    department: 'Solarithm Design & Engineering Management',
    designation: 'Owner',
    status: 'ACTIVE',
    accessibleApps: [
      'reach',
      'solarithm-commerce',
      'solarithm-design-studio',
      'solarithm-flow',
      'solarithm-quotecraft',
    ],
  },
  {
    employeeId: 'SOL-HS-001',
    empId: 'SOL-HS-001',
    uid: 'SOL-HS-001',
    authUid: 'SOL-HS-001',
    name: 'Savani Hasti Vijaybhai',
    email: 'hastisavani.07@solarithmdesign.com',
    officialEmail: 'hastisavani.07@solarithmdesign.com',
    personalEmail: 'savanihasti2117@gmail.com',
    personalEmailAddress: 'savanihasti2117@gmail.com',
    role: 'SALES',
    assignedRole: 'SALES',
    department: 'Sales',
    designation: 'Lead Sales',
    status: 'ACTIVE',
    accessibleApps: ['reach', 'solarithm-commerce'],
  },
  {
    employeeId: 'SOL-SO-007',
    empId: 'SOL-SO-007',
    uid: 'SOL-SO-007',
    authUid: 'SOL-SO-007',
    name: 'Dhami Krina Rajeshbhai',
    email: 'krinadhami.10@solarithmdesign.com',
    officialEmail: 'krinadhami.10@solarithmdesign.com',
    personalEmail: 'krina11550@gmail.com',
    personalEmailAddress: 'krina11550@gmail.com',
    role: 'SALES',
    assignedRole: 'SALES',
    department: 'Sales',
    designation: 'Sales Executive',
    status: 'ACTIVE',
    accessibleApps: ['reach', 'solarithm-commerce'],
  },
  {
    employeeId: 'SOL-SO-008',
    empId: 'SOL-SO-008',
    uid: 'SOL-SO-008',
    authUid: 'SOL-SO-008',
    name: 'Bodra Krinal Rakeshbhai',
    email: 'krinalbodra.02@solarithmdesign.com',
    officialEmail: 'krinalbodra.02@solarithmdesign.com',
    personalEmail: 'krinalbodra@gmail.com',
    personalEmailAddress: 'krinalbodra@gmail.com',
    role: 'SALES',
    assignedRole: 'SALES',
    department: 'Sales',
    designation: 'Sales Executive',
    status: 'ACTIVE',
    accessibleApps: ['reach', 'solarithm-commerce'],
  },
  {
    employeeId: 'SOL-KP-005',
    empId: 'SOL-KP-005',
    uid: 'SOL-KP-005',
    authUid: 'SOL-KP-005',
    name: 'Parmar Kaushil Chimanbhai',
    email: 'kaushilparmar.07@solarithmdesign.com',
    officialEmail: 'kaushilparmar.07@solarithmdesign.com',
    personalEmail: 'kaushilparmar07@gmail.com',
    personalEmailAddress: 'kaushilparmar07@gmail.com',
    role: 'DESIGNER',
    assignedRole: 'DESIGNER',
    department: 'Design',
    designation: 'Designer',
    status: 'ACTIVE',
    accessibleApps: ['solarithm-design-studio', 'solarithm-flow'],
  },
  {
    employeeId: 'SOL-PS-002',
    empId: 'SOL-PS-002',
    uid: 'SOL-PS-002',
    authUid: 'SOL-PS-002',
    name: 'Solanke Pratham Chandrakantbhai',
    email: 'prathamsolanke.19@solarithmdesign.com',
    officialEmail: 'prathamsolanke.19@solarithmdesign.com',
    personalEmail: 'prathamsolanki33587@gmail.com',
    personalEmailAddress: 'prathamsolanki33587@gmail.com',
    role: 'DESIGNER',
    assignedRole: 'employee',
    department: 'Admin',
    designation: 'Lead Designer',
    status: 'ACTIVE',
    accessibleApps: ['solarithm-design-studio', 'solarithm-flow'],
  },
  {
    employeeId: 'SOL-SO-006',
    empId: 'SOL-SO-006',
    uid: 'SOL-SO-006',
    authUid: 'SOL-SO-006',
    name: 'Sheladiya Om Mukeshbhai',
    email: 'designer@solarithmdesign.com',
    officialEmail: 'designer@solarithmdesign.com',
    personalEmail: 'sheladiyaom2002@gmail.com',
    personalEmailAddress: 'sheladiyaom2002@gmail.com',
    role: 'DESIGNER',
    assignedRole: 'DESIGNER',
    department: 'Design',
    designation: 'Designer',
    status: 'ACTIVE',
    accessibleApps: ['solarithm-design-studio'],
  },
];

/**
 * Normalizes and extracts all app identifiers from an employee/user record into lowercase strings.
 */
export function extractNormalizedAccessibleApps(
  record?: Partial<NexusEmployeeRecord> | null
): string[] {
  if (!record) return [];
  const rawList = [
    ...(Array.isArray(record.accessibleApps) ? record.accessibleApps : []),
    ...(Array.isArray(record.allowedApps) ? record.allowedApps : []),
    ...(Array.isArray(record.apps) ? record.apps : []),
  ];
  const normalized = new Set<string>();
  for (const item of rawList) {
    const clean = String(item || '').trim().toLowerCase();
    if (clean) normalized.add(clean);
  }
  return Array.from(normalized);
}

/**
 * Check 1 — Profile `accessibleApps` Array:
 * Checks whether normalized `accessibleApps` (or `allowedApps` / `apps`) includes
 * `'reach'`, `'solarithm-reach'`, or `'all'`.
 */
export function passesProfileAccessibleAppsCheck(
  record?: Partial<NexusEmployeeRecord> | null
): boolean {
  const apps = extractNormalizedAccessibleApps(record);
  return apps.some(
    (app) => app === 'reach' || app === 'solarithm-reach' || app === 'all'
  );
}

/**
 * Check 2 — Nexus App Registry (`/apps/reach` or `/apps/solarithm-reach`):
 * Checks if the user's `employeeId`, `empId`, `uid`, `authUid`, or `cleanEmail`
 * exists inside the app document's `allowedEmployees`, `assignedEmployees`, or `users` array.
 */
export function passesAppRegistryCheck(
  record?: Partial<NexusEmployeeRecord> | null,
  appRegistry?: NexusAppRegistryRecord | null,
  cleanEmail?: string
): boolean {
  if (!record || !appRegistry) return false;

  const registryEntries = new Set<string>();
  const rawArrays = [
    ...(Array.isArray(appRegistry.allowedEmployees)
      ? appRegistry.allowedEmployees
      : []),
    ...(Array.isArray(appRegistry.assignedEmployees)
      ? appRegistry.assignedEmployees
      : []),
    ...(Array.isArray(appRegistry.users) ? appRegistry.users : []),
  ];

  for (const item of rawArrays) {
    const val = String(item || '').trim().toLowerCase();
    if (val) registryEntries.add(val);
  }

  if (registryEntries.size === 0) return false;

  const candidateIds = [
    record.employeeId,
    record.empId,
    record.id,
    record.uid,
    record.authUid,
    cleanEmail,
    record.email,
    record.officialEmail,
    record.personalEmail,
    record.personalEmailAddress,
  ]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);

  return candidateIds.some((id) => registryEntries.has(id));
}

/**
 * Merges a record found in `/users` with its corresponding canonical HR record in `/employees/{employeeId}`
 * so both Auth metadata (`uid`, `authUid`, `authEmail`) and HR/role metadata (`role`, `department`, `designation`, `status`) are unified.
 */
export function mergeUserAndEmployeeRecordsPure(
  userRecord?: Partial<NexusEmployeeRecord> | null,
  employeeRecord?: Partial<NexusEmployeeRecord> | null
): NexusEmployeeRecord {
  const base = { ...(userRecord || {}), ...(employeeRecord || {}) };
  const mergedApps = Array.from(
    new Set([
      ...(Array.isArray(userRecord?.accessibleApps)
        ? userRecord!.accessibleApps!
        : []),
      ...(Array.isArray(userRecord?.allowedApps)
        ? userRecord!.allowedApps!
        : []),
      ...(Array.isArray(userRecord?.apps) ? userRecord!.apps! : []),
      ...(Array.isArray(employeeRecord?.accessibleApps)
        ? employeeRecord!.accessibleApps!
        : []),
      ...(Array.isArray(employeeRecord?.allowedApps)
        ? employeeRecord!.allowedApps!
        : []),
      ...(Array.isArray(employeeRecord?.apps) ? employeeRecord!.apps! : []),
    ])
  );

  const canonicalEmployeeId = String(
    employeeRecord?.employeeId ||
      employeeRecord?.empId ||
      userRecord?.employeeId ||
      userRecord?.empId ||
      employeeRecord?.id ||
      userRecord?.id ||
      ''
  )
    .trim()
    .toUpperCase();

  const canonicalUid =
    userRecord?.uid ||
    userRecord?.authUid ||
    employeeRecord?.uid ||
    employeeRecord?.authUid ||
    canonicalEmployeeId ||
    null;

  // Prefer official company email (`@solarithmdesign.com`) when available
  const candidates = [
    employeeRecord?.officialEmail,
    employeeRecord?.email,
    userRecord?.officialEmail,
    userRecord?.email,
  ]
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);

  const canonicalEmail =
    candidates.find((e) => e.endsWith('@solarithmdesign.com')) ||
    candidates[0] ||
    '';

  const personalEmail =
    employeeRecord?.personalEmail ||
    employeeRecord?.personalEmailAddress ||
    userRecord?.personalEmail ||
    userRecord?.personalEmailAddress ||
    null;

  // Prefer HR role from /employees when present
  const rawRole = String(
    employeeRecord?.role ||
      employeeRecord?.assignedRole ||
      userRecord?.role ||
      userRecord?.assignedRole ||
      userRecord?.systemRole ||
      ''
  )
    .trim()
    .toUpperCase();

  const rawStatus = String(
    employeeRecord?.status || userRecord?.status || 'ACTIVE'
  )
    .trim()
    .toUpperCase();

  return {
    ...base,
    employeeId: canonicalEmployeeId,
    empId: canonicalEmployeeId,
    uid: canonicalUid,
    authUid: canonicalUid,
    name:
      employeeRecord?.name ||
      userRecord?.name ||
      'Solarithm Member',
    email: canonicalEmail,
    officialEmail:
      employeeRecord?.officialEmail ||
      userRecord?.officialEmail ||
      canonicalEmail,
    personalEmail,
    personalEmailAddress: personalEmail,
    role: rawRole,
    assignedRole:
      employeeRecord?.assignedRole || userRecord?.assignedRole || rawRole,
    department:
      employeeRecord?.department || userRecord?.department || 'General',
    designation:
      employeeRecord?.designation || userRecord?.designation || rawRole,
    status: rawStatus,
    accessibleApps: mergedApps,
  };
}

export interface NexusAccessEvaluationResult {
  sessionUser: ReachSessionUser;
  needsReachAppSync: boolean;
  passedVia: 'OWNER_GLOBAL' | 'SALES_ROLE' | 'ACCESSIBLE_APPS' | 'APP_REGISTRY';
}

/**
 * Authoritative pure evaluation implementing Sections 2 & 3 of the Solarithm Nexus Auth Architecture:
 *
 * Section 2 — Status & Role Normalization:
 *   1. `status = (employeeData.status || 'ACTIVE').toUpperCase()`
 *      If `status !== 'ACTIVE'`, throws `"Access Denied: Your employee profile is currently marked INACTIVE."`
 *   2. `rawRole = (employeeData.role || employeeData.assignedRole || '').toUpperCase().trim()`
 *      - `isOwnerTier = rawRole === 'OWNER' || rawRole === 'ADMIN'`
 *      - `isSalesTier = rawRole === 'SALES' || rawRole === 'LEAD_SALES' || (employeeData.department || '').toLowerCase().includes('sales')`
 *
 * Section 3 — Authoritative App Registry & Permission Verification:
 *   - Check 1: Profile `accessibleApps` (or `allowedApps` / `apps`) includes `'reach'`, `'solarithm-reach'`, or `'all'`.
 *   - Check 2: Nexus App Registry (`/apps/reach` or `/apps/solarithm-reach`) includes user's ID/email in `allowedEmployees`, `assignedEmployees`, or `users`.
 *   - Check 3: Role-Based Provisioning Matrix:
 *     * If `isOwnerTier === true`: Grant access immediately; flag `needsReachAppSync = true` if `'reach'` is not yet in `accessibleApps`.
 *     * If `isSalesTier === true`: Grant access if Check 1, Check 2, OR primary role is `'SALES'` / `'LEAD_SALES'` / `isSalesTier`; flag `needsReachAppSync = true` if `'reach'` is not yet in `accessibleApps`.
 *     * If any other role (`DESIGNER`, `ACCOUNTANT`, `ENGINEER`, `TECHNICIAN`, etc.):
 *       Grant access ONLY if Check 1 or Check 2 passes, mapping them to the Sales calling interface (`isSalesTier = true`).
 *       Otherwise throw `"Access Restricted: Solarithm Reach is not enabled for your profile in Nexus."`
 */
export function evaluateNexusAccessWithRegistryPure(
  empData: Partial<NexusEmployeeRecord> | null | undefined,
  options?: {
    fallbackId?: string;
    appRegistry?: NexusAppRegistryRecord | null;
    cleanEmail?: string;
  }
): NexusAccessEvaluationResult {
  if (!empData) {
    throw new Error(
      'Access Denied: Email is not registered in Solarithm Nexus.'
    );
  }

  // Section 2.1: Account Status Check
  const status = String(empData.status || 'ACTIVE')
    .trim()
    .toUpperCase();
  if (status !== 'ACTIVE') {
    throw new Error(
      'Access Denied: Your employee profile is currently marked INACTIVE.'
    );
  }

  // Section 2.2: Role Normalization
  const rawRole = String(
    empData.role || empData.assignedRole || empData.systemRole || ''
  )
    .toUpperCase()
    .trim();

  const isOwnerTier = rawRole === 'OWNER' || rawRole === 'ADMIN';
  const isSalesTierRoleOrDept =
    rawRole === 'SALES' ||
    rawRole === 'LEAD_SALES' ||
    String(empData.department || '')
      .toLowerCase()
      .includes('sales');

  // Section 3.1 & 3.2: Check 1 & Check 2
  const normalizedApps = extractNormalizedAccessibleApps(empData);
  const hasExplicitReachInProfile = normalizedApps.includes('reach');
  const passesCheck1 = passesProfileAccessibleAppsCheck(empData);
  const passesCheck2 = passesAppRegistryCheck(
    empData,
    options?.appRegistry,
    options?.cleanEmail
  );

  let finalIsOwnerTier = false;
  let finalIsSalesTier = false;
  let finalRole: UserRole = 'SALES';
  let passedVia: NexusAccessEvaluationResult['passedVia'] = 'ACCESSIBLE_APPS';

  // Section 3.3: Role-Based Provisioning Matrix
  if (isOwnerTier) {
    finalIsOwnerTier = true;
    finalIsSalesTier = false;
    finalRole = rawRole === 'ADMIN' ? 'ADMIN' : 'OWNER';
    passedVia = 'OWNER_GLOBAL';
  } else if (isSalesTierRoleOrDept) {
    finalIsOwnerTier = false;
    finalIsSalesTier = true;
    finalRole = rawRole === 'LEAD_SALES' ? 'LEAD_SALES' : 'SALES';
    passedVia = passesCheck1
      ? 'ACCESSIBLE_APPS'
      : passesCheck2
        ? 'APP_REGISTRY'
        : 'SALES_ROLE';
  } else {
    // Any other role (DESIGNER, ACCOUNTANT, ENGINEER, TECHNICIAN, etc.)
    if (passesCheck1 || passesCheck2) {
      finalIsOwnerTier = false;
      finalIsSalesTier = true;
      finalRole = 'SALES';
      passedVia = passesCheck1 ? 'ACCESSIBLE_APPS' : 'APP_REGISTRY';
    } else {
      throw new Error(
        'Access Restricted: Solarithm Reach is not enabled for your profile in Nexus.'
      );
    }
  }

  const canonicalId = String(
    empData.employeeId || empData.empId || empData.id || options?.fallbackId || ''
  )
    .trim()
    .toUpperCase();

  const candidates = [
    empData.officialEmail,
    empData.email,
    options?.cleanEmail,
    empData.personalEmail,
    empData.personalEmailAddress,
  ]
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);

  const canonicalEmail =
    candidates.find((e) => e.endsWith('@solarithmdesign.com')) ||
    candidates[0] ||
    '';

  const sessionUser: ReachSessionUser = {
    employeeId: canonicalId,
    uid: empData.uid || empData.authUid || canonicalId || null,
    name: empData.name || 'Solarithm Member',
    email: canonicalEmail,
    role: finalRole,
    department: empData.department || 'General',
    designation: empData.designation || rawRole || finalRole,
    isOwnerTier: finalIsOwnerTier,
    isSalesTier: finalIsSalesTier,
    status: 'ACTIVE',
  };

  return {
    sessionUser,
    needsReachAppSync: !hasExplicitReachInProfile,
    passedVia,
  };
}

/**
 * Pure validation & role-tier evaluation function returning `ReachSessionUser`.
 */
export function evaluateEmployeeAccessPure(
  empData: Partial<NexusEmployeeRecord> | null | undefined,
  fallbackId = '',
  appRegistry: NexusAppRegistryRecord | null = null
): ReachSessionUser {
  return evaluateNexusAccessWithRegistryPure(empData, {
    fallbackId,
    appRegistry,
  }).sessionUser;
}

const MIRRORED_EMAIL_FIELDS = [
  'email',
  'officialEmail',
  'personalEmail',
  'personalEmailAddress',
] as const;

/**
 * Queries a Firestore collection (`employees` or `users`) checking the 4 mirrored email fields in order:
 * 1. `email == cleanEmail`
 * 2. `officialEmail == cleanEmail`
 * 3. `personalEmail == cleanEmail`
 * 4. `personalEmailAddress == cleanEmail`
 */
async function queryCollectionByFourEmailFields(
  collectionName: 'employees' | 'users',
  cleanEmail: string
): Promise<{ id: string; data: NexusEmployeeRecord } | null> {
  const colRef = collection(adminDb, collectionName);

  for (const fieldName of MIRRORED_EMAIL_FIELDS) {
    const q = query(colRef, where(fieldName, '==', cleanEmail));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const matchedDoc = snap.docs[0];
      return {
        id: matchedDoc.id,
        data: matchedDoc.data() as NexusEmployeeRecord,
      };
    }
  }

  // Case-insensitive safety fallback scan in case a stored email in Firestore has uppercase characters
  const fullSnap = await getDocs(colRef);
  for (const docSnap of fullSnap.docs) {
    const data = docSnap.data() as NexusEmployeeRecord;
    const matched = MIRRORED_EMAIL_FIELDS.some(
      (f) => String(data[f] || '').trim().toLowerCase() === cleanEmail
    );
    if (matched) {
      return {
        id: docSnap.id,
        data,
      };
    }
  }

  return null;
}

/**
 * Fetches the Solarithm Reach App Registry document from `/apps/reach` on `adminDb` (STRICTLY READ-ONLY)
 * (with fallback check on `/apps/solarithm-reach` or `/apps` where `appId == 'reach'` or `id == 'reach'`).
 */
export async function fetchReachAppRegistry(): Promise<NexusAppRegistryRecord | null> {
  try {
    const directReachSnap = await getDoc(doc(adminDb, 'apps', 'reach'));
    if (directReachSnap.exists()) {
      return directReachSnap.data() as NexusAppRegistryRecord;
    }

    const altSnap = await getDoc(doc(adminDb, 'apps', 'solarithm-reach'));
    if (altSnap.exists()) {
      return altSnap.data() as NexusAppRegistryRecord;
    }

    const appsRef = collection(adminDb, 'apps');
    const byAppIdSnap = await getDocs(
      query(appsRef, where('appId', 'in', ['reach', 'solarithm-reach']))
    );
    if (!byAppIdSnap.empty) {
      return byAppIdSnap.docs[0].data() as NexusAppRegistryRecord;
    }

    const byIdSnap = await getDocs(
      query(appsRef, where('id', 'in', ['reach', 'solarithm-reach']))
    );
    if (!byIdSnap.empty) {
      return byIdSnap.docs[0].data() as NexusAppRegistryRecord;
    }
  } catch {
    // Non-blocking if /apps is not readable
  }
  return null;
}

/**
 * Dual-Firebase Read-Only Guard:
 * `adminDb` (`solarithm-master`) is strictly READ-ONLY for Solarithm Reach operations.
 * No employee or role data is ever written or modified via Reach.
 */
export async function syncReachProvisioningToFirestore(
  _sessionUser: ReachSessionUser,
  _userDocIds: string[] = []
): Promise<void> {
  // Strictly READ-ONLY: Do not write to `/employees`, `/users`, or `/apps` in `adminDb`.
  return;
}

/**
 * Authoritative Multi-Collection Identity & App Registry Authentication Service (`adminDb` — READ-ONLY):
 * 1. Normalizes `cleanEmail = rawEmail.trim().toLowerCase()`.
 * 2. Queries `/employees` on `adminDb` checking the 4 mirrored email fields in order (`email`, `officialEmail`, `personalEmail`, `personalEmailAddress`).
 * 3. If no document is returned from `/employees`, executes the exact same 4-field lookup against `/users` on `adminDb`.
 * 4. If found in `/users` first, fetches `/employees/{employeeId}` on `adminDb` (if `employeeId` or `empId` is present) and merges attributes.
 * 5. If no record exists in either collection, throws `"Access Denied: Email is not registered in Solarithm Nexus."`
 * 6. Evaluates account status (`ACTIVE`), role normalization (`OWNER`/`ADMIN` vs `SALES`/`LEAD_SALES`), and App Registry (`/apps/reach` + `accessibleApps`).
 * 7. Never writes or modifies employee or role data in `adminDb`.
 */
export async function authenticateEmployeeByEmail(
  rawEmail: string
): Promise<ReachSessionUser> {
  const cleanEmail = (rawEmail || '').trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid work email address.');
  }

  let unifiedRecord: NexusEmployeeRecord | null = null;
  let fallbackDocId = '';
  let appRegistryDoc: NexusAppRegistryRecord | null = null;

  const hasLiveFirebaseKey = hasLiveAdminFirebaseConfig();
  let firestoreQuerySucceeded = false;

  if (hasLiveFirebaseKey) {
    try {
      const lookupTask = (async () => {
        // Step 1: Query `/employees` on `adminDb` across the 4 mirrored email fields in order
        const empMatch = await queryCollectionByFourEmailFields(
          'employees',
          cleanEmail
        );

        if (empMatch) {
          fallbackDocId = empMatch.id;
          const empId = String(
            empMatch.data.employeeId || empMatch.data.empId || empMatch.id
          )
            .trim()
            .toUpperCase();

          // Check if a corresponding `/users` doc exists on `adminDb` to unify `uid` and `accessibleApps`
          let linkedUserRecord: NexusEmployeeRecord | null = null;
          const candidateUserId = String(
            empMatch.data.uid || empMatch.data.authUid || empId
          ).trim();

          if (candidateUserId) {
            const userSnap = await getDoc(
              doc(adminDb, 'users', candidateUserId)
            );
            if (userSnap.exists()) {
              linkedUserRecord = userSnap.data() as NexusEmployeeRecord;
            }
          }

          unifiedRecord = mergeUserAndEmployeeRecordsPure(
            linkedUserRecord,
            empMatch.data
          );
        } else {
          // Step 2: Execute the exact same 4-field lookup against `/users` on `adminDb`
          const userMatch = await queryCollectionByFourEmailFields(
            'users',
            cleanEmail
          );

          if (userMatch) {
            fallbackDocId = userMatch.id;

            // Step 3: Fetch corresponding canonical record in `/employees/{employeeId}` on `adminDb` and merge
            const linkedEmpId = String(
              userMatch.data.employeeId || userMatch.data.empId || ''
            )
              .trim()
              .toUpperCase();

            let canonicalEmpRecord: NexusEmployeeRecord | null = null;
            if (linkedEmpId) {
              const empSnap = await getDoc(
                doc(adminDb, 'employees', linkedEmpId)
              );
              if (empSnap.exists()) {
                canonicalEmpRecord = empSnap.data() as NexusEmployeeRecord;
              }
            }

            unifiedRecord = mergeUserAndEmployeeRecordsPure(
              userMatch.data,
              canonicalEmpRecord
            );
          }
        }

        // Fetch `/apps/reach` registry document from `adminDb` for Check 2
        appRegistryDoc = await fetchReachAppRegistry();
        return true;
      })();

      const timeoutTask = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 3500)
      );

      firestoreQuerySucceeded = await Promise.race([lookupTask, timeoutTask]);
    } catch {
      firestoreQuerySucceeded = false;
    }
  }

  // Only if Firestore is completely unreachable (offline/timeout) fall back to canonical mirror
  if (!firestoreQuerySucceeded && !unifiedRecord) {
    const mirrorMatch = CANONICAL_NEXUS_EMPLOYEES.find((emp) =>
      MIRRORED_EMAIL_FIELDS.some(
        (field) => String(emp[field] || '').trim().toLowerCase() === cleanEmail
      )
    );
    if (mirrorMatch) {
      unifiedRecord = mirrorMatch;
      fallbackDocId = mirrorMatch.employeeId;
    }
  }

  // Step 4: If no record exists in either `/employees` or `/users`, throw exact error
  if (!unifiedRecord) {
    throw new Error(
      'Access Denied: Email is not registered in Solarithm Nexus.'
    );
  }

  // Sections 2 & 3: Evaluate status, role normalization, and App Registry permission matrix (READ-ONLY)
  const evaluation = evaluateNexusAccessWithRegistryPure(unifiedRecord, {
    fallbackId: fallbackDocId,
    appRegistry: appRegistryDoc,
    cleanEmail,
  });

  return evaluation.sessionUser;
}

/**
 * Dual-Firebase Read-Only Guard:
 * Writing employee or role data via Solarithm Reach is strictly forbidden.
 * Employee management belongs exclusively to the Solarithm Nexus Admin Console.
 */
export async function saveEmployeeDualCollection(
  _employeePayload: Partial<NexusEmployeeRecord>
): Promise<string> {
  return assertAdminDbReadOnlyOperation('saveEmployeeDualCollection');
}

/**
 * Dual-Firebase Read-Only Guard:
 * Modifying employee app permissions in `adminDb` via Solarithm Reach is strictly forbidden.
 */
export async function grantReachAccess(_rawEmployeeId: string): Promise<void> {
  return assertAdminDbReadOnlyOperation('grantReachAccess');
}
