import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import {
  authenticateEmployeeByEmail,
  CANONICAL_NEXUS_EMPLOYEES,
  evaluateEmployeeAccessPure,
  evaluateNexusAccessWithRegistryPure,
  grantReachAccess,
  mergeUserAndEmployeeRecordsPure,
  saveEmployeeDualCollection,
} from './authService';
import {
  filterAndSortReachSalesRepsPure,
  getActiveSalesReps,
} from './employeeQueries';
import {
  ADMIN_FIREBASE_CONFIG,
  REACH_FIREBASE_CONFIG,
  adminApp,
  adminDb,
  reachApp,
  reachDb,
} from './firebaseDual';
import { db as defaultOperationalDb } from './firebase';
import { leadOperationalDb } from './leadService';
import { formatRoleBadgeText } from '@/components/layout/Header';

test('Section 1: Multi-Collection Identity Resolution (/employees & /users) & Unification', async () => {
  // 1. Unifies /users Auth record with /employees HR record
  const unified = mergeUserAndEmployeeRecordsPure(
    {
      id: 'kPRFt0KAheN7IZ8wGr6zEjWLpri1',
      uid: 'sdm-dd-002-master',
      authUid: 'sdm-dd-002-master',
      employeeId: 'sdm-dd-002',
      email: 'deepdavara23@gmail.com',
      officialEmail: 'deepdavara.23@solarithmdesign.com',
      personalEmail: 'deepdavara23@gmail.com',
      role: 'owner',
      status: 'active',
      accessibleApps: ['solarithm-flow'],
    },
    {
      employeeId: 'SDM-DD-002',
      name: 'Davara Deep Arvindbhai',
      email: 'deepdavara.23@solarithmdesign.com',
      officialEmail: 'deepdavara.23@solarithmdesign.com',
      personalEmail: 'deepdavara23@gmail.com',
      role: 'OWNER',
      department: 'Executive Management',
      designation: 'Company Partner & Senior Solar Designer',
      status: 'ACTIVE',
      accessibleApps: ['solarithm-design-studio', 'solarithm-quotecraft'],
    }
  );

  assert.equal(unified.employeeId, 'SDM-DD-002');
  assert.equal(unified.uid, 'sdm-dd-002-master');
  assert.equal(unified.email, 'deepdavara.23@solarithmdesign.com');
  assert.equal(unified.personalEmail, 'deepdavara23@gmail.com');
  assert.equal(unified.role, 'OWNER');
  assert.equal(unified.status, 'ACTIVE');
  assert.equal(unified.accessibleApps?.length, 3);

  // 2. Live multi-collection lookup across officialEmail and personalEmail/personalEmailAddress
  const ownerByOfficial = await authenticateEmployeeByEmail(
    '  JAYSHAH.03@solarithmdesign.com '
  );
  assert.equal(ownerByOfficial.employeeId, 'SDM-JS-001');
  assert.equal(ownerByOfficial.isOwnerTier, true);

  const ownerByPersonal = await authenticateEmployeeByEmail(
    'jayjalpa2002@gmail.com'
  );
  assert.equal(ownerByPersonal.employeeId, 'SDM-JS-001');
  assert.equal(ownerByPersonal.isOwnerTier, true);

  const salesByPersonal = await authenticateEmployeeByEmail(
    'savanihasti2117@gmail.com'
  );
  assert.equal(salesByPersonal.employeeId, 'SOL-HS-001');
  assert.equal(salesByPersonal.isSalesTier, true);

  // 3. Unregistered email throws exact error message
  await assert.rejects(
    () => authenticateEmployeeByEmail('unregistered.user@example.com'),
    /Access Denied: Email is not registered in Solarithm Nexus\./
  );
});

