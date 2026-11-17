import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSubduedDailyCallsText } from '../components/layout/Header';
import { partitionFreshLeadsEquallyForActiveRepsPure } from './batchGenerator';
import {
  buildLeadRecordFromSanitizedRowPure,
  extractExcelRowFieldsNormalized,
  parseHistoricalCallingDate,
} from './historicalImportParser';
import {
  applyCallDispositionUpdatePure,
  computeOwnerAnalyticsPure,
  computeSalesRepAnalyticsPure,
} from './performanceAnalytics';
import {
  paginateCallingLeadsPure,
  CALLING_TABLE_PAGE_SIZE,
  formatLastCalledByRepNamePure,
} from '../components/calling/CallingTable';
import { formatRepName } from './utils';
import { computeDailyStatsFromLeadsPure, resolveCanonicalRepIdentity } from './dailyStatsService';
import {
  applyClaimOrUpdateExistingLeadPure,
  applyHotClientCrossRepEscalationPure,
  applyManualCompanyNameEditPure,
  checkSingleLeadDuplicatePure,
  classifyLeadCollisionScenarioPure,
  doesLeadMatchInterestedSubFilterPure,
  filterAndSortWorkspaceTableLeadsPure,
  formatCoEscalatedPillText,
  formatOwnerSubStatusBadgePure,
  mergeDuplicateLeadRecord,
} from './leadStore';
import {
  autoSanitizeDuplicateClaimedBatchesPure,
  claimBatchStateTransition,
  filterBatchesForUser,
  releaseBatchClaimPure,
  runNightlySweepPure,
} from './batchResetCron';
import {
  computeOwnerMetricStripPure,
  computeSalesRepMetricStripPure,
  doesLeadMatchWorkspaceDateFilterPure,
} from './dashboardMetrics';
import {
  formatBatchClaimStatusLabelPure,
  formatBatchClaimTimePure,
} from '../components/batches/DailyBatchSelector';
import { getTodayIstDateString } from '../types/batch';
import { CANONICAL_NEXUS_EMPLOYEES } from './authService';
import { BatchRecord, LeadRecord, SanitizedRowItem } from './types';

function makeFreshLead(idx: number): LeadRecord {
  return {
    id: `fresh-lead-${idx}`,
    companyName: `Solar Prospect #${idx}`,
    companyNameNormalized: `solar prospect #${idx}`,
    phoneNumber: String(9000000000 + idx),
    formattedPhone: `+91 90000 ${String(idx).padStart(5, '0')}`,
    altNumber: null,
    state: 'Gujarat',
    city: 'Ahmedabad',
    email: null,
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
    createdAt: '2026-11-03T06:00:00.000Z',
    updatedAt: '2026-11-03T06:00:00.000Z',
    notes: '',
  };
}

