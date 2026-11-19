import { FirebaseApp, FirebaseOptions, getApps, initializeApp } from 'firebase/app';
import {
  Firestore,
  doc,
  getDoc,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  setLogLevel,
} from 'firebase/firestore';
import { Auth, getAuth } from 'firebase/auth';

try {
  setLogLevel('silent');
} catch {
  // Ignore if unsupported in environment
}

export const ADMIN_APP_NAME = 'solarithm-admin-directory';
export const REACH_APP_NAME = 'solarithm-reach-operations';

/**
 * 1. Admin / Org Directory Configuration (`solarithm-master`)
 * Initialized using Nexus Admin Console environment variables (`NEXT_PUBLIC_ADMIN_FIREBASE_*`)
 * with hardcoded production fallback constants for static export reliability.
 * STRICTLY READ-ONLY for Reach operations: used solely to verify login email,
 * check active employee status, and fetch active sales rep rosters from `/employees` and `/users`.
 */
export const ADMIN_FIREBASE_CONFIG: FirebaseOptions = {
  apiKey:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_API_KEY ||
    process.env.ADMIN_FIREBASE_API_KEY ||
    'AIzaSyBMQYHq8sqI9eiDEqiImNAjiRrCuLJoTMQ',
  authDomain:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_AUTH_DOMAIN ||
    process.env.ADMIN_FIREBASE_AUTH_DOMAIN ||
    'solarithm-master.firebaseapp.com',
  projectId:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_PROJECT_ID ||
    process.env.ADMIN_FIREBASE_PROJECT_ID ||
    'solarithm-master',
  storageBucket:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_STORAGE_BUCKET ||
    process.env.ADMIN_FIREBASE_STORAGE_BUCKET ||
    'solarithm-master.firebasestorage.app',
  messagingSenderId:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_MESSAGING_SENDER_ID ||
    process.env.ADMIN_FIREBASE_MESSAGING_SENDER_ID ||
    '560851710395',
  appId:
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_APP_ID ||
    process.env.ADMIN_FIREBASE_APP_ID ||
    '1:560851710395:web:14f29e7ab994666870d49e',
};

/**
 * 2. Reach Operations Configuration (`solarithm-tools-370ed`)
 * Initialized using dedicated Reach operational environment variables (`NEXT_PUBLIC_REACH_FIREBASE_*`)
 * with hardcoded production fallback constants for static export reliability.
 * READ & WRITE for all lead records, daily batches, Excel uploads,
 * call notes, dispositions, audit logs, and owner closing metrics.
 */
export const REACH_FIREBASE_CONFIG: FirebaseOptions = {
  apiKey:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_API_KEY ||
    process.env.REACH_FIREBASE_API_KEY ||
    'AIzaSyDnSrWcVt-eOKTm1_ncz5eYdIqeO4HKlsE',
  authDomain:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_AUTH_DOMAIN ||
    process.env.REACH_FIREBASE_AUTH_DOMAIN ||
    'solarithm-tools-370ed.firebaseapp.com',
  projectId:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_PROJECT_ID ||
    process.env.REACH_FIREBASE_PROJECT_ID ||
    'solarithm-tools-370ed',
  storageBucket:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_STORAGE_BUCKET ||
    process.env.REACH_FIREBASE_STORAGE_BUCKET ||
    'solarithm-tools-370ed.firebasestorage.app',
  messagingSenderId:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_MESSAGING_SENDER_ID ||
    process.env.REACH_FIREBASE_MESSAGING_SENDER_ID ||
    '76083145868',
  appId:
    process.env.NEXT_PUBLIC_REACH_FIREBASE_APP_ID ||
    process.env.REACH_FIREBASE_APP_ID ||
    '1:76083145868:web:2061d43078c6c9fc8cdfa9',
};

export const adminConfig = ADMIN_FIREBASE_CONFIG;
export const reachConfig = REACH_FIREBASE_CONFIG;