test('Section 2 & 3: Status, Role Normalization & Authoritative App Registry Matrix', () => {
  // 1. Null/missing record -> Unregistered email in Solarithm Nexus
  assert.throws(
    () => evaluateEmployeeAccessPure(null),
    /Access Denied: Email is not registered in Solarithm Nexus\./
  );

  // 2. Inactive status -> Exact INACTIVE error message
  assert.throws(
    () =>
      evaluateEmployeeAccessPure({
        employeeId: 'SOL-EMP-10',
        name: 'Inactive User',
        email: 'inactive@solarithmdesign.com',
        role: 'SALES',
        status: 'INACTIVE',
        accessibleApps: ['reach'],
      }),
    /Access Denied: Your employee profile is currently marked INACTIVE\./
  );

  // 3. Check 3A: OWNER / ADMIN has unconditional global authority even before 'reach' is in accessibleApps
  const ownerEval = evaluateNexusAccessWithRegistryPure({
    employeeId: 'SDM-JS-001',
    uid: 'oIZpuLeftqaj3j5KS9ZIvurklEE2',
    name: 'Jay Jalpa (Owner)',
    email: 'jayshah.03@solarithmdesign.com',
    role: 'owner',
    department: 'Executive Management',
    designation: 'Owner',
    status: 'active',
    accessibleApps: ['solarithm-design-studio', 'solarithm-flow'],
  });
  assert.equal(ownerEval.sessionUser.isOwnerTier, true);
  assert.equal(ownerEval.sessionUser.isSalesTier, false);
  assert.equal(ownerEval.sessionUser.role, 'OWNER');
  assert.equal(ownerEval.needsReachAppSync, true);
  assert.equal(ownerEval.passedVia, 'OWNER_GLOBAL');

  // 4. Check 3B: SALES / LEAD_SALES or Sales department is granted access and flagged for auto-sync
  const salesEval = evaluateNexusAccessWithRegistryPure({
    employeeId: 'SOL-SO-007',
    uid: 'SOL-SO-007',
    name: 'Dhami Krina Rajeshbhai',
    email: 'krinadhami.10@solarithmdesign.com',
    role: 'SALES',
    department: 'Sales',
    designation: 'Sales Executive',
    status: 'ACTIVE',
    accessibleApps: ['solarithm-commerce'],
  });
  assert.equal(salesEval.sessionUser.isOwnerTier, false);
  assert.equal(salesEval.sessionUser.isSalesTier, true);
  assert.equal(salesEval.sessionUser.role, 'SALES');
  assert.equal(salesEval.needsReachAppSync, true);

  // 5. Check 3C: DESIGNER without 'reach' in accessibleApps or /apps/reach is rejected
  assert.throws(
    () =>
      evaluateNexusAccessWithRegistryPure({
        employeeId: 'SOL-SO-006',
        name: 'Sheladiya Om Mukeshbhai',
        email: 'designer@solarithmdesign.com',
        role: 'DESIGNER',
        department: 'Design',
        status: 'ACTIVE',
        accessibleApps: ['solarithm-design-studio'],
      }),
    /Access Restricted: Solarithm Reach is not enabled for your profile in Nexus\./
  );

  // 6. Check 3C (Check 1 pass): DESIGNER explicitly granted 'reach' in accessibleApps is mapped to Sales calling interface
  const designerWithApp = evaluateNexusAccessWithRegistryPure({
    employeeId: 'SOL-SO-006',
    name: 'Sheladiya Om Mukeshbhai',
    email: 'designer@solarithmdesign.com',
    role: 'DESIGNER',
    department: 'Design',
    status: 'ACTIVE',
    accessibleApps: ['solarithm-design-studio', 'reach'],
  });
  assert.equal(designerWithApp.sessionUser.isSalesTier, true);
  assert.equal(designerWithApp.sessionUser.isOwnerTier, false);
  assert.equal(designerWithApp.sessionUser.role, 'SALES');

  // 7. Check 3C (Check 2 pass): ENGINEER listed in /apps/reach allowedEmployees is mapped to Sales calling interface
  const engineerInAppRegistry = evaluateNexusAccessWithRegistryPure(
    {
      employeeId: 'SOL-ENG-01',
      uid: 'uid-eng-01',
      name: 'Kiran Patel',
      email: 'kiran@solarithmdesign.com',
      role: 'ENGINEER',
      department: 'Engineering',
      status: 'ACTIVE',
      accessibleApps: ['solarithm-design-studio'],
    },
    {
      appRegistry: {
        appId: 'reach',
        allowedEmployees: ['SOL-ENG-01'],
      },
    }
  );
  assert.equal(engineerInAppRegistry.sessionUser.isSalesTier, true);
  assert.equal(engineerInAppRegistry.passedVia, 'APP_REGISTRY');
});

