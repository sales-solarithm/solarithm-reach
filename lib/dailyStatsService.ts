import {
  QueryConstraint,
  QueryDocumentSnapshot,
  collection,
  doc,
  getCountFromServer,
  getDocs,
  increment,
  limit,
  query,
  setDoc,
  startAfter,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  hasLiveReachFirebaseConfig,
  reachDb,
  reportCloudSyncError,
  withFirestoreNetworkRetry,
} from './firebaseDual';
import { CANONICAL_NEXUS_EMPLOYEES } from './authService';
import { OwnerMetricStripData } from './dashboardMetrics';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import { LeadRecord } from './types';

export interface DailyRepStatRecord {
  id: string; // `${date}_${repEmail}`
  date: string; // YYYY-MM-DD
  repEmail: string;
  repName: string;
  callsCount: number;
  proposalsCount: number;
  interestedCount: number;
  newLeadsAdded: number;
  wonCount: number;
  updatedAt: string;
}

const DAILY_STATS_STORAGE_KEY = 'solarithm_reach_daily_stats_v1';

/**
 * Resolves any mirrored employee email (`email`, `officialEmail`, `personalEmail`, `personalEmailAddress`)
 * or employee name to their canonical lowercase email & clean display name.
 */
export function resolveCanonicalRepIdentity(
  rawEmail?: string | null,
  rawName?: string | null
): { email: string; name: string } | null {
  const emailClean = String(rawEmail || '').trim().toLowerCase();
  const nameClean = String(rawName || '')
    .split(' (')[0]
    .trim()
    .toLowerCase();

  for (const emp of CANONICAL_NEXUS_EMPLOYEES) {
    const empEmails = [
      emp.officialEmail,
      emp.email,
      emp.personalEmail,
      emp.personalEmailAddress,
    ]
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean);

    const empNameClean = emp.name.split(' (')[0].trim();
    const empNameLower = empNameClean.toLowerCase();
    const empTokens = empNameLower.split(/\s+/).filter(Boolean);

    if (emailClean && empEmails.includes(emailClean)) {
      return {
        email: (emp.officialEmail || emp.email).trim().toLowerCase(),
        name: empNameClean,
      };
    }

    if (
      nameClean &&
      nameClean !== 'historical import' &&
      (empNameLower === nameClean || empTokens.includes(nameClean))
    ) {
      return {
        email: (emp.officialEmail || emp.email).trim().toLowerCase(),
        name: empNameClean,
      };
    }
  }

  if (emailClean && emailClean !== 'historical@solarithmdesign.com') {
    return {
      email: emailClean,
      name: rawName ? String(rawName).split(' (')[0].trim() : emailClean,
    };
  }

  return null;
}

/**
 * Checks whether two rep emails (or names) belong to the same canonical Solarithm Nexus employee
 * (handling both official `@solarithmdesign.com` and personal `@gmail.com` emails seamlessly).
 */
export function areRepEmailsEquivalentPure(
  emailA?: string | null,
  emailB?: string | null,
  nameA?: string | null,
  nameB?: string | null
): boolean {
  const cleanA = String(emailA || '').trim().toLowerCase();
  const cleanB = String(emailB || '').trim().toLowerCase();
  if (cleanA && cleanB && cleanA === cleanB) {
    return true;
  }
  const cleanNameA = String(nameA || '')
    .split(' (')[0]
    .trim()
    .toLowerCase();
  const cleanNameB = String(nameB || '')
    .split(' (')[0]
    .trim()
    .toLowerCase();
  if (
    cleanNameA &&
    cleanNameB &&
    cleanNameA !== 'historical import' &&
    cleanNameA === cleanNameB
  ) {
    return true;
  }
  const canonA = resolveCanonicalRepIdentity(cleanA, nameA);
  const canonB = resolveCanonicalRepIdentity(cleanB, nameB);
  if (canonA && canonB && canonA.email === canonB.email) {
    return true;
  }
  return false;
}

/**
 * Pure aggregator that builds lightweight `daily_stats/{YYYY-MM-DD}_{repEmail}` summary records
 * from an array of `LeadRecord` items so Analytics charts can render 50,000+ leads in <50ms.
 */