function getOrInitializeNamedApp(
  name: string,
  config: FirebaseOptions
): FirebaseApp {
  const existing = getApps().find((app) => app.name === name);
  if (existing) {
    return existing;
  }
  return initializeApp(config, name);
}

/**
 * Initializes Firestore with standard `memoryLocalCache()` ONLY (no IndexedDB offline queue)
 * and `experimentalAutoDetectLongPolling: true` so mobile browsers on cellular networks (Jio/Airtel)
 * automatically fall back to HTTP long polling when WebChannel streams are throttled or dropped.
 */
function getOrInitializeMemoryFirestore(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, {
      localCache: memoryLocalCache(),
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    return getFirestore(app);
  }
}

/**
 * Admin / Org Directory App (`solarithm-master`) — STRICTLY READ-ONLY
 */
export const adminApp: FirebaseApp = getOrInitializeNamedApp(
  ADMIN_APP_NAME,
  ADMIN_FIREBASE_CONFIG
);
export const adminDb: Firestore = getOrInitializeMemoryFirestore(adminApp);
export const adminAuth: Auth = getAuth(adminApp);

/**
 * Reach Operations App (`solarithm-tools-370ed`) — READ & WRITE
 */
export const reachApp: FirebaseApp = getOrInitializeNamedApp(
  REACH_APP_NAME,
  REACH_FIREBASE_CONFIG
);
export const reachDb: Firestore = getOrInitializeMemoryFirestore(reachApp);
export const reachAuth: Auth = getAuth(reachApp);

/**
 * Returns whether the Admin / Org Directory Firebase configuration has a valid non-placeholder API key.
 */
export function hasLiveAdminFirebaseConfig(): boolean {
  return Boolean(
    ADMIN_FIREBASE_CONFIG.apiKey &&
      !ADMIN_FIREBASE_CONFIG.apiKey.includes('DummyKey') &&
      ADMIN_FIREBASE_CONFIG.projectId === 'solarithm-master'
  );
}

/**
 * Returns whether the Reach Operations Firebase configuration has a valid non-placeholder API key.
 */
export function hasLiveReachFirebaseConfig(): boolean {
  return Boolean(
    REACH_FIREBASE_CONFIG.apiKey &&
      !REACH_FIREBASE_CONFIG.apiKey.includes('DummyKey') &&
      REACH_FIREBASE_CONFIG.projectId === 'solarithm-tools-370ed'
  );
}

/**
 * Guard helper enforcing that `adminDb` is strictly read-only within Solarithm Reach.
 */
export function assertAdminDbReadOnlyOperation(operationName: string): never {
  throw new Error(
    `Write Forbidden (${operationName}): adminDb (solarithm-master) is strictly READ-ONLY for Solarithm Reach operations.`
  );
}

export interface CloudSyncErrorEvent {
  projectId: string;
  errorCode: string;
  errorMessage: string;
  operation: string;
  guidanceHint: string;
  formattedBanner: string;
  timestamp: string;
}

type CloudSyncErrorListener = (error: CloudSyncErrorEvent | null) => void;
const cloudSyncErrorListeners = new Set<CloudSyncErrorListener>();
let latestCloudSyncError: CloudSyncErrorEvent | null = null;

/**
 * Detects transient cellular/mobile network or WebChannel offline errors (`unavailable`, `client is offline`, etc.).
 */
export function isTransientNetworkOrOfflineFirestoreError(err: unknown): boolean {
  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code).toLowerCase()
      : '';
  const rawMessage =
    err instanceof Error
      ? err.message.toLowerCase()
      : err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message).toLowerCase()
      : String(err || '').toLowerCase();

  return (
    rawCode.includes('unavailable') ||
    rawCode.includes('deadline-exceeded') ||
    rawCode.includes('cancelled') ||
    rawMessage.includes('client is offline') ||
    rawMessage.includes('unavailable') ||
    rawMessage.includes('network')
  );
}