test('Section 4: Permanent Synchronization for Morning Batch Sales Dropdown (lib/employeeQueries.ts)', async () => {
  // 1. Default (includeOwners = false): returns active Sales Reps, deduplicated & sorted alphabetically by name
  const salesOnly = filterAndSortReachSalesRepsPure(CANONICAL_NEXUS_EMPLOYEES, {
    includeOwners: false,
  });
  assert.deepEqual(
    salesOnly.map((r) => r.name),
    [
      'Bodra Krinal Rakeshbhai',
      'Dhami Krina Rajeshbhai',
      'Savani Hasti Vijaybhai',
    ]
  );
  assert.ok(
    salesOnly.every(
      (r) => r.employeeId && r.uid && r.name && r.email && r.designation && r.role
    )
  );

  // 2. With includeOwners = true: includes active Owners alongside Sales Reps
  const withOwners = filterAndSortReachSalesRepsPure(CANONICAL_NEXUS_EMPLOYEES, {
    includeOwners: true,
  });
  assert.equal(withOwners.length, 6);
  assert.ok(withOwners.some((r) => r.employeeId === 'SDM-JS-001'));
  assert.ok(withOwners.some((r) => r.employeeId === 'SDM-DD-002'));

  // 3. Cross-department employee listed in /apps/reach allowedEmployees is included
  const withRegistry = filterAndSortReachSalesRepsPure(
    CANONICAL_NEXUS_EMPLOYEES,
    {
      includeOwners: false,
      appRegistry: {
        appId: 'reach',
        allowedEmployees: ['SOL-KP-005'],
      },
    }
  );
  assert.ok(withRegistry.some((r) => r.employeeId === 'SOL-KP-005'));

  // 4. Live Firestore getActiveSalesReps() returns active Nexus sales reps
  const liveReps = await getActiveSalesReps({ includeOwners: false });
  assert.ok(liveReps.length >= 3);
  assert.ok(liveReps.some((r) => r.employeeId === 'SOL-HS-001'));
  assert.ok(liveReps.some((r) => r.employeeId === 'SOL-SO-007'));
  assert.ok(liveReps.some((r) => r.employeeId === 'SOL-SO-008'));
});

test('Sanitizer & Header Role Formatting', () => {
  const sanitized = sanitizeFirestorePayload({
    employeeId: 'SDM-JS-001',
    personalEmail: null,
    undefField: undefined,
  });
  assert.equal('undefField' in sanitized, false);
  assert.equal(formatRoleBadgeText('OWNER', 'Jay Shah'), '[Owner] Jay Shah');
  assert.equal(
    formatRoleBadgeText('SALES', 'Savani Hasti Vijaybhai'),
    '[Sales Rep] Savani Hasti Vijaybhai'
  );
});

test('Phase Dual-Firebase Architecture: Separate adminDb (solarithm-master) & reachDb (solarithm-tools-370ed)', async () => {
  // 1. Admin / Nexus Directory App targets solarithm-master
  assert.equal(ADMIN_FIREBASE_CONFIG.projectId, 'solarithm-master');
  assert.equal(
    ADMIN_FIREBASE_CONFIG.authDomain,
    'solarithm-master.firebaseapp.com'
  );
  assert.equal(
    ADMIN_FIREBASE_CONFIG.storageBucket,
    'solarithm-master.firebasestorage.app'
  );
  assert.equal(ADMIN_FIREBASE_CONFIG.messagingSenderId, '560851710395');
  assert.equal(
    ADMIN_FIREBASE_CONFIG.appId,
    '1:560851710395:web:14f29e7ab994666870d49e'
  );
  assert.equal(adminApp.options.projectId, 'solarithm-master');
  assert.equal(adminDb.app.options.projectId, 'solarithm-master');

  // 2. Reach Operations App targets solarithm-tools-370ed
  assert.equal(REACH_FIREBASE_CONFIG.projectId, 'solarithm-tools-370ed');
  assert.equal(
    REACH_FIREBASE_CONFIG.authDomain,
    'solarithm-tools-370ed.firebaseapp.com'
  );
  assert.equal(
    REACH_FIREBASE_CONFIG.storageBucket,
    'solarithm-tools-370ed.firebasestorage.app'
  );
  assert.equal(REACH_FIREBASE_CONFIG.messagingSenderId, '76083145868');
  assert.equal(
    REACH_FIREBASE_CONFIG.appId,
    '1:76083145868:web:2061d43078c6c9fc8cdfa9'
  );
  assert.equal(reachApp.options.projectId, 'solarithm-tools-370ed');
  assert.equal(reachDb.app.options.projectId, 'solarithm-tools-370ed');

  // 3. Strict database separation: adminDb !== reachDb, and operational services bind to reachDb
  assert.notEqual(adminDb, reachDb);
  assert.equal(defaultOperationalDb, reachDb);
  assert.equal(leadOperationalDb, reachDb);

  // 4. Strictly READ-ONLY enforcement on adminDb: writing employee or role data via Reach throws
  await assert.rejects(
    () =>
      saveEmployeeDualCollection({
        employeeId: 'SOL-TEST-99',
        email: 'test@solarithmdesign.com',
        role: 'SALES',
      }),
    /strictly READ-ONLY for Solarithm Reach operations/
  );

  await assert.rejects(
    () => grantReachAccess('SOL-TEST-99'),
    /strictly READ-ONLY for Solarithm Reach operations/
  );
});

