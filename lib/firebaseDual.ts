import { FirebaseApp, FirebaseOptions, getApps, initializeApp } from 'firebase/app';
import { Firestore, getFirestore, setLogLevel } from 'firebase/firestore';
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
 * Initialized using Nexus Admin Console environment variables (`ADMIN_FIREBASE_*`).
 * STRICTLY READ-ONLY for Reach operations: used solely to verify login email,
 * check active employee status, and fetch active sales rep rosters from `/employees` and `/users`.
 */
export const ADMIN_FIREBASE_CONFIG: FirebaseOptions = {
  apiKey:
    process.env.ADMIN_FIREBASE_API_KEY ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_API_KEY ||
    'AIzaSyBMQYHq8sqI9eiDEqiImNAjiRrCuLJoTMQ',
  authDomain:
    process.env.ADMIN_FIREBASE_AUTH_DOMAIN ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_AUTH_DOMAIN ||
    'solarithm-master.firebaseapp.com',
  projectId:
    process.env.ADMIN_FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_PROJECT_ID ||
    'solarithm-master',
  storageBucket:
    process.env.ADMIN_FIREBASE_STORAGE_BUCKET ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_STORAGE_BUCKET ||
    'solarithm-master.firebasestorage.app',
  messagingSenderId:
    process.env.ADMIN_FIREBASE_MESSAGING_SENDER_ID ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_MESSAGING_SENDER_ID ||
    '560851710395',
  appId:
    process.env.ADMIN_FIREBASE_APP_ID ||
    process.env.NEXT_PUBLIC_ADMIN_FIREBASE_APP_ID ||
    '1:560851710395:web:14f29e7ab994666870d49e',
};

/**
 * 2. Reach Operations Configuration (`solarithm-tools-370ed`)
 * Initialized using dedicated Reach operational environment variables (`REACH_FIREBASE_*`).
 * READ & WRITE for all lead records, daily 3,000-lead batches, Excel uploads,
 * call notes, dispositions, audit logs, and owner closing metrics.
 */
export const REACH_FIREBASE_CONFIG: FirebaseOptions = {
  apiKey:
    process.env.REACH_FIREBASE_API_KEY ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_API_KEY ||
    'AIzaSyDnSrWcVt-eOKTm1_ncz5eYdIqeO4HKlsE',
  authDomain:
    process.env.REACH_FIREBASE_AUTH_DOMAIN ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_AUTH_DOMAIN ||
    'solarithm-tools-370ed.firebaseapp.com',
  projectId:
    process.env.REACH_FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_PROJECT_ID ||
    'solarithm-tools-370ed',
  storageBucket:
    process.env.REACH_FIREBASE_STORAGE_BUCKET ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_STORAGE_BUCKET ||
    'solarithm-tools-370ed.firebasestorage.app',
  messagingSenderId:
    process.env.REACH_FIREBASE_MESSAGING_SENDER_ID ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_MESSAGING_SENDER_ID ||
    '76083145868',
  appId:
    process.env.REACH_FIREBASE_APP_ID ||
    process.env.NEXT_PUBLIC_REACH_FIREBASE_APP_ID ||
    '1:76083145868:web:2061d43078c6c9fc8cdfa9',
};

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
 * Admin / Org Directory App (`solarithm-master`) — STRICTLY READ-ONLY
 */
export const adminApp: FirebaseApp = getOrInitializeNamedApp(
  ADMIN_APP_NAME,
  ADMIN_FIREBASE_CONFIG
);
export const adminDb: Firestore = getFirestore(adminApp);
export const adminAuth: Auth = getAuth(adminApp);

/**
 * Reach Operations App (`solarithm-tools-370ed`) — READ & WRITE
 */
export const reachApp: FirebaseApp = getOrInitializeNamedApp(
  REACH_APP_NAME,
  REACH_FIREBASE_CONFIG
);
export const reachDb: Firestore = getFirestore(reachApp);
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
