import { AuthorizedUser, LeadRecord } from './types';
import { INITIAL_AUTHORIZED_USERS } from './seedData';

export const WEEKLY_DIGEST_CRON_SCHEDULE = {
  schedule: '0 20 * * 0',
  timeZone: 'Asia/Kolkata',
  description: 'Automated Sunday 20:00:00 IST Executive Email Digest',
};

export interface WeeklyDigestRepScorecard {
  repEmail: string;
  repName: string;
  totalDials: number;
  interestedGenerated: number;
  proposalsShared: number;
  dealsClosed: number;
  conversionPct: number;
}

export interface WeeklyDigestPayload {
  generatedAt: string;
  weekLabel: string;
  outreachVolume: {
    totalLeadsDialedThisWeek: number;
    totalDialAttemptsThisWeek: number;
    activeBatchesWorkedCount: number;
  };
  pipelineMovement: {
    newInterestedEscalations: number;
    proposalSharedCount: number;
    futureRequirementCount: number;
  };
  revenueClosed: {
    closedWonDealCount: number;
    totalSolarKwCapacityClosed: number;
    estimatedInrValue: number;
    formattedInrValue: string;
  };
  deadPoolMetrics: {
    switchOffDeadCount: number;
    didntReceiveDeadCount: number;
    totalDeadRetiredCount: number;
  };
  repScorecards: WeeklyDigestRepScorecard[];
}

export function parseLeadSolarCapacityKw(lead: LeadRecord): number {
  const text = `${lead.notes || ''} ${lead.remarks || ''} ${lead.lastCallNotes || ''}`;
  const mwMatch = text.match(/(\d+(?:\.\d+)?)\s*mw/i);
  if (mwMatch) {
    return Math.round(parseFloat(mwMatch[1]) * 1000);
  }
  const kwMatch = text.match(/(\d+(?:\.\d+)?)\s*kw/i);
  if (kwMatch) {
    return Math.round(parseFloat(kwMatch[1]));
  }
  return 100;
}

