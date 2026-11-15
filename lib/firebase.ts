import {
  ADMIN_FIREBASE_CONFIG,
  REACH_FIREBASE_CONFIG,
  adminApp,
  adminAuth,
  adminDb,
  hasLiveAdminFirebaseConfig,
  hasLiveReachFirebaseConfig,
  reachApp,
  reachAuth,
  reachDb,
} from './firebaseDual';

/**
 * Default operational Firebase exports bound strictly to `reachApp` / `reachDb` (`solarithm-tools-370ed`).
 * All operational outreach collections (`leads`, `batches`, `audit_logs`, `config`) read and write via `reachDb`.
 * Organization identity & employee lookups (`/employees`, `/users`, `/apps`) strictly read from `adminDb` (`solarithm-master`).
 */
export const app = reachApp;
export const db = reachDb;
export const auth = reachAuth;

export {
  adminApp,
  adminDb,
  adminAuth,
  reachApp,
  reachDb,
  reachAuth,
  ADMIN_FIREBASE_CONFIG,
  REACH_FIREBASE_CONFIG,
  hasLiveAdminFirebaseConfig,
  hasLiveReachFirebaseConfig,
};

