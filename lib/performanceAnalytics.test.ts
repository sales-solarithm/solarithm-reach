import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCallDispositionUpdatePure,
  computeOwnerAnalyticsPure,
  computeSalesRepAnalyticsPure,
  filterAndSortScorecardRows,
  resolveDateRangeBounds,
  resolveFocusedOwnerChartViewPure,
} from './performanceAnalytics';
import { ActiveReachSalesRep } from './employeeQueries';
import { LeadRecord } from './types';

function makeAnalyticsLead(
  id: string,
  overrides: Partial<LeadRecord> = {}
): LeadRecord {
  return {
    id,
    companyName: `Solar Client ${id}`,
    companyNameNormalized: `solar client ${id}`,
    phoneNumber: '9825011223',
    formattedPhone: '+91 98250 11223',
    altNumber: null,
    state: 'Gujarat',
    city: 'Ahmedabad',
    email: 'info@solarclient.in',
    status: 'FRESH',
    assignedBatchId: null,
    assignedRepEmail: null,
    assignedRepName: null,
    callAttempts: 0,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: null,
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-28T09:00:00.000Z',
    updatedAt: '2026-10-28T09:00:00.000Z',
    ...overrides,
  };
}

const SAMPLE_REPS: ActiveReachSalesRep[] = [
  {
    employeeId: 'SOL-HS-001',
    name: 'Savani Hasti Vijaybhai',
    email: 'hastisavani.07@solarithmdesign.com',
    officialEmail: 'hastisavani.07@solarithmdesign.com',
    role: 'SALES',
    department: 'Sales',
    designation: 'Lead Sales',
    status: 'ACTIVE',
  },
  {
    employeeId: 'SOL-SO-007',
    name: 'Dhami Krina Rajeshbhai',
    email: 'krinadhami.10@solarithmdesign.com',
    officialEmail: 'krinadhami.10@solarithmdesign.com',
    role: 'SALES',
    department: 'Sales',
    designation: 'Sales Executive',
    status: 'ACTIVE',
  },
];

