import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyMockOrSyntheticLead,
  verifyEmailInRolesListPure,
} from './leadStore';
import { INITIAL_AUTHORIZED_USERS, INITIAL_BATCHES, INITIAL_LEADS } from './seedData';
import {
  formatRoleBadgeText,
  formatSubduedDailyCallsText,
  formatUserAvatarInitials,
} from '../components/layout/Header';
import {
  computeOwnerMetricStripPure,
  computeSalesRepMetricStripPure,
  filterVisibleBatchesForUserPure,
} from './dashboardMetrics';
import {
  formatCityState,
  formatDisplayPhone,
  formatLastCalledDate,
  formatTelHref,
} from '../components/calling/CallingTable';
import { DATE_PRESET_OPTIONS } from '../components/dashboard/WorkspaceNav';

describe('Comprehensive Cleanup: Minimalist Zerodha-Style Refactor', () => {
  it('1. Login Role Verification: rejects unregistered emails with "Access denied. Unregistered email." and resolves active Owner & Sales Rep profiles', () => {
    const denied = verifyEmailInRolesListPure(
      'unregistered@randomdomain.com',
      INITIAL_AUTHORIZED_USERS
    );
    assert.equal(denied.success, false);
    assert.equal(denied.error, 'Access denied. Unregistered email.');

    const ownerRes = verifyEmailInRolesListPure(
      '  OWNER@solarithmdesign.com ',
      INITIAL_AUTHORIZED_USERS
    );
    assert.equal(ownerRes.success, true);
    assert.equal(ownerRes.user?.role, 'owner');
    assert.equal(ownerRes.user?.name, 'Jay Shah');

    const salesRes = verifyEmailInRolesListPure(
      'sales@solarithmdesign.com',
      INITIAL_AUTHORIZED_USERS
    );
    assert.equal(salesRes.success, true);
    assert.equal(salesRes.user?.role, 'sales');
  });

  it('2. Strict Role-Based Header Isolation: formats static badges ([Owner] Jay Shah / [Sales Rep] Name) and Today\'s Calls pill without 120 limit', () => {
    assert.equal(formatRoleBadgeText('owner', 'Jay Shah'), '[Owner] Jay Shah');
    assert.equal(
      formatRoleBadgeText('sales', 'Priya Nair (Sr. Solar Outreach Specialist)'),
      '[Sales Rep] Priya Nair'
    );
    assert.equal(formatSubduedDailyCallsText(43), "Today's Calls: 43");
  });

  it('3.A & 3.B: purges all dummy leads (INITIAL_LEADS = []), shows 0 when no calls dialed today, and computes Owner & Sales Rep metrics dynamically from live leads', () => {
    // Verify all 14+ dummy leads and mock batches are purged from seedData
    assert.equal(INITIAL_LEADS.length, 0);
    assert.equal(INITIAL_BATCHES.length, 0);

    // Verify leftover test records ("SuryaVega Analytics Test Solar" / "9825099887") are flagged and purged
    assert.equal(
      isLegacyMockOrSyntheticLead({
        id: 'lead-suryavega-1',
        companyName: 'SuryaVega Analytics Test Solar',
        phoneNumber: '9825099887',
        formattedPhone: '+91 98250 99887',
        status: 'CLOSED_WON',
      }),
      true
    );
    assert.equal(
      isLegacyMockOrSyntheticLead({
        id: 'lead-phone-only',
        companyName: 'Other Name',
        phoneNumber: '9825099887',
      }),
      true
    );

    // When no leads exist, all 6 Owner metrics (including callsDialedToday) must be 0
    const emptyOwnerMetrics = computeOwnerMetricStripPure([], INITIAL_AUTHORIZED_USERS);
    assert.deepEqual(emptyOwnerMetrics, {
      totalFreshPool: 0,
      proposalsShared: 0,
      interestedOwnerQueue: 0,
      futureRequirement: 0,
      callsDialedToday: 0,
      deadClosedOut: 0,
    });

    // When no leads or batches exist, all 4 Sales Rep metrics (including myCallsToday) must be 0
    const emptySalesMetrics = computeSalesRepMetricStripPure(
      [],
      [],
      'hastisavani.07@solarithmdesign.com'
    );
    assert.deepEqual(emptySalesMetrics, {
      batchLeadsRemaining: 0,
      myCallsToday: 0,
      proposalsPendingFollowUp: 0,
      futureRequirementsDue: 0,
    });

    // When a Sales Rep adds/calls a lead today, myCallsToday and callsDialedToday increment dynamically
    const todayIso = new Date().toISOString();
    const todayDate = todayIso.slice(0, 10);
    const liveLeads = [
      {
        id: 'lead-live-1',
        companyName: 'Surya Industrial Rooftop Pvt Ltd',
        companyNameNormalized: 'surya industrial rooftop pvt ltd',
        phoneNumber: '9825011223',
        formattedPhone: '+91 98250 11223',
        altNumber: null,
        state: 'Gujarat',
        city: 'Ahmedabad',
        email: 'info@suryarooftop.in',
        status: 'PROPOSAL_SHARED' as const,
        assignedBatchId: null,
        assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
        assignedRepName: 'Savani Hasti Vijaybhai',
        callAttempts: 1,
        didntReceiveCount: 0,
        switchOffCount: 0,
        lastCalledDate: todayIso,
        lastCalledByEmail: 'hastisavani.07@solarithmdesign.com',
        cooldownUntil: null,
        nextFollowUpDate: null,
        createdAt: todayIso,
        updatedAt: todayIso,
        notes: '500 kWp proposal shared',
      },
      {
        id: 'lead-live-2',
        companyName: 'Apex Solar Spinners Ltd',
        companyNameNormalized: 'apex solar spinners ltd',
        phoneNumber: '9822044556',
        formattedPhone: '+91 98220 44556',
        altNumber: null,
        state: 'Maharashtra',
        city: 'Pune',
        email: null,
        status: 'INTERESTED' as const,
        assignedBatchId: null,
        assignedRepEmail: 'krinadhami.10@solarithmdesign.com',
        assignedRepName: 'Dhami Krina Rajeshbhai',
        callAttempts: 1,
        didntReceiveCount: 0,
        switchOffCount: 0,
        lastCalledDate: todayIso,
        lastCalledByEmail: 'krinadhami.10@solarithmdesign.com',
        cooldownUntil: null,
        nextFollowUpDate: null,
        createdAt: todayIso,
        updatedAt: todayIso,
        notes: 'Escalated to Owner queue',
      },
    ];

    const liveOwnerMetrics = computeOwnerMetricStripPure(
      liveLeads,
      INITIAL_AUTHORIZED_USERS
    );
    assert.equal(liveOwnerMetrics.proposalsShared, 1);
    assert.equal(liveOwnerMetrics.interestedOwnerQueue, 1);
    assert.equal(liveOwnerMetrics.callsDialedToday, 2);

    const liveBatches = [
      {
        batchId: `BATCH_${todayDate.replace(/-/g, '_')}_01`,
        batchNumber: 1,
        date: todayDate,
        totalLeads: 3000,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE' as const,
        completedCallsCount: 0,
        leadIds: [],
        createdAt: todayIso,
      },
      {
        batchId: `BATCH_${todayDate.replace(/-/g, '_')}_02`,
        batchNumber: 2,
        date: todayDate,
        totalLeads: 3000,
        claimedByEmail: 'hastisavani.07@solarithmdesign.com',
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: todayIso,
        status: 'IN_PROGRESS' as const,
        completedCallsCount: 1,
        leadIds: [],
        createdAt: todayIso,
      },
    ];

    const hastiMetrics = computeSalesRepMetricStripPure(
      liveLeads,
      liveBatches,
      'hastisavani.07@solarithmdesign.com'
    );
    assert.equal(hastiMetrics.batchLeadsRemaining, 2999);
    assert.equal(hastiMetrics.myCallsToday, 1);
    assert.equal(hastiMetrics.proposalsPendingFollowUp, 1);

    // Other sales rep (Krina) must NOT see Batch #2 claimed by Hasti
    const krinaVisibleBatches = filterVisibleBatchesForUserPure(liveBatches, {
      email: 'krinadhami.10@solarithmdesign.com',
      name: 'Dhami Krina Rajeshbhai',
      role: 'SALES',
      status: 'ACTIVE',
      isSalesTier: true,
    });
    assert.equal(
      krinaVisibleBatches.some((b) => b.batchNumber === 2),
      false,
      'Batch #2 claimed by Hasti must disappear completely from Krina screen'
    );
    assert.equal(krinaVisibleBatches.length, 1);
  });

  it('3.C Calling Queue Table helpers format +91 XXXXX XXXXX, City/State, and Last Called date', () => {
    const sampleLead = {
      id: 'sample-1',
      companyName: 'Sample Solar Co',
      companyNameNormalized: 'sample solar co',
      phoneNumber: '9825011223',
      formattedPhone: '+91 98250 11223',
      altNumber: null,
      state: 'Gujarat',
      city: 'Ahmedabad',
      email: null,
      status: 'FRESH' as const,
      assignedBatchId: null,
      assignedRepEmail: null,
      assignedRepName: null,
      callAttempts: 0,
      didntReceiveCount: 0,
      switchOffCount: 0,
      lastCalledDate: null,
      cooldownUntil: null,
      nextFollowUpDate: null,
      createdAt: '2026-10-27T04:30:00.000Z',
      updatedAt: '2026-10-27T04:30:00.000Z',
      notes: '',
    };
    assert.equal(formatDisplayPhone(sampleLead), '+91 98250 11223');
    assert.equal(formatTelHref(sampleLead), 'tel:+919825011223');
    assert.equal(formatCityState(sampleLead), 'Ahmedabad, Gujarat');
    assert.equal(formatLastCalledDate(null), 'Never');
    assert.equal(formatLastCalledDate('2026-10-27T04:30:00.000Z'), '2026-10-27');

    // Verify mobile avatar initials collapse and scrollable date presets
    assert.equal(formatUserAvatarInitials('Savani Hasti Vijaybhai'), 'SH');
    assert.equal(formatUserAvatarInitials('Jay Jalpa (Owner)'), 'JJ');
    assert.equal(formatUserAvatarInitials('Admin'), 'AD');
    assert.equal(DATE_PRESET_OPTIONS.length, 6);
  });
});