export function computeDailyStatsFromLeadsPure(
  leads: LeadRecord[],
  nowIso: string = new Date().toISOString()
): DailyRepStatRecord[] {
  const map = new Map<string, DailyRepStatRecord>();

  const ensureBucket = (dateYmd: string, repEmail: string, repName: string) => {
    const key = `${dateYmd}_${repEmail}`;
    let existing = map.get(key);
    if (!existing) {
      existing = {
        id: key,
        date: dateYmd,
        repEmail,
        repName,
        callsCount: 0,
        proposalsCount: 0,
        interestedCount: 0,
        newLeadsAdded: 0,
        wonCount: 0,
        updatedAt: nowIso,
      };
      map.set(key, existing);
    }
    return existing;
  };

  for (const lead of leads) {
    const repIdentity = resolveCanonicalRepIdentity(
      lead.lastCalledByEmail || lead.assignedRepEmail || lead.createdByEmail,
      lead.lastCalledByName || lead.assignedRepName || lead.createdByName
    );
    if (!repIdentity) continue;

    const callDateYmd = (lead.lastCalledDate || '').slice(0, 10);
    const isCalled = (lead.callAttempts || 0) > 0 || Boolean(lead.lastCalledDate);

    if (isCalled && /^\d{4}-\d{2}-\d{2}$/.test(callDateYmd)) {
      const b = ensureBucket(callDateYmd, repIdentity.email, repIdentity.name);
      b.callsCount += 1;

      if (lead.status === 'PROPOSAL_SHARED') {
        b.proposalsCount += 1;
      }
      if (
        lead.status === 'INTERESTED' ||
        lead.status === 'CLOSED_WON' ||
        Boolean(lead.interestedAt)
      ) {
        b.interestedCount += 1;
      }
      if (lead.status === 'CLOSED_WON') {
        b.wonCount += 1;
      }

      if (lead.isDualRepEscalation && lead.escalatedByEmail) {
        const escalatorIdentity = resolveCanonicalRepIdentity(
          lead.escalatedByEmail,
          lead.escalatedByName
        );
        const escYmd = (lead.interestedAt || lead.lastCalledDate || '').slice(0, 10);
        if (
          escalatorIdentity &&
          escalatorIdentity.email !== repIdentity.email &&
          /^\d{4}-\d{2}-\d{2}$/.test(escYmd)
        ) {
          const escBucket = ensureBucket(
            escYmd,
            escalatorIdentity.email,
            escalatorIdentity.name
          );
          escBucket.callsCount += 1;
          escBucket.interestedCount += 1;
        }
      }
    }

    const isManualCreation =
      lead.source === 'manual' || (!lead.importBatchId && Boolean(lead.createdByEmail));
    if (isManualCreation && lead.createdByEmail && lead.createdAt) {
      const creatorIdentity = resolveCanonicalRepIdentity(
        lead.createdByEmail,
        lead.createdByName
      );
      const createdYmd = lead.createdAt.slice(0, 10);
      if (creatorIdentity && /^\d{4}-\d{2}-\d{2}$/.test(createdYmd)) {
        const b = ensureBucket(
          createdYmd,
          creatorIdentity.email,
          creatorIdentity.name
        );
        b.newLeadsAdded += 1;
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Module 5.2: Atomically increments `callsCount` and `newLeadsAdded` (`newLeads: increment(1)`)
 * in `daily_stats/{date}_{repEmail}` when a sales rep engages a lead whose prior status was `FRESH`.
 */
export async function recordFirstFreshTransitionStatsInFirestore(params: {
  dateYmd: string;
  repEmail: string;
  repName: string;
  newStatus: string;
}): Promise<void> {
  if (!hasLiveReachFirebaseConfig()) return;
  const resolved = resolveCanonicalRepIdentity(params.repEmail, params.repName);
  const emailLower = (resolved?.email || params.repEmail || '').trim().toLowerCase();
  if (!emailLower || !/^\d{4}-\d{2}-\d{2}$/.test(params.dateYmd)) return;
  const cleanName = resolved?.name || String(params.repName || emailLower).split(' (')[0].trim();
  const statId = `${params.dateYmd}_${emailLower}`;

  try {
    await setDoc(
      doc(reachDb, 'daily_stats', statId),
      {
        id: statId,
        date: params.dateYmd,
        repEmail: emailLower,
        repName: cleanName,
        callsCount: increment(1),
        newLeadsAdded: increment(1),
        newLeads: increment(1),
        proposalsCount:
          params.newStatus === 'PROPOSAL_SHARED' ? increment(1) : increment(0),
        interestedCount:
          params.newStatus === 'INTERESTED' || params.newStatus === 'CLOSED_WON'
            ? increment(1)
            : increment(0),
        wonCount: params.newStatus === 'CLOSED_WON' ? increment(1) : increment(0),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    reportCloudSyncError(err, 'recordFirstFreshTransitionStatsInFirestore');
  }
}

export function mergeDailyStatsRecordsPure(
  existing: DailyRepStatRecord[],
  incoming: DailyRepStatRecord[]
): DailyRepStatRecord[] {
  const map = new Map<string, DailyRepStatRecord>();
  for (const item of existing) {
    if (item && item.id) {
      map.set(item.id, { ...item });
    }
  }
  for (const inc of incoming) {
    if (!inc || !inc.id) continue;
    const prev = map.get(inc.id);
    if (!prev) {
      map.set(inc.id, { ...inc });
    } else {
      map.set(inc.id, {
        ...prev,
        repName: inc.repName || prev.repName,
        callsCount: Math.max(prev.callsCount || 0, inc.callsCount || 0),
        proposalsCount: Math.max(prev.proposalsCount || 0, inc.proposalsCount || 0),
        interestedCount: Math.max(prev.interestedCount || 0, inc.interestedCount || 0),
        newLeadsAdded: Math.max(prev.newLeadsAdded || 0, inc.newLeadsAdded || 0),
        wonCount: Math.max(prev.wonCount || 0, inc.wonCount || 0),
        updatedAt: inc.updatedAt || prev.updatedAt,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function loadLocalDailyStats(): DailyRepStatRecord[] {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DAILY_STATS_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
  return [];
}

export function saveLocalDailyStats(_stats: DailyRepStatRecord[]): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DAILY_STATS_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

/**
 * Syncs `daily_stats/{YYYY-MM-DD}_{repEmail}` summary documents to `reachDb` in 400-op chunks.
 */
export async function syncDailyStatsToFirestore(
  leads: LeadRecord[]
): Promise<DailyRepStatRecord[]> {
  const computed = computeDailyStatsFromLeadsPure(leads);
  if (!hasLiveReachFirebaseConfig() || computed.length === 0) {
    return computed;
  }

  try {
    for (let i = 0; i < computed.length; i += 400) {
      const chunk = computed.slice(i, i + 400);
      const wb = writeBatch(reachDb);
      for (const stat of chunk) {
        wb.set(
          doc(reachDb, 'daily_stats', stat.id),
          sanitizeFirestorePayload(stat),
          { merge: true }
        );
      }
      await wb.commit();
    }
  } catch (err) {
    reportCloudSyncError(err, 'syncDailyStatsToFirestore');
  }

  return computed;
}

/**
 * Fetches all lightweight `daily_stats` documents directly from `reachDb` server.
 */
export async function fetchDailyStatsFromFirestore(): Promise<DailyRepStatRecord[]> {
  if (!hasLiveReachFirebaseConfig()) {
    return [];
  }
  try {
    const snap = await withFirestoreNetworkRetry(
      () => getDocs(collection(reachDb, 'daily_stats')),
      1500
    );
    const list: DailyRepStatRecord[] = [];
    snap.forEach((d) => {
      list.push(d.data() as DailyRepStatRecord);
    });
    return list;
  } catch (err) {
    reportCloudSyncError(err, 'fetchDailyStatsFromFirestore');
    return [];
  }
}

let isAggregationQuerySupported =
  process.env.NEXT_PUBLIC_REACH_ENABLE_SERVER_AGGREGATION === 'true';

/**
 * Uses Firestore `getCountFromServer()` single-field equality queries (no composite index or orderBy)
 * to count 50,000+ leads across statuses without downloading full document payloads.
 */
export async function fetchOwnerMetricCountsFromServer(
  todayYmd: string = new Date().toISOString().slice(0, 10)
): Promise<OwnerMetricStripData | null> {
  if (!hasLiveReachFirebaseConfig() || !isAggregationQuerySupported) return null;

  try {
    const leadsRef = collection(reachDb, 'leads');
    const allLeadsSnap = await getCountFromServer(leadsRef).catch(() => {
      isAggregationQuerySupported = false;
      return null;
    });
    if (!allLeadsSnap) {
      return null;
    }

    const [
      freshSnap,
      revivedSnap,
      proposalSnap,
      interestedSnap,
      futureSnap,
      leadLostSnap,
      notInterestedSnap,
      notSolarSnap,
      switchOffDeadSnap,
      didntReceiveDeadSnap,
      closedWonSnap,
    ] = await Promise.all([
      getCountFromServer(query(leadsRef, where('status', '==', 'FRESH'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'REVIVED_FRESH'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'PROPOSAL_SHARED'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'INTERESTED'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'FUTURE_REQUIREMENT'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'LEAD_LOST'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'NOT_INTERESTED'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'NOT_A_SOLAR_COMPANY'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'SWITCH_OFF_DEAD'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'DIDNT_RECEIVE_DEAD'))),
      getCountFromServer(query(leadsRef, where('status', '==', 'CLOSED_WON'))),
    ]);

    const deadCount =
      leadLostSnap.data().count +
      notInterestedSnap.data().count +
      notSolarSnap.data().count +
      switchOffDeadSnap.data().count +
      didntReceiveDeadSnap.data().count +
      closedWonSnap.data().count;

    const todayStatsSnap = await getDocs(
      query(collection(reachDb, 'daily_stats'), where('date', '==', todayYmd))
    ).catch(() => null);

    let callsDialedToday = 0;
    if (todayStatsSnap && !todayStatsSnap.empty) {
      todayStatsSnap.forEach((d) => {
        const data = d.data() as DailyRepStatRecord;
        callsDialedToday += data.callsCount || 0;
      });
    }

    return {
      totalFreshPool: freshSnap.data().count + revivedSnap.data().count,
      proposalsShared: proposalSnap.data().count,
      interestedOwnerQueue: interestedSnap.data().count,
      futureRequirement: futureSnap.data().count,
      callsDialedToday,
      deadClosedOut: deadCount,
      totalAllLeads: allLeadsSnap.data().count,
    };
  } catch {
    isAggregationQuerySupported = false;
    return null;
  }
}

/**
 * Server-side 50-row cursor pagination query using single-field equality where() clauses
 * (no orderBy or composite index requirements) and in-memory filtering/sorting.
 */
export async function fetchPaginatedLeadsPageFromFirestore(options?: {
  pageSize?: number;
  lastVisibleDoc?: QueryDocumentSnapshot | null;
  statusFilter?: string;
  activeBatchIdFilter?: string | null;
}): Promise<{
  leads: LeadRecord[];
  lastVisibleDoc: QueryDocumentSnapshot | null;
  hasMore: boolean;
}> {
  const pageSize = Math.max(1, options?.pageSize || 50);
  if (!hasLiveReachFirebaseConfig()) {
    return { leads: [], lastVisibleDoc: null, hasMore: false };
  }

  try {
    const constraints: QueryConstraint[] = [];
    if (options?.activeBatchIdFilter) {
      // Single primary filter on assignedBatchId + limit(100), then filter status === 'FRESH' in memory
      constraints.push(where('assignedBatchId', '==', options.activeBatchIdFilter));
      if (options?.lastVisibleDoc) {
        constraints.push(startAfter(options.lastVisibleDoc));
      }
      constraints.push(limit(Math.max(100, pageSize)));
    } else if (options?.statusFilter && options.statusFilter !== 'ALL') {
      constraints.push(where('status', '==', options.statusFilter));
      if (options?.lastVisibleDoc) {
        constraints.push(startAfter(options.lastVisibleDoc));
      }
      constraints.push(limit(pageSize));
    } else {
      if (options?.lastVisibleDoc) {
        constraints.push(startAfter(options.lastVisibleDoc));
      }
      constraints.push(limit(pageSize));
    }

    const snap = await getDocs(query(collection(reachDb, 'leads'), ...constraints));
    const rawLeads: LeadRecord[] = [];
    snap.forEach((d) => {
      rawLeads.push({ id: d.id, ...(d.data() as Omit<LeadRecord, 'id'>) });
    });

    const filteredLeads =
      options?.activeBatchIdFilter &&
      (!options.statusFilter || options.statusFilter === 'FRESH')
        ? rawLeads.filter(
            (l) => l.status === 'FRESH' || l.status === 'REVIVED_FRESH'
          )
        : rawLeads;

    const lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    return {
      leads: filteredLeads.slice(0, pageSize),
      lastVisibleDoc: lastDoc,
      hasMore: snap.docs.length >= pageSize,
    };
  } catch {
    return { leads: [], lastVisibleDoc: null, hasMore: false };
  }
}