/**
 * Executes a Firestore read/check operation with a single lightweight retry (~1.5s delay)
 * when a transient mobile network or `unavailable` offline error occurs.
 */
export async function withFirestoreNetworkRetry<T>(
  operationFn: () => Promise<T>,
  retryDelayMs: number = 1500
): Promise<T> {
  try {
    return await operationFn();
  } catch (err) {
    if (isTransientNetworkOrOfflineFirestoreError(err)) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      return await operationFn();
    }
    throw err;
  }
}

/**
 * Surfaces any Firestore permission-denied or network write/read error to the UI alert banner,
 * accurately distinguishing network/offline connectivity issues from actual `permission-denied` rule errors.
 */
export function reportCloudSyncError(
  err: unknown,
  operation: string = 'Firestore Sync'
): CloudSyncErrorEvent {
  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const rawMessage =
    err instanceof Error
      ? err.message
      : err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message)
      : String(err || 'Unknown Firestore Error');

  const errorCode = rawCode || rawMessage || 'firestore/error';
  const projectId = String(REACH_FIREBASE_CONFIG.projectId || 'solarithm-tools-370ed');

  const lowerCode = errorCode.toLowerCase();
  const lowerMsg = rawMessage.toLowerCase();
  const isPermissionError =
    lowerCode.includes('permission-denied') ||
    lowerCode.includes('unauthenticated') ||
    lowerMsg.includes('missing or insufficient permissions') ||
    lowerMsg.includes('permission_denied');
  const isNetworkOfflineError = isTransientNetworkOrOfflineFirestoreError(err);

  const guidanceHint = isPermissionError
    ? 'Check Firestore Rules'
    : isNetworkOfflineError
    ? 'Network / Offline Connectivity Issue (Check Internet or Cellular Connection)'
    : 'Check Network Connection or Firestore Rules';

  const formattedBanner = `Cloud Sync Error on project ${projectId}: ${errorCode} — ${guidanceHint}`;

  const event: CloudSyncErrorEvent = {
    projectId,
    errorCode,
    errorMessage: rawMessage,
    operation,
    guidanceHint,
    formattedBanner,
    timestamp: new Date().toISOString(),
  };

  latestCloudSyncError = event;
  for (const listener of cloudSyncErrorListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener error
    }
  }
  return event;
}

export function clearCloudSyncError(): void {
  latestCloudSyncError = null;
  for (const listener of cloudSyncErrorListeners) {
    try {
      listener(null);
    } catch {
      // Ignore
    }
  }
}

export function getLatestCloudSyncError(): CloudSyncErrorEvent | null {
  return latestCloudSyncError;
}

export function subscribeToCloudSyncErrors(
  listener: CloudSyncErrorListener
): () => void {
  cloudSyncErrorListeners.add(listener);
  if (latestCloudSyncError) {
    listener(latestCloudSyncError);
  }
  return () => {
    cloudSyncErrorListeners.delete(listener);
  };
}

/**
 * Verifies live cloud server connectivity (`getDoc` with `memoryLocalCache()` + 1.5s retry)
 * against `solarithm-tools-370ed`.
 */
export async function verifyReachCloudConnectionFromServer(): Promise<{
  connected: boolean;
  projectId: string;
  errorCode?: string;
  errorMessage?: string;
}> {
  const projectId = String(REACH_FIREBASE_CONFIG.projectId || 'solarithm-tools-370ed');
  try {
    await withFirestoreNetworkRetry(
      () => getDoc(doc(reachDb, 'system_meta', 'daily_state')),
      1500
    );
    clearCloudSyncError();
    return {
      connected: true,
      projectId,
    };
  } catch (err) {
    const rawCode =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : 'unreachable';
    const rawMessage =
      err instanceof Error ? err.message : String(err || 'Connection failed');
    reportCloudSyncError(err, 'Cloud DB Server Ping');
    return {
      connected: false,
      projectId,
      errorCode: rawCode,
      errorMessage: rawMessage,
    };
  }
}