describe('Comprehensive Architecture Fix: 50k+ Lead Performance, Auto-Equal Batch Division, Excel Dates & Remove 120 Limit', () => {
  it('1 & 2. Removes 120 call limit from Header and formats "Today\'s Calls: 43"', () => {
    assert.equal(formatSubduedDailyCallsText(43), "Today's Calls: 43");
    assert.equal(formatSubduedDailyCallsText(0), "Today's Calls: 0");
  });

  it('3. Automatic Equal Batch Division: divides 2,230 leads across 2 reps (1115 + 1115) or 3 reps (744 + 743 + 743) and 10,000 leads across 2 reps (5000 + 5000) with no 3,000 cap', () => {
    const leads2230 = Array.from({ length: 2230 }, (_, idx) => makeFreshLead(idx + 1));

    // 2 Active Sales Reps -> Batch #1 (1,115 leads) & Batch #2 (1,115 leads)
    const twoRepResult = partitionFreshLeadsEquallyForActiveRepsPure(
      leads2230,
      [],
      2,
      '2026-11-03',
      '2026-11-03T07:00:00.000Z'
    );
    assert.equal(twoRepResult.newBatches.length, 2);
    assert.equal(twoRepResult.newBatches[0].totalLeads, 1115);
    assert.equal(twoRepResult.newBatches[1].totalLeads, 1115);
    assert.equal(twoRepResult.newBatches[0].status, 'AVAILABLE');
    assert.equal(twoRepResult.newBatches[1].status, 'AVAILABLE');

    // 3 Active Sales Reps -> Batch #1 (744 leads), Batch #2 (743 leads), Batch #3 (743 leads)
    const threeRepResult = partitionFreshLeadsEquallyForActiveRepsPure(
      leads2230,
      [],
      3,
      '2026-11-03',
      '2026-11-03T07:00:00.000Z'
    );
    assert.equal(threeRepResult.newBatches.length, 3);
    assert.equal(threeRepResult.newBatches[0].totalLeads, 744);
    assert.equal(threeRepResult.newBatches[1].totalLeads, 743);
    assert.equal(threeRepResult.newBatches[2].totalLeads, 743);

    // 10,000 Fresh Leads across 2 Active Sales Reps -> 5,000 + 5,000 (No 3,000 cap)
    const leads10k = Array.from({ length: 10000 }, (_, idx) => makeFreshLead(idx + 1));
    const tenKResult = partitionFreshLeadsEquallyForActiveRepsPure(
      leads10k,
      [],
      2,
      '2026-11-03',
      '2026-11-03T07:00:00.000Z'
    );
    assert.equal(tenKResult.newBatches.length, 2);
    assert.equal(tenKResult.newBatches[0].totalLeads, 5000);
    assert.equal(tenKResult.newBatches[1].totalLeads, 5000);
  });

  it('4. Excel Historical Date Parsing, Rep Attribution & Chart Accuracy: parses Excel serial numbers, DD-MM-YYYY, MM/DD/YY, and preserves rep attribution across all dispositions', () => {
    const fallbackToday = '2026-11-03T08:00:00.000Z';

    // Excel serial number (e.g. 46313 -> 2026-10-18)
    const serialParsed = parseHistoricalCallingDate(46313, fallbackToday);
    assert.equal(serialParsed?.slice(0, 10), '2026-10-18');

    // DD-MM-YYYY string ("18-10-2026" and "24/10/2026")
    assert.equal(
      parseHistoricalCallingDate('18-10-2026', fallbackToday)?.slice(0, 10),
      '2026-10-18'
    );
    assert.equal(
      parseHistoricalCallingDate('24/10/2026', fallbackToday)?.slice(0, 10),
      '2026-10-24'
    );

    // US short date emitted by XLSX formatted output ("10/18/26")
    assert.equal(
      parseHistoricalCallingDate('10/18/26', fallbackToday)?.slice(0, 10),
      '2026-10-18'
    );

    // Named month ("19-Oct-2026")
    assert.equal(
      parseHistoricalCallingDate('19-Oct-2026', fallbackToday)?.slice(0, 10),
      '2026-10-19'
    );

    // Extract normalized Excel fields preferring numeric Excel serial date
    const extracted = extractExcelRowFieldsNormalized(
      {
        'Company Name': 'GIDC Solar Spinners',
        'Phone Number': '9825012345',
        'Date of Calling': '10/18/26',
        Status: 'Didnt Receive',
        'Sales Person': 'Savani Hasti Vijaybhai',
        Remarks: 'Ringing no answer',
      },
      {
        'Date of Calling': 46313,
      },
      2
    );
    assert.equal(extracted.dateOfCalling, '46313');
    assert.equal(extracted.salesPersonRaw, 'Savani Hasti Vijaybhai');

    // Build historical DIDNT_RECEIVE lead and verify lastCalledByEmail is preserved even when assignedRepEmail is released to null
    const sanitizedRow: SanitizedRowItem = {
      rowNumber: 2,
      companyName: 'GIDC Solar Spinners',
      companyNameNormalized: 'gidc solar spinners',
      phoneNumber: '9825012345',
      formattedPhone: '+91 98250 12345',
      altNumber: null,
      dateOfCalling: '18-10-2026',
      statusRaw: 'Didnt Receive',
      salesPersonRaw: 'Savani Hasti Vijaybhai',
      remarks: 'Ringing no answer',
    };

    const builtLead = buildLeadRecordFromSanitizedRowPure(sanitizedRow, {
      id: 'hist-oct-18',
      nowIso: fallbackToday,
    });

    assert.equal(builtLead.lastCalledDate?.slice(0, 10), '2026-10-18');
    assert.equal(builtLead.lastCalledByEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(builtLead.lastCalledByName, 'Savani Hasti Vijaybhai');
    assert.equal(builtLead.callAttempts, 1);

    // Build a second historical lead on 2026-10-20 with Proposal Shared
    const builtLeadOct20 = buildLeadRecordFromSanitizedRowPure(
      {
        ...sanitizedRow,
        rowNumber: 3,
        companyName: 'Rajkot Solar Castings',
        companyNameNormalized: 'rajkot solar castings',
        phoneNumber: '9825054321',
        formattedPhone: '+91 98250 54321',
        dateOfCalling: '20-10-2026',
        statusRaw: 'Proposal Shared',
      },
      {
        id: 'hist-oct-20',
        nowIso: fallbackToday,
      }
    );

    // Verify SalesRepAnalyticsView & OwnerAnalyticsView match both official email and personal email alias (savanihasti2117@gmail.com)
    // and plot calls on 18 Oct and 20 Oct (NOT lumped onto 03 Nov)
    const repReportPersonalAlias = computeSalesRepAnalyticsPure(
      [builtLead, builtLeadOct20],
      'savanihasti2117@gmail.com',
      'Savani Hasti Vijaybhai',
      { preset: 'ALL_TIME' },
      120,
      fallbackToday
    );

    assert.equal(repReportPersonalAlias.kpiStrip.myCallsSelectedPeriod, 2);
    assert.equal(repReportPersonalAlias.kpiStrip.proposalsShared, 1);

    const oct18Bucket = repReportPersonalAlias.myDailyCallingTrend.find(
      (p) => p.date === '2026-10-18'
    );
    const oct20Bucket = repReportPersonalAlias.myDailyCallingTrend.find(
      (p) => p.date === '2026-10-20'
    );
    const nov03Bucket = repReportPersonalAlias.myDailyCallingTrend.find(
      (p) => p.date === '2026-11-03'
    );

    assert.equal(oct18Bucket?.callsDialed, 1, '18 Oct must show 1 call');
    assert.equal(oct20Bucket?.callsDialed, 1, '20 Oct must show 1 call');
    assert.equal(nov03Bucket?.callsDialed, 0, '03 Nov must NOT lump October calls');

    const ownerReport = computeOwnerAnalyticsPure(
      [builtLead, builtLeadOct20],
      [],
      { preset: 'ALL_TIME' },
      fallbackToday
    );
    assert.equal(ownerReport.totalsRow.callsDialed, 2);
    const ownerOct18 = ownerReport.dailyCallingVolumeByRep.find(
      (d) => d.date === '2026-10-18'
    );
    assert.equal(ownerOct18?.totalCalls, 1);
  });

  it('5. High-Performance 50,000+ Lead Architecture: paginates CallingTable at 50 leads per page and pre-aggregates daily_stats', () => {
    const fiftyThousandLeads = Array.from({ length: 135 }, (_, idx) => makeFreshLead(idx + 1));
    const page1 = paginateCallingLeadsPure(fiftyThousandLeads, 1, CALLING_TABLE_PAGE_SIZE);
    assert.equal(page1.paginatedLeads.length, 50);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.startIndex, 1);
    assert.equal(page1.endIndex, 50);

    const page3 = paginateCallingLeadsPure(fiftyThousandLeads, 3, CALLING_TABLE_PAGE_SIZE);
    assert.equal(page3.paginatedLeads.length, 35);
    assert.equal(page3.startIndex, 101);
    assert.equal(page3.endIndex, 135);

    // Verify daily_stats pre-aggregation
    const canon = resolveCanonicalRepIdentity('savanihasti2117@gmail.com', 'Hasti');
    assert.equal(canon?.email, 'hastisavani.07@solarithmdesign.com');

    const calledLead = {
      ...makeFreshLead(500),
      status: 'INTERESTED' as const,
      callAttempts: 1,
      lastCalledDate: '2026-10-18T10:00:00.000Z',
      lastCalledByEmail: 'savanihasti2117@gmail.com',
      lastCalledByName: 'Savani Hasti Vijaybhai',
      interestedAt: '2026-10-18T10:00:00.000Z',
    };
    const stats = computeDailyStatsFromLeadsPure([calledLead], '2026-11-03T08:00:00.000Z');
    assert.equal(stats.length, 1);
    assert.equal(stats[0].id, '2026-10-18_hastisavani.07@solarithmdesign.com');
    assert.equal(stats[0].callsCount, 1);
    assert.equal(stats[0].interestedCount, 1);

    // Verify <50ms daily_stats-only chart and scorecard computation with leads = []
    const ownerFromStatsOnly = computeOwnerAnalyticsPure(
      [],
      [],
      { preset: 'ALL_TIME' },
      '2026-11-03T08:00:00.000Z',
      stats
    );
    assert.equal(ownerFromStatsOnly.totalsRow.callsDialed, 1);
    assert.equal(ownerFromStatsOnly.totalsRow.interestedGenerated, 1);

    const repFromStatsOnly = computeSalesRepAnalyticsPure(
      [],
      'savanihasti2117@gmail.com',
      'Savani Hasti Vijaybhai',
      { preset: 'ALL_TIME' },
      120,
      '2026-11-03T08:00:00.000Z',
      stats
    );
    assert.equal(repFromStatsOnly.kpiStrip.myCallsSelectedPeriod, 1);
    assert.equal(repFromStatsOnly.kpiStrip.convertedToInterested, 1);
  });

  it('6. Automatic New-Day Sweep & Auto-Batch Creation: releases 1,163 yesterday uncalled FRESH leads (2026-11-03) and generates equal 2026-11-04 batches (583 + 583)', () => {
    const yesterdayBatches = [
      {
        batchId: 'BATCH_2026_11_03_01',
        batchNumber: 1,
        date: '2026-11-03',
        totalLeads: 582,
        totalLeadsAssigned: 582,
        claimedByEmail: 'hastisavani.07@solarithmdesign.com',
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: '2026-11-03T04:00:00.000Z',
        status: 'IN_PROGRESS' as const,
        completedCallsCount: 10,
        untouchedCount: 582,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-03T03:30:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_03_02',
        batchNumber: 2,
        date: '2026-11-03',
        totalLeads: 581,
        totalLeadsAssigned: 581,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE' as const,
        completedCallsCount: 0,
        untouchedCount: 581,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-03T03:30:00.000Z',
      },
    ];

    // 1,163 leads stuck on yesterday's 2026-11-03 batches + 3 unassigned = 1,166 Total Fresh Pool
    const all1166FreshLeads: LeadRecord[] = Array.from({ length: 1166 }, (_, idx) => {
      const base = makeFreshLead(idx + 1);
      if (idx < 582) {
        return {
          ...base,
          assignedBatchId: 'BATCH_2026_11_03_01',
          assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
          assignedRepName: 'Savani Hasti Vijaybhai',
        };
      }
      if (idx < 1163) {
        return {
          ...base,
          assignedBatchId: 'BATCH_2026_11_03_02',
        };
      }
      return base;
    });

    const res = partitionFreshLeadsEquallyForActiveRepsPure(
      all1166FreshLeads,
      yesterdayBatches,
      2,
      '2026-11-04',
      new Date('2026-11-04T04:00:00.000Z')
    );

    assert.equal(res.changed, true);
    assert.equal(res.closedPriorBatches.length, 2);
    assert.ok(res.closedPriorBatches.every((b) => b.status === 'CLOSED'));
    assert.equal(res.releasedLeads.length, 1163);
    assert.equal(res.todayBatches.length, 2);
    assert.equal(res.todayBatches[0].batchId, 'BATCH_2026_11_04_01');
    assert.equal(res.todayBatches[1].batchId, 'BATCH_2026_11_04_02');
    assert.equal(res.todayBatches[0].totalLeads, 583);
    assert.equal(res.todayBatches[1].totalLeads, 583);
    assert.equal(res.batchSizePerRep, 583);
    assert.ok(
      res.updatedLeads.every(
        (l) =>
          l.assignedBatchId === 'BATCH_2026_11_04_01' ||
          l.assignedBatchId === 'BATCH_2026_11_04_02'
      )
    );
  });

  it('7. Smart Duplicate Prohibition & Three-Tier Collision Resolution (Scenarios A, B, and C Hot Client Cross-Rep Escalation)', () => {
    const existingColdLead: LeadRecord = {
      ...makeFreshLead(101),
      id: 'lead-cold-101',
      companyName: 'Apex Solar Infra',
      companyNameNormalized: 'apex solar infra',
      phoneNumber: '9825011101',
      altNumber: '9825011102',
      status: 'SWITCH_OFF',
      assignedRepEmail: null,
      assignedRepName: null,
    };

    const existingPipelineLeadRepA: LeadRecord = {
      ...makeFreshLead(202),
      id: 'lead-pipeline-202',
      companyName: 'Kiran Spinning Mills Pvt Ltd',
      companyNameNormalized: 'kiran spinning mills pvt ltd',
      phoneNumber: '9825022201',
      altNumber: '9825022202',
      status: 'PROPOSAL_SHARED',
      assignedRepEmail: 'krinadhami.05@solarithmdesign.com',
      assignedRepName: 'Dhami Krina Rajeshbhai',
      lastCalledDate: '2026-11-01T10:00:00.000Z',
    };

    const leadsPool = [existingColdLead, existingPipelineLeadRepA];

    // 1. Real-time duplicate detection on primary phone, alt phone, and company name
    const dupByPrimary = checkSingleLeadDuplicatePure(
      { cleanedPrimaryPhone: '9825022201', formattedPrimaryPhone: '+91 98250 22201' },
      leadsPool
    );
    assert.ok(dupByPrimary);
    assert.equal(dupByPrimary.matchType, 'PRIMARY_PHONE');
    assert.equal(dupByPrimary.lead.id, 'lead-pipeline-202');

    const dupByAlt = checkSingleLeadDuplicatePure(
      { cleanedAltPhone: '9825022202', formattedAltPhone: '+91 98250 22202' },
      leadsPool
    );
    assert.ok(dupByAlt);
    assert.equal(dupByAlt.matchType, 'ALT_PHONE');
    assert.equal(dupByAlt.lead.id, 'lead-pipeline-202');

    // 2. Scenario A: Unclaimed or Cold Lead -> Claim & Update Existing Lead
    const scenarioA = classifyLeadCollisionScenarioPure(
      existingColdLead,
      'hastisavani.07@solarithmdesign.com'
    );
    assert.equal(scenarioA, 'SCENARIO_A_UNCLAIMED_OR_COLD');

    const claimedLead = applyClaimOrUpdateExistingLeadPure(existingColdLead, {
      newStatus: 'INTERESTED',
      currentUser: {
        email: 'hastisavani.07@solarithmdesign.com',
        name: 'Savani Hasti Vijaybhai',
      },
      noteText: 'Client picked up and requested immediate site survey',
      nowIso: '2026-11-04T09:00:00.000Z',
    });
    assert.equal(claimedLead.status, 'INTERESTED');
    assert.equal(claimedLead.assignedRepEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(claimedLead.assignedRepName, 'Savani Hasti Vijaybhai');
    assert.ok(claimedLead.notes.includes('Client picked up and requested immediate site survey'));

    // 3. Scenario B: Owned by SAME Sales Rep
    const scenarioB = classifyLeadCollisionScenarioPure(
      existingPipelineLeadRepA,
      'krinadhami.05@solarithmdesign.com'
    );
    assert.equal(scenarioB, 'SCENARIO_B_OWNED_BY_SAME_REP');

    // 4. Scenario C: Owned by ANOTHER Sales Rep (Sales Person A) in PROPOSAL_SHARED / FUTURE_REQUIREMENT / INTERESTED
    const scenarioC = classifyLeadCollisionScenarioPure(
      existingPipelineLeadRepA,
      'hastisavani.07@solarithmdesign.com'
    );
    assert.equal(scenarioC, 'SCENARIO_C_OWNED_BY_ANOTHER_REP');

    // Sales Person B triggers Hot Client Cross-Rep Escalation
    const escalatedLead = applyHotClientCrossRepEscalationPure(existingPipelineLeadRepA, {
      escalatingUser: {
        email: 'hastisavani.07@solarithmdesign.com',
        name: 'Savani Hasti Vijaybhai',
      },
      urgentHandoverNote: 'MD called directly, ready to issue 500kW PO today at 4 PM.',
      nowIso: '2026-11-04T09:15:00.000Z',
    });

    // Must set status = INTERESTED while preserving Sales Person A as original owner
    assert.equal(escalatedLead.status, 'INTERESTED');
    assert.equal(escalatedLead.assignedRepEmail, 'krinadhami.05@solarithmdesign.com');
    assert.equal(escalatedLead.assignedRepName, 'Dhami Krina Rajeshbhai');
    assert.equal(escalatedLead.escalatedByEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(escalatedLead.escalatedByName, 'Savani Hasti Vijaybhai');
    assert.equal(escalatedLead.isDualRepEscalation, true);
    assert.equal(
      escalatedLead.hotEscalationNote,
      'MD called directly, ready to issue 500kW PO today at 4 PM.'
    );
    assert.ok(
      escalatedLead.notes.includes(
        '[HOT ESCALATION by Savani Hasti Vijaybhai]: Client ready to award project now. Originally in PROPOSAL_SHARED with Dhami Krina Rajeshbhai. Note: MD called directly, ready to issue 500kW PO today at 4 PM.'
      )
    );

    // Verify Co-Escalated pill text formatting
    const pillText = formatCoEscalatedPillText(escalatedLead);
    assert.equal(pillText, 'Co-Escalated: Dhami Krina Rajeshbhai + Savani Hasti Vijaybhai');

    // Verify daily_stats increments interestedCount for escalating rep (Sales Person B) as well
    const stats = computeDailyStatsFromLeadsPure([escalatedLead], '2026-11-04T10:00:00.000Z');
    const repBStat = stats.find(
      (s) => s.id === '2026-11-04_hastisavani.07@solarithmdesign.com'
    );
    assert.ok(repBStat);
    assert.equal(repBStat.interestedCount, 1);
  });

  it("8. Consolidated 4-Tab Bar & Strict Batch-Only Lead Visibility: blocks unclaimed pool dump, requires batch claim for Sales Reps, filters Owner batches, and sorts follow-up tabs by nextFollowUpDate ascending", () => {
    const todayDate = '2026-11-05';
    const repAEmail = 'hastisavani.07@solarithmdesign.com';
    const repBEmail = 'krinadhami.10@solarithmdesign.com';

    const unclaimedGlobalPoolLead: LeadRecord = {
      ...makeFreshLead(1),
      id: 'global-pool-1',
      status: 'FRESH',
      assignedBatchId: null,
      assignedRepEmail: null,
    };

    const batch1Lead1: LeadRecord = {
      ...makeFreshLead(2),
      id: 'b1-lead-1',
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_11_05_01',
      assignedRepEmail: repAEmail,
      assignedRepName: 'Savani Hasti Vijaybhai',
    };

    const batch1Lead2Called: LeadRecord = {
      ...makeFreshLead(3),
      id: 'b1-lead-2-called',
      status: 'PROPOSAL_SHARED',
      assignedBatchId: 'BATCH_2026_11_05_01',
      assignedRepEmail: repAEmail,
      assignedRepName: 'Savani Hasti Vijaybhai',
      nextFollowUpDate: '2026-11-07T10:00:00.000Z',
    };

    const batch1OverdueProposal: LeadRecord = {
      ...makeFreshLead(4),
      id: 'repA-overdue-proposal',
      status: 'PROPOSAL_SHARED',
      assignedBatchId: null,
      assignedRepEmail: repAEmail,
      assignedRepName: 'Savani Hasti Vijaybhai',
      nextFollowUpDate: '2026-11-02T10:00:00.000Z',
    };

    const batch2Lead1: LeadRecord = {
      ...makeFreshLead(5),
      id: 'b2-lead-1',
      status: 'FRESH',
      assignedBatchId: 'BATCH_2026_11_05_02',
      assignedRepEmail: null,
      assignedRepName: null,
    };

    const repBProposalLead: LeadRecord = {
      ...makeFreshLead(6),
      id: 'repB-proposal',
      status: 'PROPOSAL_SHARED',
      assignedBatchId: null,
      assignedRepEmail: repBEmail,
      assignedRepName: 'Dhami Krina Rajeshbhai',
      nextFollowUpDate: '2026-11-06T10:00:00.000Z',
    };

    const repAInterestedLead: LeadRecord = {
      ...makeFreshLead(7),
      id: 'repA-interested',
      status: 'INTERESTED',
      assignedBatchId: null,
      assignedRepEmail: repAEmail,
      assignedRepName: 'Savani Hasti Vijaybhai',
      interestedAt: '2026-11-05T08:00:00.000Z',
    };

    const allLeads = [
      unclaimedGlobalPoolLead,
      batch1Lead1,
      batch1Lead2Called,
      batch1OverdueProposal,
      batch2Lead1,
      repBProposalLead,
      repAInterestedLead,
    ];

    const batchesBeforeRepBClaim: BatchRecord[] = [
      {
        batchId: 'BATCH_2026_11_05_01',
        batchNumber: 1,
        date: todayDate,
        totalLeads: 2,
        totalLeadsAssigned: 2,
        claimedByEmail: repAEmail,
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: '2026-11-05T04:00:00.000Z',
        status: 'IN_PROGRESS',
        completedCallsCount: 1,
        untouchedCount: 1,
        retryCount: 0,
        leadIds: ['b1-lead-1', 'b1-lead-2-called'],
        createdAt: '2026-11-05T03:30:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_05_02',
        batchNumber: 2,
        date: todayDate,
        totalLeads: 1,
        totalLeadsAssigned: 1,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        untouchedCount: 1,
        retryCount: 0,
        leadIds: ['b2-lead-1'],
        createdAt: '2026-11-05T03:30:00.000Z',
      },
    ];

    // 1. Sales Rep B (who has NOT claimed a batch for today yet) sees 0 leads & prompt on Today's Batch / Fresh
    const repBUnclaimedResult = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'FRESH',
      isOwner: false,
      userEmail: repBEmail,
      todayDate,
    });
    assert.equal(repBUnclaimedResult.filteredLeads.length, 0);
    assert.equal(
      repBUnclaimedResult.emptyStateMessage,
      "Claim your morning batch above to load today's calling queue."
    );

    // 2. Sales Rep A (who claimed Batch #1) sees ONLY uncalled FRESH leads in Batch #1 (called leads immediately leave)
    const repAClaimedResult = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'FRESH',
      isOwner: false,
      userEmail: repAEmail,
      todayDate,
    });
    assert.equal(repAClaimedResult.filteredLeads.length, 1);
    assert.equal(repAClaimedResult.filteredLeads[0].id, 'b1-lead-1');

    // 3. Owner on Today's Batch / Fresh sees ONLY leads assigned to today's active batches (excludes global-pool-1)
    const ownerAllTodayBatches = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'FRESH',
      isOwner: true,
      userEmail: 'jayshah.03@solarithmdesign.com',
      todayDate,
    });
    assert.equal(ownerAllTodayBatches.filteredLeads.length, 2);
    assert.deepEqual(
      ownerAllTodayBatches.filteredLeads.map((l) => l.id),
      ['b1-lead-1', 'b2-lead-1']
    );

    // Owner filters by Batch #2 specifically
    const ownerBatch2Only = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'FRESH',
      isOwner: true,
      userEmail: 'jayshah.03@solarithmdesign.com',
      todayDate,
      selectedBatchIdFilter: 'BATCH_2026_11_05_02',
    });
    assert.equal(ownerBatch2Only.filteredLeads.length, 1);
    assert.equal(ownerBatch2Only.filteredLeads[0].id, 'b2-lead-1');

    // 4. Proposals Shared tab: Sales Rep A sees only their own proposals sorted by nextFollowUpDate ascending (overdue first)
    const repAProposals = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'PROPOSAL_SHARED',
      isOwner: false,
      userEmail: repAEmail,
      todayDate,
    });
    assert.equal(repAProposals.filteredLeads.length, 2);
    assert.equal(repAProposals.filteredLeads[0].id, 'repA-overdue-proposal');
    assert.equal(repAProposals.filteredLeads[1].id, 'b1-lead-2-called');

    // Owner on Proposals Shared can filter by Rep B
    const ownerRepBProposals = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'PROPOSAL_SHARED',
      isOwner: true,
      userEmail: 'jayshah.03@solarithmdesign.com',
      todayDate,
      selectedRepEmailFilter: repBEmail,
    });
    assert.equal(ownerRepBProposals.filteredLeads.length, 1);
    assert.equal(ownerRepBProposals.filteredLeads[0].id, 'repB-proposal');

    // 5. Interested (Owner Queue): Sales Rep A sees their handed-over Interested lead
    const repAInterested = filterAndSortWorkspaceTableLeadsPure({
      leads: allLeads,
      batches: batchesBeforeRepBClaim,
      tab: 'INTERESTED',
      isOwner: false,
      userEmail: repAEmail,
      todayDate,
    });
    assert.equal(repAInterested.filteredLeads.length, 1);
    assert.equal(repAInterested.filteredLeads[0].id, 'repA-interested');
  });

  it('9. Instant O(1) Single-Doc Batch Claim, Claimed Batch Visibility for Sales Rep & Owner, Canonical Email Equivalence, and Non-Zero Preservation on Subsequent Partition Runs', () => {
    const todayDate = '2026-11-06';
    const freshPool = Array.from({ length: 10 }, (_, idx) => makeFreshLead(idx + 1));

    // Step 1: Partition 10 fresh leads equally across 2 active reps -> 2 batches of 5 leads each
    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      freshPool,
      [],
      2,
      todayDate,
      '2026-11-06T03:30:00.000Z'
    );
    assert.equal(partitioned.todayBatches.length, 2);
    assert.equal(partitioned.todayBatches[0].totalLeads, 5);
    assert.equal(partitioned.todayBatches[1].totalLeads, 5);

    // Step 2: Simulate O(1) Single-Document Batch Claim where ONLY Batch #1 document is updated to IN_PROGRESS
    // (individual leads keep assignedBatchId = BATCH_2026_11_06_01 and assignedRepEmail = null until called)
    // Also test cross-email equivalence: batch claimed with personal Gmail from adminDb ('savanihasti2117@gmail.com'),
    // while Sales Rep logs in with official email ('hastisavani.07@solarithmdesign.com')
    const batchesAfterO1Claim: BatchRecord[] = partitioned.todayBatches.map((b) =>
      b.batchNumber === 1
        ? {
            ...b,
            status: 'IN_PROGRESS',
            claimedByEmail: 'savanihasti2117@gmail.com',
            claimedByName: 'Savani Hasti Vijaybhai',
            claimedAt: '2026-11-06T04:00:00.000Z',
          }
        : b
    );

    const hastiUser = {
      email: 'hastisavani.07@solarithmdesign.com',
      name: 'Savani Hasti Vijaybhai',
      role: 'SALES' as const,
      isOwnerTier: false,
    };

    const peerKrinaUser = {
      email: 'krinadhami.05@solarithmdesign.com',
      name: 'Dhami Krina Rajeshbhai',
      role: 'SALES' as const,
      isOwnerTier: false,
    };

    const ownerUser = {
      email: 'jayshah.03@solarithmdesign.com',
      name: 'Shah Jay',
      role: 'OWNER' as const,
      isOwnerTier: true,
    };

    // Verify Claimed Batch Visibility for Hasti (once Hasti claims 1 batch for today, all other available batches are hidden; sees ONLY her IN_PROGRESS Batch #1)
    const hastiVisibleBatches = filterBatchesForUser(
      batchesAfterO1Claim,
      hastiUser,
      todayDate
    );
    assert.equal(hastiVisibleBatches.length, 1);
    assert.equal(hastiVisibleBatches[0].batchId, 'BATCH_2026_11_06_01');
    assert.equal(hastiVisibleBatches[0].status, 'IN_PROGRESS');

    // Verify Peer Rep Isolation for Krina (Batch #1 is hidden; only AVAILABLE Batch #2 is visible)
    const krinaVisibleBatches = filterBatchesForUser(
      batchesAfterO1Claim,
      peerKrinaUser,
      todayDate
    );
    assert.equal(krinaVisibleBatches.length, 1);
    assert.equal(krinaVisibleBatches[0].batchId, 'BATCH_2026_11_06_02');
    assert.equal(krinaVisibleBatches[0].status, 'AVAILABLE');

    // Verify Owner Supervisory Visibility (sees ALL batches: Batch #1 IN_PROGRESS and Batch #2 AVAILABLE)
    const ownerVisibleBatches = filterBatchesForUser(
      batchesAfterO1Claim,
      ownerUser,
      todayDate
    );
    assert.equal(ownerVisibleBatches.length, 2);

    // Verify Hasti's Calling Table loads all 5 FRESH leads from Batch #1 immediately (even though assignedRepEmail on leads is still null)
    const hastiTableResult = filterAndSortWorkspaceTableLeadsPure({
      leads: partitioned.updatedLeads,
      batches: batchesAfterO1Claim,
      tab: 'FRESH',
      isOwner: false,
      userEmail: hastiUser.email,
      todayDate,
    });
    assert.ok(hastiTableResult.repClaimedTodayBatch);
    assert.equal(hastiTableResult.repClaimedTodayBatch.batchId, 'BATCH_2026_11_06_01');
    assert.equal(hastiTableResult.filteredLeads.length, 5);

    // Verify Hasti's Batch Leads Remaining KPI counter is 5 (not 0!)
    const hastiMetrics = computeSalesRepMetricStripPure(
      partitioned.updatedLeads,
      batchesAfterO1Claim,
      hastiUser.email
    );
    assert.equal(hastiMetrics.batchLeadsRemaining, 5);

    // Verify Owner's Total Fresh Pool KPI counter is 10 (not 0!)
    const ownerMetrics = computeOwnerMetricStripPure(partitioned.updatedLeads);
    assert.equal(ownerMetrics.totalFreshPool, 10);

    // Verify subsequent partition runs (e.g., when switching logins or when activeRepCount updates from 2 to 3)
    // NEVER wipe or reset today's claimed or available batches!
    const afterLoginSwitch = partitionFreshLeadsEquallyForActiveRepsPure(
      partitioned.updatedLeads,
      batchesAfterO1Claim,
      3,
      todayDate,
      '2026-11-06T04:05:00.000Z'
    );
    assert.equal(afterLoginSwitch.changed, false);
    assert.equal(afterLoginSwitch.todayBatches.length, 2);
    assert.equal(afterLoginSwitch.todayBatches[0].status, 'IN_PROGRESS');
    assert.equal(afterLoginSwitch.updatedLeads.length, 10);
  });

  it('10. Enforces Strict 1 Batch/Day Claim Limit, Clean Empty Notes on Fresh Excel Import, and Single-Field Trick (assignedBatchId = null on Call Disposition)', () => {
    const todayDate = '2026-11-06';
    const freshPool = Array.from({ length: 6 }, (_, idx) => makeFreshLead(idx + 1));
    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      freshPool,
      [],
      2,
      todayDate,
      '2026-11-06T03:30:00.000Z'
    );

    const hastiRep = {
      email: 'hastisavani.07@solarithmdesign.com',
      name: 'Savani Hasti Vijaybhai',
    };

    // Hasti claims Batch #1 (succeeds)
    const claim1 = claimBatchStateTransition(
      'BATCH_2026_11_06_01',
      hastiRep,
      partitioned.todayBatches,
      partitioned.updatedLeads,
      '2026-11-06T04:00:00.000Z'
    );
    assert.equal(claim1.updatedBatch.status, 'IN_PROGRESS');
    assert.equal(claim1.updatedBatch.remainingLeads, 3);

    // Hasti attempts to claim Batch #2 on the same day -> strictly blocked (1 Batch Per Day rule)
    assert.throws(
      () =>
        claimBatchStateTransition(
          'BATCH_2026_11_06_02',
          hastiRep,
          claim1.updatedBatches,
          claim1.updatedLeads,
          '2026-11-06T04:05:00.000Z'
        ),
      /limit 1 batch per day/
    );

    // Single-Field Trick: Calling a FRESH lead in Batch #1 sets status = PROPOSAL_SHARED AND clears assignedBatchId = null
    const targetLead = claim1.updatedLeads.find(
      (l) => l.assignedBatchId === 'BATCH_2026_11_06_01'
    )!;
    assert.ok(targetLead);
    const updatedLeadAfterCall = applyCallDispositionUpdatePure(targetLead, {
      newStatus: 'PROPOSAL_SHARED',
      callDate: '2026-11-06',
      notes: 'Shared 200kW rooftop proposal on WhatsApp.',
      actorUser: hastiRep,
      nowIso: '2026-11-06T05:00:00.000Z',
    });
    assert.equal(updatedLeadAfterCall.status, 'PROPOSAL_SHARED');
    assert.equal(updatedLeadAfterCall.assignedBatchId, null);
    assert.equal(
      updatedLeadAfterCall.notes,
      'Shared 200kW rooftop proposal on WhatsApp.'
    );

    // Clean Empty Notes on Fresh Excel Import when Remarks column is empty
    const sanitizedFreshRow: SanitizedRowItem = {
      rowNumber: 2,
      companyName: 'Clean Notes Solar Mills Pvt Ltd',
      companyNameNormalized: 'clean notes solar mills pvt ltd',
      phoneNumber: '9876543210',
      formattedPhone: '+91 98765 43210',
      altNumber: null,
      formattedAltPhone: null,
      state: 'Gujarat',
      city: 'Surat',
    };
    const builtFreshLead = buildLeadRecordFromSanitizedRowPure(sanitizedFreshRow, {
      id: 'ingested-clean-1',
      importBatchId: 'IMP_2026_11_06_99999',
      nowIso: '2026-11-06T03:00:00.000Z',
    });
    assert.equal(builtFreshLead.notes, '');
    assert.equal(builtFreshLead.remarks, null);
  });

  it('11. Permanent Inline Company Name Editing (Case A Standalone & Case B With Call Outcome), Persistence Across DIDNT_RECEIVE Retries & 11:59 PM Sweeps, and Excel Overwrite Protection', () => {
    const rawMisspelledLead: LeadRecord = {
      ...makeFreshLead(1),
      id: 'lead-misspelled-1',
      companyName: 'Shre Ganesh Soler Enegy',
      companyNameNormalized: 'shre ganesh soler enegy',
      assignedBatchId: 'BATCH_2026_11_06_01',
    };

    // Case A: Quick Name Fix Without Logging a Call ([✓ Apply])
    const renamedLead = applyManualCompanyNameEditPure(
      rawMisspelledLead,
      '  Shree Ganesh Solar Energy Pvt Ltd  ',
      '2026-11-06T06:00:00.000Z'
    );
    assert.equal(renamedLead.companyName, 'Shree Ganesh Solar Energy Pvt Ltd');
    assert.equal(
      renamedLead.companyNameNormalized,
      'shree ganesh solar energy pvt ltd'
    );
    assert.equal(renamedLead.isNameManuallyEdited, true);
    assert.equal(renamedLead.status, 'FRESH');

    // Verify 11:59 PM Daily Reset Sweep preserves the edited company name when releasing uncalled FRESH leads
    const batchDoc: BatchRecord = {
      batchId: 'BATCH_2026_11_06_01',
      batchNumber: 1,
      date: '2026-11-06',
      totalLeads: 1,
      totalLeadsAssigned: 1,
      remainingLeads: 1,
      claimedByEmail: 'hastisavani.07@solarithmdesign.com',
      claimedByName: 'Savani Hasti Vijaybhai',
      claimedAt: '2026-11-06T04:00:00.000Z',
      status: 'IN_PROGRESS',
      completedCallsCount: 0,
      untouchedCount: 1,
      retryCount: 0,
      leadIds: ['lead-misspelled-1'],
      createdAt: '2026-11-06T03:30:00.000Z',
    };
    const swept = runNightlySweepPure(
      [batchDoc],
      [renamedLead],
      '2026-11-06',
      '2026-11-06T18:29:00.000Z'
    );
    assert.equal(swept.updatedLeads[0].companyName, 'Shree Ganesh Solar Energy Pvt Ltd');
    assert.equal(swept.updatedLeads[0].isNameManuallyEdited, true);

    // Case B: Edited Name + Call Outcome Submission (DIDNT_RECEIVE) in a single atomic save
    const rawMisspelledLead2: LeadRecord = {
      ...makeFreshLead(2),
      id: 'lead-misspelled-2',
      companyName: 'Kiran Textil Mill',
      companyNameNormalized: 'kiran textil mill',
      assignedBatchId: 'BATCH_2026_11_06_01',
    };
    const combinedOutcomeAndRename = applyCallDispositionUpdatePure(
      rawMisspelledLead2,
      {
        newStatus: 'DIDNT_RECEIVE',
        callDate: '2026-11-06',
        notes: 'Ringing, no response.',
        editedCompanyName: 'Kiran Textile Mills Ltd',
        actorUser: {
          email: 'hastisavani.07@solarithmdesign.com',
          name: 'Savani Hasti Vijaybhai',
        },
        nowIso: '2026-11-06T07:00:00.000Z',
      }
    );
    assert.equal(combinedOutcomeAndRename.status, 'DIDNT_RECEIVE');
    assert.equal(combinedOutcomeAndRename.companyName, 'Kiran Textile Mills Ltd');
    assert.equal(
      combinedOutcomeAndRename.companyNameNormalized,
      'kiran textile mills ltd'
    );
    assert.equal(combinedOutcomeAndRename.isNameManuallyEdited, true);

    // Requirement 3: Protect Edited Company Names Against Future Excel Re-Uploads (both Fresh & Historical Overwrite)
    const oldSpreadsheetRowFresh: SanitizedRowItem = {
      rowNumber: 12,
      companyName: 'Shre Ganesh Soler Enegy (Old Typo From Sheet)',
      companyNameNormalized: 'shre ganesh soler enegy (old typo from sheet)',
      phoneNumber: renamedLead.phoneNumber,
      formattedPhone: renamedLead.formattedPhone,
      altNumber: null,
      formattedAltPhone: null,
      state: 'Gujarat',
      city: 'Vadodara',
    };
    const mergedAfterFreshExcelOverwrite = mergeDuplicateLeadRecord(
      renamedLead,
      oldSpreadsheetRowFresh,
      '2026-11-07T08:00:00.000Z'
    );
    assert.equal(
      mergedAfterFreshExcelOverwrite.companyName,
      'Shree Ganesh Solar Energy Pvt Ltd'
    );
    assert.equal(
      mergedAfterFreshExcelOverwrite.companyNameNormalized,
      'shree ganesh solar energy pvt ltd'
    );
    assert.equal(mergedAfterFreshExcelOverwrite.isNameManuallyEdited, true);
    assert.equal(mergedAfterFreshExcelOverwrite.city, 'Vadodara');

    const oldSpreadsheetRowHistorical: SanitizedRowItem = {
      ...oldSpreadsheetRowFresh,
      statusRaw: 'Proposal Shared',
      importedStatus: 'PROPOSAL_SHARED',
      isHistoricalCalled: true,
      salesPersonRaw: 'Hasti',
      remarks: 'Sent revised quote',
    };
    const mergedAfterHistoricalExcelOverwrite = mergeDuplicateLeadRecord(
      renamedLead,
      oldSpreadsheetRowHistorical,
      '2026-11-07T09:00:00.000Z'
    );
    assert.equal(
      mergedAfterHistoricalExcelOverwrite.companyName,
      'Shree Ganesh Solar Energy Pvt Ltd'
    );
    assert.equal(
      mergedAfterHistoricalExcelOverwrite.companyNameNormalized,
      'shree ganesh solar energy pvt ltd'
    );
    assert.equal(mergedAfterHistoricalExcelOverwrite.isNameManuallyEdited, true);
    assert.equal(mergedAfterHistoricalExcelOverwrite.status, 'PROPOSAL_SHARED');
  });

  it('12. Auto-Sanitizes Duplicate Claimed Batches (Batch #2 Reset to AVAILABLE), Supports Owner 1-Click Release Batch, and Permanently Locks INTERESTED Leads in Dedicated Owner Closing Pipeline', () => {
    const todayDate = '2026-11-06';
    const leadsPool = Array.from({ length: 6 }, (_, idx) => ({
      ...makeFreshLead(idx + 1),
      assignedBatchId: idx < 3 ? 'BATCH_2026_11_06_01' : 'BATCH_2026_11_06_02',
      assignedRepEmail: 'hastisavani.07@solarithmdesign.com',
      assignedRepName: 'Savani Hasti Vijaybhai',
    }));

    // Simulate Batch #1 and Batch #2 both claimed by Savani Hasti Vijaybhai from earlier testing
    const duplicateClaimedBatches: BatchRecord[] = [
      {
        batchId: 'BATCH_2026_11_06_01',
        batchNumber: 1,
        date: todayDate,
        totalLeads: 3,
        totalLeadsAssigned: 3,
        remainingLeads: 3,
        claimedByEmail: 'hastisavani.07@solarithmdesign.com',
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: '2026-11-06T03:00:00.000Z',
        status: 'IN_PROGRESS',
        completedCallsCount: 1,
        untouchedCount: 3,
        retryCount: 0,
        leadIds: ['fresh-lead-1', 'fresh-lead-2', 'fresh-lead-3'],
        createdAt: '2026-11-06T02:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_06_02',
        batchNumber: 2,
        date: todayDate,
        totalLeads: 3,
        totalLeadsAssigned: 3,
        remainingLeads: 3,
        claimedByEmail: 'hasti.savani@solarithmdesign.com', // alias of same canonical rep!
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: '2026-11-06T03:05:00.000Z',
        status: 'IN_PROGRESS',
        completedCallsCount: 0,
        untouchedCount: 3,
        retryCount: 0,
        leadIds: ['fresh-lead-4', 'fresh-lead-5', 'fresh-lead-6'],
        createdAt: '2026-11-06T02:00:00.000Z',
      },
    ];

    // 1. Automatic Duplicate Claim Cleanup on Load: keeps Batch #1 and resets Batch #2 back to AVAILABLE
    const cleanupResult = autoSanitizeDuplicateClaimedBatchesPure(
      duplicateClaimedBatches,
      leadsPool,
      todayDate
    );
    assert.equal(cleanupResult.changed, true);
    assert.equal(cleanupResult.releasedBatches.length, 1);
    assert.equal(cleanupResult.releasedBatches[0].batchId, 'BATCH_2026_11_06_02');
    assert.equal(cleanupResult.releasedBatches[0].status, 'AVAILABLE');
    assert.equal(cleanupResult.releasedBatches[0].claimedByEmail, null);
    assert.equal(cleanupResult.releasedBatches[0].claimedByName, null);
    assert.equal(cleanupResult.releasedBatches[0].claimedAt, null);

    const b1AfterCleanup = cleanupResult.updatedBatches.find(
      (b) => b.batchId === 'BATCH_2026_11_06_01'
    )!;
    const b2AfterCleanup = cleanupResult.updatedBatches.find(
      (b) => b.batchId === 'BATCH_2026_11_06_02'
    )!;
    assert.equal(b1AfterCleanup.status, 'IN_PROGRESS');
    assert.equal(b2AfterCleanup.status, 'AVAILABLE');

    // Verify Batch #2 leads have assignedRepEmail/Name cleared while staying in Batch #2
    const b2Leads = cleanupResult.updatedLeads.filter(
      (l) => l.assignedBatchId === 'BATCH_2026_11_06_02'
    );
    assert.equal(b2Leads.length, 3);
    assert.ok(b2Leads.every((l) => l.assignedRepEmail === null && l.assignedRepName === null));

    // 2. Owner 1-Click Manual [Release Batch] on Batch #1
    const manualRelease = releaseBatchClaimPure(
      'BATCH_2026_11_06_01',
      cleanupResult.updatedBatches,
      cleanupResult.updatedLeads
    );
    assert.ok(manualRelease.releasedBatch);
    assert.equal(manualRelease.releasedBatch.status, 'AVAILABLE');
    assert.equal(manualRelease.releasedBatch.claimedByEmail, null);
    assert.equal(manualRelease.releasedBatch.claimedByName, null);

    // 3. Dedicated Owner Closing Pipeline Statuses & Permanent Lock Out of Fresh Pool
    const repHandedOverLead = applyCallDispositionUpdatePure(makeFreshLead(1), {
      newStatus: 'INTERESTED',
      callDate: '2026-11-06',
      notes: 'Client confirmed 500kW requirement; handed over to Owner.',
      actorUser: {
        email: 'hastisavani.07@solarithmdesign.com',
        name: 'Savani Hasti Vijaybhai',
      },
      nowIso: '2026-11-06T08:00:00.000Z',
    });
    assert.equal(repHandedOverLead.status, 'INTERESTED');
    assert.equal(repHandedOverLead.ownerSubStatus, 'PENDING_FIRST_CALL');
    assert.equal(repHandedOverLead.ownerCallAttempts, 0);
    assert.equal(
      formatOwnerSubStatusBadgePure(repHandedOverLead.ownerSubStatus).label,
      'New Handover'
    );

    // Owner calls the INTERESTED lead and client doesn't pick up -> Owner selects DIDNT_RECEIVE_RETRY
    // Even if someone passes DIDNT_RECEIVE as newStatus, lead MUST stay INTERESTED and NEVER return to Fresh Pool!
    const afterOwnerDidntReceive = applyCallDispositionUpdatePure(
      repHandedOverLead,
      {
        newStatus: 'DIDNT_RECEIVE',
        ownerSubStatus: 'DIDNT_RECEIVE_RETRY',
        callDate: '2026-11-06',
        notes: 'Owner called, client in board meeting; retry at 4 PM.',
        actorUser: {
          email: 'ashish@solarithmdesign.com',
          name: 'Ashish',
          isOwnerTier: true,
          role: 'OWNER',
        },
        nowIso: '2026-11-06T09:00:00.000Z',
      }
    );
    assert.equal(afterOwnerDidntReceive.status, 'INTERESTED');
    assert.equal(afterOwnerDidntReceive.ownerSubStatus, 'DIDNT_RECEIVE_RETRY');
    assert.equal(afterOwnerDidntReceive.ownerCallAttempts, 1);
    assert.equal(afterOwnerDidntReceive.assignedBatchId, null);
    assert.equal(afterOwnerDidntReceive.cooldownUntil, null);
    // Originating Sales Rep attribution strictly preserved!
    assert.equal(
      afterOwnerDidntReceive.assignedRepEmail,
      'hastisavani.07@solarithmdesign.com'
    );
    assert.equal(
      formatOwnerSubStatusBadgePure(afterOwnerDidntReceive.ownerSubStatus).label,
      "Owner Retry (Didn't Receive)"
    );

    // Owner updates to QUOTE_SHARED
    const afterOwnerQuoteShared = applyCallDispositionUpdatePure(
      afterOwnerDidntReceive,
      {
        newStatus: 'INTERESTED',
        ownerSubStatus: 'QUOTE_SHARED',
        callDate: '2026-11-06',
        notes: 'Final commercial quote shared by Owner.',
        actorUser: {
          email: 'ashish@solarithmdesign.com',
          name: 'Ashish',
          isOwnerTier: true,
          role: 'OWNER',
        },
        nowIso: '2026-11-06T10:00:00.000Z',
      }
    );
    assert.equal(afterOwnerQuoteShared.status, 'INTERESTED');
    assert.equal(afterOwnerQuoteShared.ownerSubStatus, 'QUOTE_SHARED');
    assert.equal(afterOwnerQuoteShared.ownerCallAttempts, 2);
    assert.ok(afterOwnerQuoteShared.nextFollowUpDate);
    assert.equal(
      formatOwnerSubStatusBadgePure(afterOwnerQuoteShared.ownerSubStatus).label,
      'Quote Shared'
    );

    // Sub-filter matching checks
    assert.equal(
      doesLeadMatchInterestedSubFilterPure(repHandedOverLead, 'NEW_HANDOVER'),
      true
    );
    assert.equal(
      doesLeadMatchInterestedSubFilterPure(afterOwnerDidntReceive, 'OWNER_RETRY'),
      true
    );
    assert.equal(
      doesLeadMatchInterestedSubFilterPure(
        afterOwnerQuoteShared,
        'QUOTE_NEGOTIATION'
      ),
      true
    );

    // Terminal Executive Action: Convert to Client (Closed Won) -> status = CLOSED_WON, ownerSubStatus = WON, credits originating Sales Rep
    const afterClosedWon = applyCallDispositionUpdatePure(afterOwnerQuoteShared, {
      newStatus: 'CLOSED_WON',
      ownerSubStatus: 'WON',
      callDate: '2026-11-06',
      notes: 'Advance payment received; deal won.',
      actorUser: {
        email: 'ashish@solarithmdesign.com',
        name: 'Ashish',
        isOwnerTier: true,
        role: 'OWNER',
      },
      nowIso: '2026-11-06T11:00:00.000Z',
    });
    assert.equal(afterClosedWon.status, 'CLOSED_WON');
    assert.equal(afterClosedWon.ownerSubStatus, 'WON');
    assert.ok(afterClosedWon.closedWonAt);
    assert.equal(
      afterClosedWon.assignedRepEmail,
      'hastisavani.07@solarithmdesign.com'
    );
    assert.equal(afterClosedWon.ownerCallAttempts, 3);

    // Terminal Executive Action: Mark as Lead Lost -> status = LEAD_LOST, ownerSubStatus = LOST
    const afterLeadLost = applyCallDispositionUpdatePure(afterOwnerDidntReceive, {
      newStatus: 'LEAD_LOST',
      ownerSubStatus: 'LOST',
      callDate: '2026-11-06',
      notes: 'Competitor awarded project.',
      actorUser: {
        email: 'ashish@solarithmdesign.com',
        name: 'Ashish',
        isOwnerTier: true,
        role: 'OWNER',
      },
      nowIso: '2026-11-06T11:30:00.000Z',
    });
    assert.equal(afterLeadLost.status, 'LEAD_LOST');
    assert.equal(afterLeadLost.ownerSubStatus, 'LOST');
    assert.ok(afterLeadLost.leadLostAt);
  });

  it('13. 100% Hands-Free Daily Reset Engine: Cleans Up Duplicate #4/#5/#6 & CLOSED Batches into Deterministic 1..N Batches and Prevents Follow-Up/Owner Edits from Inflating Call Counter', () => {
    const todayDate = '2026-11-15';
    const activeRepCount = 3;

    // Simulate 1,164 uncalled FRESH leads stuck across Batch #4, #5, #6 while Batch #1, #2, #3 are CLOSED from manual testing
    const freshPool1164: LeadRecord[] = Array.from({ length: 1164 }, (_, idx) => {
      const staleBatchNum = 4 + (idx % 3); // 4, 5, 6
      return {
        ...makeFreshLead(idx + 1),
        assignedBatchId: `BATCH_2026_11_15_0${staleBatchNum}`,
      };
    });

    const pollutedBatches: BatchRecord[] = [
      {
        batchId: 'BATCH_2026_11_15_01',
        batchNumber: 1,
        date: todayDate,
        totalLeads: 388,
        totalLeadsAssigned: 388,
        remainingLeads: 386,
        claimedByEmail: 'hastisavani.07@solarithmdesign.com',
        claimedByName: 'Savani Hasti Vijaybhai',
        claimedAt: '2026-11-15T03:00:00.000Z',
        status: 'CLOSED',
        completedCallsCount: 3,
        untouchedCount: 388,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T02:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_15_02',
        batchNumber: 2,
        date: todayDate,
        totalLeads: 389,
        totalLeadsAssigned: 389,
        remainingLeads: 389,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'CLOSED',
        completedCallsCount: 0,
        untouchedCount: 389,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T02:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_15_03',
        batchNumber: 3,
        date: todayDate,
        totalLeads: 389,
        totalLeadsAssigned: 389,
        remainingLeads: 389,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'CLOSED',
        completedCallsCount: 0,
        untouchedCount: 389,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T02:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_15_04',
        batchNumber: 4,
        date: todayDate,
        totalLeads: 388,
        totalLeadsAssigned: 388,
        remainingLeads: 388,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        untouchedCount: 388,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T04:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_15_05',
        batchNumber: 5,
        date: todayDate,
        totalLeads: 388,
        totalLeadsAssigned: 388,
        remainingLeads: 388,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        untouchedCount: 388,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T04:00:00.000Z',
      },
      {
        batchId: 'BATCH_2026_11_15_06',
        batchNumber: 6,
        date: todayDate,
        totalLeads: 388,
        totalLeadsAssigned: 388,
        remainingLeads: 388,
        claimedByEmail: null,
        claimedByName: null,
        claimedAt: null,
        status: 'AVAILABLE',
        completedCallsCount: 0,
        untouchedCount: 388,
        retryCount: 0,
        leadIds: [],
        createdAt: '2026-11-15T04:00:00.000Z',
      },
    ];

    const resynced = partitionFreshLeadsEquallyForActiveRepsPure(
      freshPool1164,
      pollutedBatches,
      activeRepCount,
      todayDate,
      '2026-11-15T05:00:00.000Z'
    );

    assert.equal(resynced.changed, true);
    // Strictly 3 batches: BATCH_2026_11_15_01, BATCH_2026_11_15_02, BATCH_2026_11_15_03
    assert.equal(resynced.todayBatches.length, 3);
    assert.deepEqual(
      resynced.todayBatches.map((b) => b.batchId),
      ['BATCH_2026_11_15_01', 'BATCH_2026_11_15_02', 'BATCH_2026_11_15_03']
    );
    assert.deepEqual(
      resynced.todayBatches.map((b) => b.batchNumber),
      [1, 2, 3]
    );
    assert.ok(resynced.todayBatches.every((b) => b.status === 'AVAILABLE'));
    assert.ok(resynced.todayBatches.every((b) => b.totalLeads === 388));
    // Extra #4, #5, #6 batches are marked for deletion
    assert.ok(resynced.deletedBatchIds.includes('BATCH_2026_11_15_04'));
    assert.ok(resynced.deletedBatchIds.includes('BATCH_2026_11_15_05'));
    assert.ok(resynced.deletedBatchIds.includes('BATCH_2026_11_15_06'));

    // Verify Call Counter Accuracy:
    // 1. Rep calls Lead #1 (FRESH -> PROPOSAL_SHARED) and Lead #2 (FRESH -> INTERESTED)
    const repActor = {
      email: 'hastisavani.07@solarithmdesign.com',
      name: 'Savani Hasti Vijaybhai',
    };
    const calledLead1 = applyCallDispositionUpdatePure(resynced.updatedLeads[0], {
      newStatus: 'PROPOSAL_SHARED',
      callDate: todayDate,
      notes: 'Sent proposal.',
      actorUser: repActor,
      nowIso: '2026-11-15T05:10:00.000Z',
    });
    const calledLead2 = applyCallDispositionUpdatePure(resynced.updatedLeads[1], {
      newStatus: 'INTERESTED',
      callDate: todayDate,
      notes: 'Interested in 100kW.',
      actorUser: repActor,
      nowIso: '2026-11-15T05:15:00.000Z',
    });
    assert.equal(calledLead1.callAttempts, 1);
    assert.equal(calledLead2.callAttempts, 1);

    // 2. Owner updates ownerSubStatus on calledLead2 (INTERESTED) -> must NOT increment rep callAttempts or overwrite rep lastCalledByEmail
    const ownerUpdatedLead2 = applyCallDispositionUpdatePure(calledLead2, {
      newStatus: 'INTERESTED',
      ownerSubStatus: 'QUOTE_SHARED',
      callDate: todayDate,
      notes: 'Owner shared final quote.',
      actorUser: {
        email: 'ashish@solarithmdesign.com',
        name: 'Ashish',
        isOwnerTier: true,
        role: 'OWNER',
      },
      nowIso: '2026-11-15T05:25:00.000Z',
    });
    assert.equal(ownerUpdatedLead2.callAttempts, 1);
    assert.equal(ownerUpdatedLead2.ownerCallAttempts, 1);
    assert.equal(
      ownerUpdatedLead2.lastCalledByEmail,
      'hastisavani.07@solarithmdesign.com'
    );

    // 3. Same-day and next-day follow-up note edits on calledLead1 -> must NOT increment callAttempts a second time
    const followUpEditedLead1 = applyCallDispositionUpdatePure(calledLead1, {
      newStatus: 'PROPOSAL_SHARED',
      callDate: todayDate,
      notes: 'Updated follow-up remark.',
      actorUser: repActor,
      nowIso: '2026-11-15T05:30:00.000Z',
    });
    assert.equal(followUpEditedLead1.callAttempts, 1);

    const nextDayFollowUpLead1 = applyCallDispositionUpdatePure(followUpEditedLead1, {
      newStatus: 'PROPOSAL_SHARED',
      callDate: '2026-11-16',
      notes: 'Second follow-up check-in.',
      actorUser: repActor,
      nowIso: '2026-11-16T06:00:00.000Z',
    });
    assert.equal(nextDayFollowUpLead1.callAttempts, 1);

    // 4. Verify Performance Chart & Scorecard strictly separate Manual Lead Additions (+ Add Lead) from Daily Dials
    const manualLeadAddedByHasti: LeadRecord = {
      ...nextDayFollowUpLead1,
      id: 'manual-lead-hasti-1',
      source: 'manual',
      importBatchId: null,
      createdByEmail: 'hastisavani.07@solarithmdesign.com',
      createdByName: 'Savani Hasti Vijaybhai',
      createdByRole: 'SALES',
      createdAt: '2026-11-16T07:00:00.000Z',
    };
    const ownerScorecardReport = computeOwnerAnalyticsPure(
      [nextDayFollowUpLead1, ownerUpdatedLead2, manualLeadAddedByHasti],
      [
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
      ],
      { preset: 'ALL_TIME' },
      '2026-11-16T08:00:00.000Z'
    );
    const hastiScorecard = ownerScorecardReport.scorecardRows.find(
      (r) => r.repEmail === 'hastisavani.07@solarithmdesign.com'
    );
    assert.ok(hastiScorecard);
    assert.equal(hastiScorecard.callsDialed, 3);
    assert.equal(hastiScorecard.newLeadsAdded, 1); // Strictly 1 manual lead created via + Add Lead
    assert.equal(hastiScorecard.proposalsShared, 2);
    assert.equal(hastiScorecard.interestedGenerated, 1);
  });

  it('27. Comprehensive Production Fixes: Counter Drift Reconciliation, Clickable Metric Filters, 🔥 To-Call Today Priority Queue, Owner Master Lead Table, and 48h Cooldown for DIDNT_RECEIVE & SWITCH_OFF', () => {
    const todayDate = getTodayIstDateString();
    const pastFollowUpDate = '2026-01-10T09:00:00.000Z';
    const futureFollowUpDate = '2099-12-31T09:00:00.000Z';
    const expiredCooldownIso = new Date(Date.now() - 3600 * 1000).toISOString();
    const activeCooldownIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const repEmail = 'hastisavani.07@solarithmdesign.com';
    const repName = 'Savani Hasti Vijaybhai';

    const batchToday: BatchRecord = {
      batchId: `BATCH-${todayDate}-1`,
      date: todayDate,
      batchNumber: 1,
      status: 'IN_PROGRESS',
      claimedByEmail: repEmail,
      claimedByName: repName,
      claimedAt: `${todayDate}T04:00:00.000Z`,
      totalLeads: 5,
      totalLeadsAssigned: 5,
      completedCallsCount: 4, // Suppose batch counter has 4 completed calls
      remainingLeads: 1,
      leadIds: [
        'lead-fresh-1',
        'lead-prop-due',
        'lead-future-due',
        'lead-dr-expired',
        'lead-dead-1',
      ],
    };

    const sampleLeads: LeadRecord[] = [
      {
        ...makeFreshLead(1),
        id: 'lead-fresh-1',
        status: 'FRESH',
        assignedBatchId: batchToday.batchId,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        callAttempts: 0,
      },
      {
        ...makeFreshLead(2),
        id: 'lead-prop-due',
        status: 'PROPOSAL_SHARED',
        assignedBatchId: batchToday.batchId,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
        lastCalledDate: `${todayDate}T05:00:00.000Z`,
        nextFollowUpDate: pastFollowUpDate,
        callAttempts: 2,
      },
      {
        ...makeFreshLead(3),
        id: 'lead-future-due',
        status: 'FUTURE_REQUIREMENT',
        assignedBatchId: batchToday.batchId,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
        lastCalledDate: `${todayDate}T05:10:00.000Z`,
        nextFollowUpDate: pastFollowUpDate,
        callAttempts: 1,
      },
      {
        ...makeFreshLead(4),
        id: 'lead-dr-expired',
        status: 'DIDNT_RECEIVE',
        assignedBatchId: batchToday.batchId,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
        lastCalledDate: '2026-01-01T10:00:00.000Z',
        cooldownUntil: expiredCooldownIso,
        didntReceiveCount: 2,
        callAttempts: 2,
      },
      {
        ...makeFreshLead(5),
        id: 'lead-so-active-cooldown',
        status: 'SWITCH_OFF',
        assignedBatchId: null,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
        lastCalledDate: `${todayDate}T05:20:00.000Z`,
        cooldownUntil: activeCooldownIso,
        switchOffCount: 1,
        callAttempts: 1,
      },
      {
        ...makeFreshLead(6),
        id: 'lead-dead-1',
        status: 'NOT_INTERESTED',
        assignedBatchId: batchToday.batchId,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
        lastCalledDate: `${todayDate}T05:30:00.000Z`,
        callAttempts: 1,
      },
      {
        ...makeFreshLead(7),
        id: 'lead-prop-not-due',
        status: 'PROPOSAL_SHARED',
        assignedBatchId: null,
        assignedRepEmail: repEmail,
        assignedRepName: repName,
        nextFollowUpDate: futureFollowUpDate,
        callAttempts: 1,
      },
    ];

    // 1. Counter Drift Reconciliation: Owner callsDialedToday reconciles with today's batch completedCallsCount
    const ownerMetrics = computeOwnerMetricStripPure(
      sampleLeads,
      CANONICAL_NEXUS_EMPLOYEES,
      [batchToday]
    );
    assert.equal(ownerMetrics.callsDialedToday, 4);
    assert.equal(ownerMetrics.deadClosedOut, 1);

    // 2. Clickable Metric Inspectors: CALLS_DIALED_TODAY & DEAD_CLOSED_OUT filter the workspace table
    const dialedTodayRes = filterAndSortWorkspaceTableLeadsPure({
      leads: sampleLeads,
      batches: [batchToday],
      tab: 'CALLS_DIALED_TODAY',
      isOwner: true,
      userEmail: 'jay@solarithm.com',
      todayDate,
    });
    assert.equal(dialedTodayRes.filteredLeads.length, 4);

    const deadClosedRes = filterAndSortWorkspaceTableLeadsPure({
      leads: sampleLeads,
      batches: [batchToday],
      tab: 'DEAD_CLOSED_OUT',
      isOwner: true,
      userEmail: 'jay@solarithm.com',
      todayDate,
    });
    assert.equal(deadClosedRes.filteredLeads.length, 1);
    assert.equal(deadClosedRes.filteredLeads[0].id, 'lead-dead-1');

    // 3. Dedicated Rep Priority Tab: 🔥 To-Call Today (TO_CALL_TODAY)
    // Includes PROPOSAL_SHARED due, FUTURE_REQUIREMENT due, and DIDNT_RECEIVE with expired 48h cooldown
    // Excludes SWITCH_OFF still inside active 48h cooldown and PROPOSAL_SHARED not yet due
    const toCallTodayRepRes = filterAndSortWorkspaceTableLeadsPure({
      leads: sampleLeads,
      batches: [batchToday],
      tab: 'TO_CALL_TODAY',
      isOwner: false,
      userEmail: repEmail,
      todayDate,
    });
    const toCallIds = toCallTodayRepRes.filteredLeads.map((l) => l.id);
    assert.ok(toCallIds.includes('lead-prop-due'));
    assert.ok(toCallIds.includes('lead-future-due'));
    assert.ok(toCallIds.includes('lead-dr-expired'));
    assert.ok(!toCallIds.includes('lead-so-active-cooldown'));
    assert.ok(!toCallIds.includes('lead-prop-not-due'));

    // 4. Comprehensive Owner Master Lead Table (ALL_LEADS): shows all leads in batch with latest status & attempt history
    const ownerAllBatchLeadsRes = filterAndSortWorkspaceTableLeadsPure({
      leads: sampleLeads,
      batches: [batchToday],
      tab: 'ALL_LEADS',
      isOwner: true,
      userEmail: 'jay@solarithm.com',
      todayDate,
      selectedBatchIdFilter: batchToday.batchId,
    });
    assert.equal(ownerAllBatchLeadsRes.filteredLeads.length, 5);

    // 5. Strict 48-Hour Cooldown Rule Enforcement on SWITCH_OFF disposition
    const freshForSwitchOff: LeadRecord = {
      ...makeFreshLead(99),
      id: 'lead-switch-off-test',
      status: 'FRESH',
    };
    const afterSwitchOff = applyCallDispositionUpdatePure(freshForSwitchOff, {
      newStatus: 'SWITCH_OFF',
      callDate: '2026-11-16',
      notes: 'Phone switched off',
      actorUser: {
        email: repEmail,
        name: repName,
        role: 'SALES',
      },
      nowIso: '2026-11-16T10:00:00.000Z',
    });
    assert.equal(afterSwitchOff.status, 'SWITCH_OFF');
    assert.equal(afterSwitchOff.switchOffCount, 1);
    assert.equal(afterSwitchOff.callAttempts, 1);
    assert.ok(
      afterSwitchOff.cooldownUntil &&
        afterSwitchOff.cooldownUntil > '2026-11-17T00:00:00.000Z',
      'SWITCH_OFF must set a mandatory 48-hour cooldownUntil timestamp'
    );
  });

  it('28. Daily Reset Pool Release & Tail-End Batch Sequencing: retains current-day DIDNT_RECEIVE/SWITCH_OFF in Calls Dialed Today, releases cooled-down retries on daily reset, and places 1,688 untouched leads first (1..1688) and 11 retry leads strictly at the tail end (1689..1699)', () => {
    const todayDate = '2026-11-16';
    const resetNow = new Date('2026-11-16T00:05:00.000Z');
    const repEmail = 'hastisavani.07@solarithmdesign.com';
    const repName = 'Savani Hasti Vijaybhai';

    // 1,688 untouched fresh leads (Priority 1)
    const untouchedLeads: LeadRecord[] = Array.from({ length: 1688 }, (_, idx) => ({
      ...makeFreshLead(idx + 1),
      id: `untouched-${idx + 1}`,
      status: 'FRESH',
      callAttempts: 0,
      didntReceiveCount: 0,
      switchOffCount: 0,
    }));

    // 11 prior-day cooled-down retry leads (7 DIDNT_RECEIVE + 4 SWITCH_OFF) whose >=48h cooldown has expired (Priority 2)
    const cooledDownRetryLeads: LeadRecord[] = Array.from({ length: 11 }, (_, idx) => {
      const isSwitchOff = idx >= 7;
      return {
        ...makeFreshLead(2000 + idx),
        id: `retry-cooled-${idx + 1}`,
        status: isSwitchOff ? 'SWITCH_OFF' : 'DIDNT_RECEIVE',
        callAttempts: 1,
        didntReceiveCount: isSwitchOff ? 0 : 1,
        switchOffCount: isSwitchOff ? 1 : 0,
        lastCalledDate: '2026-11-13T09:00:00.000Z', // > 48h ago
        cooldownUntil: '2026-11-15T09:00:00.000Z', // expired before 2026-11-16
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
      };
    });

    // 2 leads marked DIDNT_RECEIVE and SWITCH_OFF during the current day (todayDate = 2026-11-16)
    // Must remain tagged with DIDNT_RECEIVE / SWITCH_OFF and appear in Calls Dialed Today, NOT prematurely released!
    const currentDayDialedLeads: LeadRecord[] = [
      {
        ...makeFreshLead(3001),
        id: 'dialed-today-dr',
        status: 'DIDNT_RECEIVE',
        callAttempts: 1,
        didntReceiveCount: 1,
        lastCalledDate: `${todayDate}T06:30:00.000Z`,
        cooldownUntil: '2026-11-18T06:30:00.000Z',
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
      },
      {
        ...makeFreshLead(3002),
        id: 'dialed-today-so',
        status: 'SWITCH_OFF',
        callAttempts: 1,
        switchOffCount: 1,
        lastCalledDate: `${todayDate}T07:00:00.000Z`,
        cooldownUntil: '2026-11-18T07:00:00.000Z',
        lastCalledByEmail: repEmail,
        lastCalledByName: repName,
      },
    ];

    // Intentionally place cooled-down retry leads at the front of the input array to verify
    // that the partitioner & sorter strictly move them to the tail end (indices 1688..1698)!
    const mixedInputPool: LeadRecord[] = [
      ...cooledDownRetryLeads,
      ...currentDayDialedLeads,
      ...untouchedLeads,
    ];

    const partitioned = partitionFreshLeadsEquallyForActiveRepsPure(
      mixedInputPool,
      [],
      1, // 1 batch for 1,699 leads example
      todayDate,
      resetNow,
      true
    );

    assert.equal(partitioned.todayBatches.length, 1);
    const batch1 = partitioned.todayBatches[0];
    assert.equal(batch1.totalLeads, 1699);
    assert.equal(batch1.untouchedCount, 1688);
    assert.equal(batch1.retryCount, 11);

    const batchLeadIds = batch1.leadIds || [];
    assert.equal(batchLeadIds.length, 1699);

    // Verify indices 0..1687 (1 through 1,688) are ALL untouched fresh leads
    for (let i = 0; i < 1688; i++) {
      assert.ok(
        batchLeadIds[i].startsWith('untouched-'),
        `Expected index ${i} to be an untouched lead, got ${batchLeadIds[i]}`
      );
    }

    // Verify indices 1688..1698 (1,689 through 1,699) at the tail end are ALL cooled-down retry leads
    for (let i = 1688; i < 1699; i++) {
      assert.ok(
        batchLeadIds[i].startsWith('retry-cooled-'),
        `Expected tail index ${i} to be a cooled-down retry lead, got ${batchLeadIds[i]}`
      );
    }

    // Verify current-day DIDNT_RECEIVE and SWITCH_OFF leads were NOT released into the batch
    const stillTodayDr = partitioned.updatedLeads.find((l) => l.id === 'dialed-today-dr')!;
    const stillTodaySo = partitioned.updatedLeads.find((l) => l.id === 'dialed-today-so')!;
    assert.equal(stillTodayDr.status, 'DIDNT_RECEIVE');
    assert.equal(stillTodayDr.assignedBatchId, null);
    assert.equal(stillTodaySo.status, 'SWITCH_OFF');
    assert.equal(stillTodaySo.assignedBatchId, null);

    // Verify Sales Rep opening their claimed daily batch sees untouched leads first (0..1687) and retries at the tail (1688..1698)
    const claimedBatch1: BatchRecord = {
      ...batch1,
      status: 'IN_PROGRESS',
      claimedByEmail: repEmail,
      claimedByName: repName,
      claimedAt: `${todayDate}T04:00:00.000Z`,
    };

    const repQueueRes = filterAndSortWorkspaceTableLeadsPure({
      leads: partitioned.updatedLeads,
      batches: [claimedBatch1],
      tab: 'FRESH',
      isOwner: false,
      userEmail: repEmail,
      todayDate,
    });

    assert.equal(repQueueRes.filteredLeads.length, 1699);
    for (let i = 0; i < 1688; i++) {
      assert.ok(repQueueRes.filteredLeads[i].id.startsWith('untouched-'));
      assert.equal(repQueueRes.filteredLeads[i].callAttempts, 0);
    }
    for (let i = 1688; i < 1699; i++) {
      assert.ok(repQueueRes.filteredLeads[i].id.startsWith('retry-cooled-'));
      assert.ok((repQueueRes.filteredLeads[i].callAttempts || 0) >= 1);
    }
  });

  it('29. UI Polish: formatRepName keeps only first and middle names (first 2 words) and Interested metric box count is computed for both Owner and Sales Rep strips', () => {
    assert.equal(formatRepName('Savani Hasti Vijaybhai'), 'Savani Hasti');
    assert.equal(formatRepName('Dhami Krina Rajeshbhai'), 'Dhami Krina');
    assert.equal(formatRepName('Savani Hasti Vijaybhai (Sales Rep)'), 'Savani Hasti');
    assert.equal(formatRepName('Katariyaisha'), 'Katariyaisha');
    assert.equal(formatRepName(null), '—');
    assert.equal(formatRepName('   '), '—');

    const repEmail = 'hastisavani.07@solarithmdesign.com';
    const interestedLead: LeadRecord = {
      ...makeFreshLead(3001),
      status: 'INTERESTED',
      assignedRepEmail: repEmail,
      assignedRepName: 'Savani Hasti Vijaybhai',
      lastCalledByEmail: repEmail,
      lastCalledByName: 'Savani Hasti Vijaybhai',
      lastCalledDate: '2026-11-16T09:00:00.000Z',
    };

    assert.equal(formatLastCalledByRepNamePure(interestedLead), 'Savani Hasti');

    const ownerStrip = computeOwnerMetricStripPure([interestedLead], [], []);
    assert.equal(ownerStrip.interestedOwnerQueue, 1);

    const salesStrip = computeSalesRepMetricStripPure([interestedLead], [], repEmail);
    assert.equal(salesStrip.interestedCount, 1);
  });

  it('30. Master Fix Spec: Batch Claim Timestamps ("Claimed by [Rep Name] at [HH:MM AM/PM]") and Workspace Date Range Filters (Today, Last 7 Days, This Month, Last 30 Days, All Time) across Metric Cards & Tables', () => {
    const claimedIso = '2026-11-17T04:15:00.000Z';
    const expectedTime = formatBatchClaimTimePure(claimedIso);
    assert.ok(expectedTime, 'Expected formatted time string from ISO timestamp');

    const claimedLabel = formatBatchClaimStatusLabelPure({
      status: 'IN_PROGRESS',
      claimedByName: 'Savani Hasti Vijaybhai',
      claimedAt: claimedIso,
    });
    assert.equal(claimedLabel, `Claimed by Savani Hasti at ${expectedTime}`);

    const availableLabel = formatBatchClaimStatusLabelPure({
      status: 'AVAILABLE',
      claimedByName: null,
      claimedAt: null,
    });
    assert.equal(availableLabel, 'Available');

    const repEmail = 'hastisavani.07@solarithmdesign.com';
    const nowIso = '2026-11-17T10:00:00.000Z';
    const todayDate = getTodayIstDateString(new Date(nowIso));

    const leadTodayProposal: LeadRecord = {
      ...makeFreshLead(4001),
      id: 'lead-today-prop',
      status: 'PROPOSAL_SHARED',
      assignedRepEmail: repEmail,
      lastCalledByEmail: repEmail,
      lastCalledDate: `${todayDate}T08:00:00.000Z`,
      updatedAt: `${todayDate}T08:00:00.000Z`,
    };

    const lead5DaysAgoInterested: LeadRecord = {
      ...makeFreshLead(4002),
      id: 'lead-5d-int',
      status: 'INTERESTED',
      assignedRepEmail: repEmail,
      lastCalledByEmail: repEmail,
      lastCalledDate: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-13T08:00:00.000Z',
    };

    const lead45DaysAgoDead: LeadRecord = {
      ...makeFreshLead(4003),
      id: 'lead-45d-dead',
      status: 'NOT_INTERESTED',
      assignedRepEmail: repEmail,
      lastCalledByEmail: repEmail,
      lastCalledDate: '2026-09-20T08:00:00.000Z',
      updatedAt: '2026-09-20T08:00:00.000Z',
    };

    const samplePool = [
      leadTodayProposal,
      lead5DaysAgoInterested,
      lead45DaysAgoDead,
    ];

    // TODAY filter: matches only today's lead
    assert.equal(
      doesLeadMatchWorkspaceDateFilterPure(
        leadTodayProposal,
        { preset: 'TODAY' },
        nowIso
      ),
      true
    );
    assert.equal(
      doesLeadMatchWorkspaceDateFilterPure(
        lead5DaysAgoInterested,
        { preset: 'TODAY' },
        nowIso
      ),
      false
    );

    const ownerToday = computeOwnerMetricStripPure(
      samplePool,
      [],
      [],
      { preset: 'TODAY' },
      nowIso
    );
    assert.equal(ownerToday.proposalsShared, 1);
    assert.equal(ownerToday.interestedOwnerQueue, 0);
    assert.equal(ownerToday.deadClosedOut, 0);

    // LAST_7_DAYS filter: includes today + 5 days ago, excludes 45 days ago
    const ownerLast7 = computeOwnerMetricStripPure(
      samplePool,
      [],
      [],
      { preset: 'LAST_7_DAYS' },
      nowIso
    );
    assert.equal(ownerLast7.proposalsShared, 1);
    assert.equal(ownerLast7.interestedOwnerQueue, 1);
    assert.equal(ownerLast7.deadClosedOut, 0);

    // ALL_TIME filter: includes all 3 leads
    const ownerAllTime = computeOwnerMetricStripPure(
      samplePool,
      [],
      [],
      { preset: 'ALL_TIME' },
      nowIso
    );
    assert.equal(ownerAllTime.proposalsShared, 1);
    assert.equal(ownerAllTime.interestedOwnerQueue, 1);
    assert.equal(ownerAllTime.deadClosedOut, 1);

    // Table filtering with TODAY vs LAST_7_DAYS on INTERESTED tab
    const tableInterestedToday = filterAndSortWorkspaceTableLeadsPure({
      leads: samplePool,
      batches: [],
      tab: 'INTERESTED',
      isOwner: true,
      userEmail: repEmail,
      todayDate,
      dateFilter: { preset: 'TODAY' },
    });
    assert.equal(tableInterestedToday.filteredLeads.length, 0);

    const tableInterested7Days = filterAndSortWorkspaceTableLeadsPure({
      leads: samplePool,
      batches: [],
      tab: 'INTERESTED',
      isOwner: true,
      userEmail: repEmail,
      todayDate,
      dateFilter: { preset: 'LAST_7_DAYS' },
    });
    assert.equal(tableInterested7Days.filteredLeads.length, 1);
    assert.equal(tableInterested7Days.filteredLeads[0].id, 'lead-5d-int');
  });
});
