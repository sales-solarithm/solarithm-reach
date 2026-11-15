import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEAM_TARGETS,
  computeRepDailyProgress,
  computeRepTodayCallsFromLeads,
} from '../components/settings/TargetSettings';
import { computeTeamLeaderboardPure } from '../components/analytics/Leaderboard';
import {
  WEEKLY_DIGEST_CRON_SCHEDULE,
  generateWeeklyDigestPayloadPure,
  parseLeadDealValueInr,
  parseLeadSolarCapacityKw,
  renderWeeklyDigestHtml,
} from '../functions/src/cron/weeklyDigest';
import { INITIAL_AUTHORIZED_USERS, INITIAL_LEADS } from './seedData';
import { LeadRecord } from './types';

describe('Phase 14: Automated Weekly Cadence, Performance Leaderboard & Team Targets', () => {
  it('Task 1: formats Rep Daily Progress counter ("Today\'s Calls: 64 / 120 (53%)") and shifts Solarithm Gold (#E5B842) to Emerald (#10B981) at >=100%', () => {
    assert.equal(DEFAULT_TEAM_TARGETS.dailyDialsTarget, 120);
    assert.equal(DEFAULT_TEAM_TARGETS.weeklyInterestedTarget, 10);
    assert.equal(DEFAULT_TEAM_TARGETS.proposalTurnaroundTargetHours, 48);

    const progress53 = computeRepDailyProgress(64, 120);
    assert.equal(progress53.label, "Today's Calls: 64 / 120 (53%)");
    assert.equal(progress53.percentage, 53);
    assert.equal(progress53.isTargetMet, false);
    assert.equal(progress53.barColorHex, '#E5B842');
    assert.equal(progress53.barColorClass, 'bg-[#E5B842]');

    const progress100 = computeRepDailyProgress(120, 120);
    assert.equal(progress100.label, "Today's Calls: 120 / 120 (100%)");
    assert.equal(progress100.percentage, 100);
    assert.equal(progress100.isTargetMet, true);
    assert.equal(progress100.barColorHex, '#10B981');
    assert.equal(progress100.barColorClass, 'bg-emerald-500');

    const progressOver100 = computeRepDailyProgress(135, 120);
    assert.equal(progressOver100.percentage, 113);
    assert.equal(progressOver100.clampedWidthPercent, 100);
    assert.equal(progressOver100.isTargetMet, true);
    assert.equal(progressOver100.barColorHex, '#10B981');

    const repCalls = computeRepTodayCallsFromLeads(
      'sales@solarithmdesign.com',
      [],
      64
    );
    assert.equal(repCalls, 64);
  });

  it('Task 2: computes Team Leaderboard sorted by Interested Qualified (primary desc) and Total Dials (secondary desc) with Gold/Silver/Bronze badges', () => {
    const nowIso = new Date().toISOString();
    const syntheticLeads: LeadRecord[] = [
      // Rohan has 2 interested and 15 total dials
      {
        ...INITIAL_LEADS[0],
        id: 'lb-1',
        assignedRepEmail: 'rohan@solarithmdesign.com',
        status: 'INTERESTED',
        callCount: 8,
        lastCalledDate: nowIso,
      },
      {
        ...INITIAL_LEADS[0],
        id: 'lb-2',
        assignedRepEmail: 'rohan@solarithmdesign.com',
        status: 'PROPOSAL_SHARED',
        callCount: 7,
        lastCalledDate: nowIso,
      },
      // Priya also has 2 interested, but 25 total dials -> should rank #1 over Rohan via secondary sort!
      {
        ...INITIAL_LEADS[0],
        id: 'lb-3',
        assignedRepEmail: 'sales@solarithmdesign.com',
        status: 'INTERESTED',
        callCount: 15,
        lastCalledDate: nowIso,
      },
      {
        ...INITIAL_LEADS[0],
        id: 'lb-4',
        assignedRepEmail: 'sales@solarithmdesign.com',
        status: 'CLOSED_WON',
        callCount: 10,
        lastCalledDate: nowIso,
      },
      // Kavita has 1 interested and 30 total dials -> ranks #3 because primary sort is Interested Qualified
      {
        ...INITIAL_LEADS[0],
        id: 'lb-5',
        assignedRepEmail: 'kavita@solarithmdesign.com',
        status: 'INTERESTED',
        callCount: 30,
        lastCalledDate: nowIso,
      },
    ];

    const rankings = computeTeamLeaderboardPure(
      syntheticLeads,
      INITIAL_AUTHORIZED_USERS,
      'ALL_TIME',
      DEFAULT_TEAM_TARGETS,
      new Date(),
      false
    );

    assert.equal(rankings.length, 3);
    // Rank 1: Priya (2 interested, 25 dials) -> GOLD
    assert.equal(rankings[0].rank, 1);
    assert.equal(rankings[0].badgeTier, 'GOLD');
    assert.equal(rankings[0].repEmail, 'sales@solarithmdesign.com');
    assert.equal(rankings[0].interestedQualified, 2);
    assert.equal(rankings[0].totalDials, 25);
    assert.equal(rankings[0].dealsClosed, 1);

    // Rank 2: Rohan (2 interested, 15 dials) -> SILVER
    assert.equal(rankings[1].rank, 2);
    assert.equal(rankings[1].badgeTier, 'SILVER');
    assert.equal(rankings[1].repEmail, 'rohan@solarithmdesign.com');
    assert.equal(rankings[1].interestedQualified, 2);
    assert.equal(rankings[1].totalDials, 15);

    // Rank 3: Kavita (1 interested, 30 dials) -> BRONZE
    assert.equal(rankings[2].rank, 3);
    assert.equal(rankings[2].badgeTier, 'BRONZE');
    assert.equal(rankings[2].repEmail, 'kavita@solarithmdesign.com');
    assert.equal(rankings[2].interestedQualified, 1);
    assert.equal(rankings[2].totalDials, 30);
  });

  it('Task 3: generates Sunday 20:00:00 IST Executive Email Digest (schedule("0 20 * * 0")) with Outreach Volume, Pipeline Movement, Revenue Closed, Dead Pool Metrics, and Rep Scorecards', () => {
    assert.equal(WEEKLY_DIGEST_CRON_SCHEDULE.schedule, '0 20 * * 0');
    assert.equal(WEEKLY_DIGEST_CRON_SCHEDULE.timeZone, 'Asia/Kolkata');

    const closedDealLead: LeadRecord = {
      ...INITIAL_LEADS[0],
      id: 'digest-closed-1',
      status: 'CLOSED_WON',
      notes: 'Signed 500 kWp rooftop EPC contract at ₹1.95 Cr turnkey',
      callCount: 4,
    };

    assert.equal(parseLeadSolarCapacityKw(closedDealLead), 500);
    assert.equal(parseLeadDealValueInr(closedDealLead), 19_500_000);

    const payload = generateWeeklyDigestPayloadPure(
      [...INITIAL_LEADS, closedDealLead],
      INITIAL_AUTHORIZED_USERS,
      new Date()
    );

    assert.ok(payload.outreachVolume.totalLeadsDialedThisWeek > 0);
    assert.ok(payload.pipelineMovement.newInterestedEscalations >= 1);
    assert.ok(payload.revenueClosed.closedWonDealCount >= 1);
    assert.ok(payload.revenueClosed.totalSolarKwCapacityClosed >= 500);
    assert.ok(payload.deadPoolMetrics.totalDeadRetiredCount >= 1);
    assert.equal(payload.repScorecards.length, 3);

    const html = renderWeeklyDigestHtml(payload);
    assert.ok(html.includes('Weekly Solar Outreach &amp; Revenue Cadence'));
    assert.ok(html.includes('Outreach Volume'));
    assert.ok(html.includes('Pipeline Movement'));
    assert.ok(html.includes('Revenue Closed'));
    assert.ok(html.includes('Dead Pool Retired'));
    assert.ok(html.includes('Individual Sales Rep Scorecards'));
  });
});
