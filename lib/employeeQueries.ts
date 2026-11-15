import { collection, query, where, getDocs } from 'firebase/firestore';
import { adminDb, hasLiveAdminFirebaseConfig } from './firebaseDual';
import {
  CANONICAL_NEXUS_EMPLOYEES,
  fetchReachAppRegistry,
  mergeUserAndEmployeeRecordsPure,
  NexusAppRegistryRecord,
  NexusEmployeeRecord,
  passesAppRegistryCheck,
  passesProfileAccessibleAppsCheck,
} from './authService';

export interface ActiveReachSalesRep {
  employeeId: string;
  uid: string | null;
  name: string;
  email: string;
  designation: string;
  role: string;
}

export interface GetActiveSalesRepsOptions {
  includeOwners?: boolean;
  appRegistry?: NexusAppRegistryRecord | null;
}

/**
 * Pure deduplication & filtering helper for `getActiveSalesReps()`:
 * 1. Deduplicates records from `/employees` and `/users` using canonical uppercase `employeeId` (or `email` fallback).
 * 2. Requires `status.toUpperCase() === 'ACTIVE'`.
 * 3. Includes every active employee who meets ANY of the following criteria:
 *    - `role` or `assignedRole` is `'SALES'` or `'LEAD_SALES'`
 *    - `department` is `'Sales & Business Development'` or includes `'sales'`
 *    - `accessibleApps` explicitly contains `'reach'` (for cross-department staff granted outreach duties)
 *    - Listed in `/apps/reach` `allowedEmployees` / `assignedEmployees` / `users`
 * 4. Excludes pure `'OWNER'` (and `'ADMIN'`) profiles from the standard sales rep dropdown unless `includeOwners === true`.
 * 5. Sorts alphabetically by `name` and returns `{ employeeId, uid, name, email, designation, role }`.
 */