describe('Executive & Rep Performance Analytics Engine (Zerodha Console Style)', () => {
  it('1. Date Range Filter resolves Today, Last 7 Days, This Month, Last 30 Days, All Time, and Custom ranges accurately', () => {
    const nowIso = '2026-11-01T12:00:00.000Z';

    const todayBounds = resolveDateRangeBounds({ preset: 'TODAY' }, nowIso);
    assert.equal(todayBounds.startDateStr, '2026-11-01');
    assert.equal(todayBounds.endDateStr, '2026-11-01');
    assert.equal(todayBounds.dayBuckets.length, 7);

    const last7Bounds = resolveDateRangeBounds({ preset: 'LAST_7_DAYS' }, nowIso);
    assert.equal(last7Bounds.startDateStr, '2026-10-26');
    assert.equal(last7Bounds.endDateStr, '2026-11-01');
    assert.equal(last7Bounds.dayBuckets.length, 7);

    const monthBounds = resolveDateRangeBounds({ preset: 'THIS_MONTH' }, nowIso);
    assert.equal(monthBounds.startDateStr, '2026-11-01');
    assert.equal(monthBounds.endDateStr, '2026-11-01');

    const last30Bounds = resolveDateRangeBounds({ preset: 'LAST_30_DAYS' }, nowIso);
    assert.equal(last30Bounds.dayBuckets.length, 30);

    const allTimeBounds = resolveDateRangeBounds({ preset: 'ALL_TIME' }, nowIso);
    assert.equal(allTimeBounds.startMs, null);
    assert.equal(allTimeBounds.endMs, null);

    const customBounds = resolveDateRangeBounds(
      {
        preset: 'CUSTOM',
        customStartDate: '2026-10-20',
        customEndDate: '2026-10-24',
      },
      nowIso
    );
    assert.equal(customBounds.startDateStr, '2026-10-20');
    assert.equal(customBounds.endDateStr, '2026-10-24');
    assert.equal(customBounds.dayBuckets.length, 5);
  });

  it('2. Activity Tracking & Owner Deal Conversion (CLOSED_WON / LEAD_LOST) preserve originating Sales Rep attribution', () => {
    const freshLead = makeAnalyticsLead('lead-conv-1');

    // Step 1: Sales Rep Hasti calls and marks the lead INTERESTED
    const interestedLead = applyCallDispositionUpdatePure(freshLead, {
      newStatus: 'INTERESTED',
      callDate: '2026-10-30',
      notes: '500 kW rooftop requirement confirmed',
      actorUser: {
        email: 'hastisavani.07@solarithmdesign.com',
        name: 'Savani Hasti Vijaybhai',
        role: 'SALES',
      },
      nowIso: '2026-10-30T11:00:00.000Z',
    });

    assert.equal(interestedLead.status, 'INTERESTED');
    assert.equal(interestedLead.assignedRepEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(interestedLead.assignedRepName, 'Savani Hasti Vijaybhai');
    assert.equal(interestedLead.lastCalledByEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(interestedLead.lastCalledByName, 'Savani Hasti Vijaybhai');
    assert.equal(interestedLead.interestedAt, '2026-10-30T11:00:00.000Z');
    assert.equal(interestedLead.closedWonAt, null);

    // Step 2: Owner Jay Shah clicks [Convert to Client (Closed Won)] in the Interested Queue
    const closedWonLead = applyCallDispositionUpdatePure(interestedLead, {
      newStatus: 'CLOSED_WON',
      callDate: '2026-11-01',
      notes: 'Advance payment received, deal won',
      actorUser: {
        email: 'jayshah.03@solarithmdesign.com',
        name: 'Jay Jalpa (Owner)',
        isOwnerTier: true,
        role: 'OWNER',
      },
      nowIso: '2026-11-01T14:30:00.000Z',
    });

    assert.equal(closedWonLead.status, 'CLOSED_WON');
    assert.equal(closedWonLead.closedWonAt, '2026-11-01T14:30:00.000Z');
    assert.equal(closedWonLead.interestedAt, '2026-10-30T11:00:00.000Z');
    // Originating Sales Rep attribution MUST remain Hasti so Hasti gets credit in "Interested Converted to Clients"
    assert.equal(closedWonLead.assignedRepEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(closedWonLead.assignedRepName, 'Savani Hasti Vijaybhai');
    assert.equal(closedWonLead.lastCalledByEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(closedWonLead.lastCalledByName, 'Savani Hasti Vijaybhai');
  });

  it('3. Owner Analytics & Sales Rep Personal Analytics compute accurate scorecards, funnels, and strictly isolated rep KPIs with zero mock numbers', () => {
    const nowIso = '2026-11-01T15:00:00.000Z';

    // Verify empty leads array produces 0s everywhere (no mock data)
    const emptyOwnerReport = computeOwnerAnalyticsPure(
      [],
      SAMPLE_REPS,
      { preset: 'LAST_7_DAYS' },
      nowIso
    );
    assert.equal(emptyOwnerReport.totalsRow.callsDialed, 0);
    assert.equal(emptyOwnerReport.totalsRow.newLeadsAdded, 0);
    assert.equal(emptyOwnerReport.totalsRow.proposalsShared, 0);
    assert.equal(emptyOwnerReport.totalsRow.interestedGenerated, 0);
    assert.equal(emptyOwnerReport.totalsRow.convertedToClientsWon, 0);

    // Populate live lead records across 2 Sales Reps (Hasti and Krina)
    const liveLeads: LeadRecord[] = [
      // Hasti Lead 1: Manually added via + Add Lead today, status PROPOSAL_SHARED
      makeAnalyticsLead('h-1', {
        status: 'PROPOSAL_SHARED',
        createdByEmail: 'hastisavani.07@solarithmdesign.com',
        createdByName: 'Savani Hasti Vijaybhai',
        createdByRole: 'SALES',
        assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
        assignedRepName: 'Savani Hasti Vijaybhai',
        lastCalledByEmail: 'hastisavani.07@solarithmdesign.com',
        lastCalledByName: 'Savani Hasti Vijaybhai',
        lastCalledDate: '2026-11-01T09:30:00.000Z',
        createdAt: '2026-11-01T09:30:00.000Z',
        updatedAt: '2026-11-01T09:30:00.000Z',
        callAttempts: 1,
      }),
      // Hasti Lead 2: Escalated to INTERESTED on Oct 30, then converted to CLOSED_WON by Owner on Nov 01
      makeAnalyticsLead('h-2', {
        status: 'CLOSED_WON',
        assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
        assignedRepName: 'Savani Hasti Vijaybhai',
        lastCalledByEmail: 'jayshah.03@solarithmdesign.com',
        lastCalledByName: 'Jay Jalpa',
        lastCalledDate: '2026-11-01T14:00:00.000Z',
        interestedAt: '2026-10-30T11:00:00.000Z',
        closedWonAt: '2026-11-01T14:00:00.000Z',
        callAttempts: 2,
        callHistory: [
          {
            id: 'c-1',
            timestamp: '2026-10-30T11:00:00.000Z',
            repEmail: 'hastisavani.07@solarithmdesign.com',
            repName: 'Savani Hasti Vijaybhai',
            previousStatus: 'FRESH',
            newStatus: 'INTERESTED',
          },
          {
            id: 'c-2',
            timestamp: '2026-11-01T14:00:00.000Z',
            repEmail: 'jayshah.03@solarithmdesign.com',
            repName: 'Jay Jalpa',
            previousStatus: 'INTERESTED',
            newStatus: 'CLOSED_WON',
          },
        ],
      }),
      // Hasti Lead 3: Currently INTERESTED in Owner Queue
      makeAnalyticsLead('h-3', {
        status: 'INTERESTED',
        assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
        assignedRepName: 'Savani Hasti Vijaybhai',
        lastCalledByEmail: 'hastisavani.07@solarithmdesign.com',
        lastCalledByName: 'Savani Hasti Vijaybhai',
        lastCalledDate: '2026-10-31T10:00:00.000Z',
        interestedAt: '2026-10-31T10:00:00.000Z',
        callAttempts: 1,
      }),
      // Krina Lead 1: Manually added via + Add Lead, status INTERESTED
      makeAnalyticsLead('k-1', {
        status: 'INTERESTED',
        createdByEmail: 'krinadhami.10@solarithmdesign.com',
        createdByName: 'Dhami Krina Rajeshbhai',
        createdByRole: 'SALES',
        assignedRepEmail: 'krinadhami.10@solarithmdesign.com',
        assignedRepName: 'Dhami Krina Rajeshbhai',
        lastCalledByEmail: 'krinadhami.10@solarithmdesign.com',
        lastCalledByName: 'Dhami Krina Rajeshbhai',
        lastCalledDate: '2026-11-01T10:15:00.000Z',
        interestedAt: '2026-11-01T10:15:00.000Z',
        createdAt: '2026-11-01T10:15:00.000Z',
        callAttempts: 1,
      }),
    ];

    const ownerReport = computeOwnerAnalyticsPure(
      liveLeads,
      SAMPLE_REPS,
      { preset: 'LAST_7_DAYS' },
      nowIso
    );

    const hastiRow = ownerReport.scorecardRows.find(
      (r) => r.repEmail === 'hastisavani.07@solarithmdesign.com'
    );
    assert.ok(hastiRow);
    assert.equal(hastiRow.callsDialed, 3);
    assert.equal(hastiRow.newLeadsAdded, 3); // All 3 leads (h-1, h-2, h-3) were engaged from FRESH by Hasti
    assert.equal(hastiRow.proposalsShared, 1);
    assert.equal(hastiRow.interestedGenerated, 2); // h-2 (now CLOSED_WON) + h-3 (INTERESTED)
    assert.equal(hastiRow.convertedToClientsWon, 1); // h-2
    assert.equal(hastiRow.interestedConversionRate, 66.7); // 2/3 = 66.7%
    assert.equal(hastiRow.wonConversionRate, 50.0); // 1/2 = 50.0%
    assert.equal(hastiRow.sparkline7d.length, 7);

    const krinaRow = ownerReport.scorecardRows.find(
      (r) => r.repEmail === 'krinadhami.10@solarithmdesign.com'
    );
    assert.ok(krinaRow);
    assert.equal(krinaRow.callsDialed, 1);
    assert.equal(krinaRow.newLeadsAdded, 1);
    assert.equal(krinaRow.interestedGenerated, 1);
    assert.equal(krinaRow.convertedToClientsWon, 0);

    // Check Sales Rep Personal Analytics isolation for Hasti
    const hastiPersonal = computeSalesRepAnalyticsPure(
      liveLeads,
      'hastisavani.07@solarithmdesign.com',
      'Savani Hasti Vijaybhai',
      { preset: 'LAST_7_DAYS' },
      120,
      nowIso
    );

    assert.equal(hastiPersonal.kpiStrip.myCallsSelectedPeriod, 3);
    assert.equal(hastiPersonal.kpiStrip.myCallsToday, 1); // h-1 called on 2026-11-01 by Hasti
    assert.equal(hastiPersonal.kpiStrip.dailyTarget, 120);
    assert.equal(hastiPersonal.kpiStrip.newLeadsAddedByMe, 3);
    assert.equal(hastiPersonal.kpiStrip.proposalsShared, 1);
    assert.equal(hastiPersonal.kpiStrip.convertedToInterested, 2);
    assert.equal(hastiPersonal.kpiStrip.interestedConvertedToClients, 1);
  });

  it('4. 30+ Rep Scaling Architecture: caps Top 5 lines, supports Custom 1-6 Rep Comparison, Click-to-Isolate vs Team Avg, and Scorecard Search/Sort', () => {
    const nowIso = '2026-11-01T15:00:00.000Z';

    // Simulate 32 active sales reps
    const thirtyTwoReps: ActiveReachSalesRep[] = Array.from({ length: 32 }, (_, idx) => {
      const num = idx + 1;
      return {
        employeeId: `SOL-REP-${String(num).padStart(3, '0')}`,
        name: `Sales Rep ${String(num).padStart(2, '0')}`,
        email: `rep${num}@solarithmdesign.com`,
        officialEmail: `rep${num}@solarithmdesign.com`,
        role: 'SALES',
        department: 'Sales',
        designation: 'Sales Executive',
        status: 'ACTIVE',
      };
    });

    const leadsForScale: LeadRecord[] = [
      makeAnalyticsLead('s-1', {
        status: 'CLOSED_WON',
        assignedRepEmail: 'rep1@solarithmdesign.com',
        assignedRepName: 'Sales Rep 01',
        lastCalledByEmail: 'rep1@solarithmdesign.com',
        lastCalledDate: '2026-11-01T10:00:00.000Z',
        interestedAt: '2026-11-01T10:00:00.000Z',
        closedWonAt: '2026-11-01T11:00:00.000Z',
        callAttempts: 1,
      }),
      makeAnalyticsLead('s-2', {
        status: 'INTERESTED',
        assignedRepEmail: 'rep2@solarithmdesign.com',
        assignedRepName: 'Sales Rep 02',
        lastCalledByEmail: 'rep2@solarithmdesign.com',
        lastCalledDate: '2026-11-01T10:00:00.000Z',
        interestedAt: '2026-11-01T10:00:00.000Z',
        callAttempts: 1,
      }),
    ];

    const scaleReport = computeOwnerAnalyticsPure(
      leadsForScale,
      thirtyTwoReps,
      { preset: 'LAST_7_DAYS' },
      nowIso
    );

    assert.ok(scaleReport.scorecardRows.length >= 32);

    // 1. Top 5 Performers mode MUST cap visibleRepSeries at 5 lines max (preventing spaghetti charts)
    const top5View = resolveFocusedOwnerChartViewPure(scaleReport, {
      focusMode: 'TOP_5',
      customSelectedEmails: [],
      isolatedRepEmail: null,
      leads: leadsForScale,
    });
    assert.equal(top5View.effectiveMode, 'TOP_5');
    assert.equal(top5View.visibleRepSeries.length, 5);

    // 2. Custom Compare mode isolates the checked 2 reps
    const customView = resolveFocusedOwnerChartViewPure(scaleReport, {
      focusMode: 'CUSTOM',
      customSelectedEmails: ['rep1@solarithmdesign.com', 'rep2@solarithmdesign.com'],
      isolatedRepEmail: null,
      leads: leadsForScale,
    });
    assert.equal(customView.effectiveMode, 'CUSTOM');
    assert.equal(customView.visibleRepSeries.length, 2);
    assert.equal(customView.focusedTotals.interestedGenerated, 2);
    assert.equal(customView.focusedTotals.convertedToClientsWon, 1);

    // 3. Click-to-Isolate from Scorecard Table isolates single rep against team average
    const isolatedView = resolveFocusedOwnerChartViewPure(scaleReport, {
      focusMode: 'TOP_5',
      customSelectedEmails: [],
      isolatedRepEmail: 'rep1@solarithmdesign.com',
      leads: leadsForScale,
    });
    assert.equal(isolatedView.effectiveMode, 'ISOLATED_REP');
    assert.equal(isolatedView.visibleRepSeries.length, 1);
    assert.equal(isolatedView.visibleRepSeries[0].repEmail, 'rep1@solarithmdesign.com');
    assert.equal(isolatedView.focusedTotals.convertedToClientsWon, 1);

    // 4. Scorecard search & column sorting
    const searched = filterAndSortScorecardRows(
      scaleReport.scorecardRows,
      'Sales Rep 02',
      'interestedGenerated',
      'desc'
    );
    assert.equal(searched.length, 1);
    assert.equal(searched[0].repEmail, 'rep2@solarithmdesign.com');
  });
});