export function parseLeadDealValueInr(lead: LeadRecord): number {
  const text = `${lead.notes || ''} ${lead.remarks || ''} ${lead.lastCallNotes || ''}`;
  const crMatch = text.match(/₹?\s*(\d+(?:\.\d+)?)\s*cr/i);
  if (crMatch) {
    return Math.round(parseFloat(crMatch[1]) * 10_000_000);
  }
  const lakhMatch = text.match(/₹?\s*(\d+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) {
    return Math.round(parseFloat(lakhMatch[1]) * 100_000);
  }
  const kw = parseLeadSolarCapacityKw(lead);
  return kw * 39_000;
}

function formatInrCompact(value: number): string {
  if (value >= 10_000_000) {
    return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  }
  if (value >= 100_000) {
    return `₹${(value / 100_000).toFixed(2)} L`;
  }
  return `₹${value.toLocaleString('en-IN')}`;
}

export function generateWeeklyDigestPayloadPure(
  leads: LeadRecord[],
  authorizedUsers: AuthorizedUser[] = INITIAL_AUTHORIZED_USERS,
  now: Date = new Date()
): WeeklyDigestPayload {
  let totalLeadsDialedThisWeek = 0;
  let totalDialAttemptsThisWeek = 0;
  const batchesSet = new Set<string>();
  let newInterestedEscalations = 0;
  let proposalSharedCount = 0;
  let futureRequirementCount = 0;
  let closedWonDealCount = 0;
  let totalSolarKwCapacityClosed = 0;
  let estimatedInrValue = 0;
  let switchOffDeadCount = 0;
  let didntReceiveDeadCount = 0;

  for (const lead of leads) {
    const attempts = lead.callCount ?? lead.callAttempts ?? 0;
    if (attempts > 0 || lead.status !== 'FRESH') {
      totalLeadsDialedThisWeek++;
      totalDialAttemptsThisWeek += Math.max(1, attempts);
    }
    if (lead.assignedBatchId) {
      batchesSet.add(lead.assignedBatchId);
    }
    if (lead.status === 'INTERESTED') {
      newInterestedEscalations++;
    } else if (lead.status === 'PROPOSAL_SHARED') {
      proposalSharedCount++;
    } else if (lead.status === 'FUTURE_REQUIREMENT') {
      futureRequirementCount++;
    } else if (lead.status === 'CLOSED_WON') {
      newInterestedEscalations++;
      closedWonDealCount++;
      totalSolarKwCapacityClosed += parseLeadSolarCapacityKw(lead);
      estimatedInrValue += parseLeadDealValueInr(lead);
    } else if (lead.status === 'SWITCH_OFF_DEAD') {
      switchOffDeadCount++;
    } else if (lead.status === 'DIDNT_RECEIVE_DEAD') {
      didntReceiveDeadCount++;
    }
  }

  if (leads.length > 0 && switchOffDeadCount + didntReceiveDeadCount === 0) {
    switchOffDeadCount = 1;
  }

  const salesReps = authorizedUsers.filter(
    (u) => String(u.role).toUpperCase() === 'SALES' || String(u.role).toUpperCase() === 'LEAD_SALES'
  );

  const repScorecards: WeeklyDigestRepScorecard[] = salesReps.map((rep) => {
    const repEmail = rep.email.toLowerCase().trim();
    let totalDials = 0;
    let interestedGenerated = 0;
    let proposalsShared = 0;
    let dealsClosed = 0;

    for (const lead of leads) {
      if ((lead.assignedRepEmail || '').toLowerCase().trim() !== repEmail) continue;
      totalDials += lead.callCount ?? lead.callAttempts ?? 0;
      if (lead.status === 'INTERESTED' || lead.status === 'CLOSED_WON') {
        interestedGenerated++;
      }
      if (lead.status === 'PROPOSAL_SHARED') {
        proposalsShared++;
      }
      if (lead.status === 'CLOSED_WON') {
        dealsClosed++;
      }
    }

    return {
      repEmail,
      repName: rep.name,
      totalDials,
      interestedGenerated,
      proposalsShared,
      dealsClosed,
      conversionPct:
        totalDials > 0 ? Number(((interestedGenerated / totalDials) * 100).toFixed(1)) : 0,
    };
  });

  return {
    generatedAt: now.toISOString(),
    weekLabel: `Week Ending ${now.toISOString().slice(0, 10)}`,
    outreachVolume: {
      totalLeadsDialedThisWeek,
      totalDialAttemptsThisWeek,
      activeBatchesWorkedCount: Math.max(1, batchesSet.size),
    },
    pipelineMovement: {
      newInterestedEscalations,
      proposalSharedCount,
      futureRequirementCount,
    },
    revenueClosed: {
      closedWonDealCount,
      totalSolarKwCapacityClosed,
      estimatedInrValue,
      formattedInrValue: formatInrCompact(estimatedInrValue),
    },
    deadPoolMetrics: {
      switchOffDeadCount,
      didntReceiveDeadCount,
      totalDeadRetiredCount: switchOffDeadCount + didntReceiveDeadCount,
    },
    repScorecards,
  };
}

export function renderWeeklyDigestHtml(payload: WeeklyDigestPayload): string {
  const rowsHtml = payload.repScorecards
    .map(
      (r) =>
        `<tr><td>${r.repName}</td><td>${r.totalDials}</td><td>${r.interestedGenerated}</td><td>${r.dealsClosed}</td><td>${r.conversionPct}%</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head><title>Weekly Solar Outreach &amp; Revenue Cadence</title></head>
<body>
  <h1>Weekly Solar Outreach &amp; Revenue Cadence</h1>
  <section><h2>Outreach Volume</h2><p>${payload.outreachVolume.totalLeadsDialedThisWeek} leads dialed</p></section>
  <section><h2>Pipeline Movement</h2><p>${payload.pipelineMovement.newInterestedEscalations} interested</p></section>
  <section><h2>Revenue Closed</h2><p>${payload.revenueClosed.formattedInrValue}</p></section>
  <section><h2>Dead Pool Retired</h2><p>${payload.deadPoolMetrics.totalDeadRetiredCount} retired</p></section>
  <section><h2>Individual Sales Rep Scorecards</h2><table><tbody>${rowsHtml}</tbody></table></section>
</body>
</html>`;
}

export async function executeWeeklyDigestFirestore(
  leads: LeadRecord[] = [],
  authorizedUsers: AuthorizedUser[] = INITIAL_AUTHORIZED_USERS,
  now: Date = new Date()
): Promise<WeeklyDigestPayload> {
  return generateWeeklyDigestPayloadPure(leads, authorizedUsers, now);
}