export function filterAndSortReachSalesRepsPure(
  records: Partial<NexusEmployeeRecord>[],
  options?: GetActiveSalesRepsOptions
): ActiveReachSalesRep[] {
  const includeOwners = Boolean(options?.includeOwners);
  const appRegistry = options?.appRegistry || null;

  // Step 1: Merge & deduplicate by canonical uppercase employeeId (or lowercase email fallback)
  const mergedByKey = new Map<string, NexusEmployeeRecord>();

  for (const raw of records) {
    if (!raw) continue;
    const rawEmpId = String(raw.employeeId || raw.empId || raw.id || '')
      .trim()
      .toUpperCase();
    const rawEmail = String(
      raw.officialEmail || raw.email || raw.personalEmail || ''
    )
      .trim()
      .toLowerCase();

    const dedupeKey =
      rawEmpId && !rawEmpId.includes(' ')
        ? `ID:${rawEmpId}`
        : rawEmail
          ? `EMAIL:${rawEmail}`
          : '';
    if (!dedupeKey) continue;

    const existing = mergedByKey.get(dedupeKey);
    const merged = existing
      ? mergeUserAndEmployeeRecordsPure(existing, raw)
      : mergeUserAndEmployeeRecordsPure(null, raw);
    mergedByKey.set(dedupeKey, merged);
  }

  // Secondary pass to collapse any records that matched by email first and ID second
  const dedupedByEmployeeId = new Map<string, NexusEmployeeRecord>();
  for (const rec of mergedByKey.values()) {
    const key =
      rec.employeeId ||
      String(rec.officialEmail || rec.email || '')
        .trim()
        .toLowerCase();
    if (!key) continue;
    const prev = dedupedByEmployeeId.get(key);
    dedupedByEmployeeId.set(
      key,
      prev ? mergeUserAndEmployeeRecordsPure(prev, rec) : rec
    );
  }

  const results: ActiveReachSalesRep[] = [];

  for (const data of dedupedByEmployeeId.values()) {
    const status = String(data.status || 'ACTIVE')
      .trim()
      .toUpperCase();
    if (status !== 'ACTIVE') continue;

    const rawRole = String(
      data.role || data.assignedRole || data.systemRole || ''
    )
      .trim()
      .toUpperCase();

    const isPureOwnerOrAdmin = rawRole === 'OWNER' || rawRole === 'ADMIN';
    if (isPureOwnerOrAdmin && !includeOwners) {
      continue;
    }

    const departmentLower = String(data.department || '')
      .trim()
      .toLowerCase();

    const isSalesRole = rawRole === 'SALES' || rawRole === 'LEAD_SALES';
    const isSalesDepartment =
      departmentLower === 'sales & business development' ||
      departmentLower === 'sales' ||
      departmentLower.includes('sales');
    const hasExplicitReachApp = passesProfileAccessibleAppsCheck(data);
    const isInReachAppRegistry = passesAppRegistryCheck(
      data,
      appRegistry,
      data.email
    );

    const qualifiesForReachDropdown =
      isSalesRole ||
      isSalesDepartment ||
      hasExplicitReachApp ||
      isInReachAppRegistry ||
      (includeOwners && isPureOwnerOrAdmin);

    if (!qualifiesForReachDropdown) continue;

    const email = String(
      data.officialEmail ||
        data.email ||
        data.personalEmail ||
        data.personalEmailAddress ||
        ''
    )
      .trim()
      .toLowerCase();
    if (!email) continue;

    const employeeId = String(data.employeeId || data.empId || '')
      .trim()
      .toUpperCase();

    results.push({
      employeeId: employeeId || email.toUpperCase(),
      uid: data.uid || data.authUid || employeeId || null,
      name: (data.name || 'Sales Rep').trim(),
      email,
      designation: data.designation || 'Sales Executive',
      role: rawRole || 'SALES',
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Queries both `/employees` and `/users` where `status` is `'ACTIVE'` (or `'active'`),
 * fetches `/apps/reach` registry, deduplicates by canonical `employeeId`, and returns
 * all active Reach sales personnel sorted alphabetically by `name`.
 */
export async function getActiveSalesReps(
  options?: GetActiveSalesRepsOptions
): Promise<ActiveReachSalesRep[]> {
  const hasLiveFirebaseKey = hasLiveAdminFirebaseConfig();

  if (hasLiveFirebaseKey) {
    try {
      const fetchTask = (async () => {
        const [empSnap, userSnap, appRegistry] = await Promise.all([
          getDocs(
            query(
              collection(adminDb, 'employees'),
              where('status', 'in', ['ACTIVE', 'active'])
            )
          ),
          getDocs(
            query(
              collection(adminDb, 'users'),
              where('status', 'in', ['ACTIVE', 'active'])
            )
          ),
          options?.appRegistry !== undefined
            ? Promise.resolve(options.appRegistry)
            : fetchReachAppRegistry(),
        ]);

        // Important: pass `/users` records first and `/employees` records second so canonical `/employees` HR fields take precedence on merge
        const combinedRecords: Partial<NexusEmployeeRecord>[] = [];

        userSnap.forEach((docSnap) => {
          const data = docSnap.data() as NexusEmployeeRecord;
          combinedRecords.push({
            ...data,
            id: docSnap.id,
            employeeId: String(data.employeeId || data.empId || docSnap.id)
              .trim()
              .toUpperCase(),
          });
        });

        empSnap.forEach((docSnap) => {
          const data = docSnap.data() as NexusEmployeeRecord;
          combinedRecords.push({
            ...data,
            id: docSnap.id,
            employeeId: String(data.employeeId || data.empId || docSnap.id)
              .trim()
              .toUpperCase(),
          });
        });

        return filterAndSortReachSalesRepsPure(combinedRecords, {
          ...options,
          appRegistry,
        });
      })();

      const timeoutTask = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 2500)
      );

      const liveResult = await Promise.race([fetchTask, timeoutTask]);
      if (liveResult && liveResult.length > 0) {
        return liveResult;
      }
    } catch {
      // Fallback to canonical Nexus directory if Firestore is offline
    }
  }

  return filterAndSortReachSalesRepsPure(CANONICAL_NEXUS_EMPLOYEES, options);
}

/**
 * Alias for `getActiveSalesReps` for backward compatibility across components.
 */
export const fetchActiveReachSalesReps = getActiveSalesReps;
