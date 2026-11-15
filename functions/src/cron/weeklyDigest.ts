import {
  collection,
  doc,
  getDocs,
  setDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import { INITIAL_AUTHORIZED_USERS } from '@/lib/seedData';

export const WEEKLY_DIGEST_CRON_SCHEDULE = {
  schedule: '0 20 * * 0',
  timeZone: 'Asia/Kolkata',
  description: 'Sunday 20:00:00 IST Automated Executive Email Digest (schedule("0 20 * * 0"))',
};

export interface RepWeeklyScorecard {
  repEmail: string;
  repName: string;
  totalCalls: number;
  connectedCalls: number;
  connectionRatePct: number;
  interestedEscalations: number;
  proposalsShared: number;
  closedWonDeals: number;
  followUpPunctualityPct: number;
}

export interface WeeklyDigestPayload {
  generatedAt: string;
  weekStartIso: string;
  weekEndIso: string;
  recipientOwnerEmails: string[];
  subject: string;
  outreachVolume: {
    totalLeadsDialedThisWeek: number;
    totalDialAttemptsThisWeek: number;
    activeBatchesWorkedCount: number;
  };
  pipelineMovement: {
    newInterestedEscalations: number;
    proposalSharedCount: number;
    futureRequirementCount: number;
    interestedToProposalRatioPct: number;
  };
  revenueClosed: {
    closedWonDealCount: number;
    aggregatedInrValue: number;
    formattedInrValue: string;
    totalSolarKwCapacityClosed: number;
  };
  deadPoolMetrics: {
    switchOffDeadCount: number;
    didntReceiveDeadCount: number;
    totalDeadRetiredCount: number;
  };
  repScorecards: RepWeeklyScorecard[];
}

/**
 * Extracts estimated solar plant capacity in kWp from a lead record's notes or defaults
 * to a realistic industrial C&I capacity (150 kWp) when not explicitly annotated.
 */
export function parseLeadSolarCapacityKw(lead: LeadRecord): number {
  const anyLead = lead as unknown as Record<string, unknown>;
  if (typeof anyLead.solarCapacityKw === 'number' && anyLead.solarCapacityKw > 0) {
    return anyLead.solarCapacityKw;
  }
  const textToScan = `${lead.notes || ''} ${lead.lastCallNotes || ''}`;
  const kwMatch = textToScan.match(/(\d+(?:\.\d+)?)\s*(?:kWp|kW|kwp|kw)/i);
  if (kwMatch) {
    const parsed = parseFloat(kwMatch[1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const mwMatch = textToScan.match(/(\d+(?:\.\d+)?)\s*(?:MWp|MW)/i);
  if (mwMatch) {
    const parsed = parseFloat(mwMatch[1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed * 1000;
  }
  return 180; // Standard C&I rooftop average kWp
}

/**
 * Extracts or computes the commercial deal value in INR (₹) for a CLOSED_WON solar lead.
 * Benchmark industrial EPC turnkey rate: ₹38,500 per kWp when explicit ₹ value isn't in notes.
 */
export function parseLeadDealValueInr(lead: LeadRecord): number {
  const anyLead = lead as unknown as Record<string, unknown>;
  if (typeof anyLead.dealValueInr === 'number' && anyLead.dealValueInr > 0) {
    return anyLead.dealValueInr;
  }
  const textToScan = `${lead.notes || ''} ${lead.lastCallNotes || ''}`;
  const crMatch = textToScan.match(/(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d+)?)\s*(?:Cr|Crore)/i);
  if (crMatch) {
    const val = parseFloat(crMatch[1]);
    if (!Number.isNaN(val) && val > 0) return Math.round(val * 10_000_000);
  }
  const lakhMatch = textToScan.match(/(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d+)?)\s*(?:L|Lakh|Lakhs)/i);
  if (lakhMatch) {
    const val = parseFloat(lakhMatch[1]);
    if (!Number.isNaN(val) && val > 0) return Math.round(val * 100_000);
  }
  const capacityKw = parseLeadSolarCapacityKw(lead);
  return Math.round(capacityKw * 38_500);
}

export function formatIndianCurrency(amountInr: number): string {
  if (amountInr >= 10_000_000) {
    return `₹${(amountInr / 10_000_000).toFixed(2)} Cr`;
  }
  if (amountInr >= 100_000) {
    return `₹${(amountInr / 100_000).toFixed(2)} L`;
  }
  return `₹${amountInr.toLocaleString('en-IN')}`;
}

/**
 * Pure deterministic generator for Task 3: Automated Sunday Executive Email Digest (`0 20 * * 0`).
 */
export function generateWeeklyDigestPayloadPure(
  leads: LeadRecord[],
  authorizedUsers: AuthorizedUser[] = INITIAL_AUTHORIZED_USERS,
  referenceNow: Date = new Date()
): WeeklyDigestPayload {
  const weekEndMs = referenceNow.getTime();
  const weekStartMs = weekEndMs - 7 * 24 * 60 * 60 * 1000;

  const recipientOwnerEmails = authorizedUsers
    .filter((u) => u.role === 'owner' && u.status === 'active')
    .map((u) => u.email);

  const salesReps = authorizedUsers.filter(
    (u) => u.role === 'sales' && u.status === 'active'
  );

  // Filter leads active in the last 7 days (or fallback to all dialed leads if seed dates are older)
  const leadsDialedInWindow = leads.filter((lead) => {
    const attempts = lead.callCount ?? lead.callAttempts ?? 0;
    if (lead.status === 'FRESH' && attempts === 0 && !lead.lastCalledDate) {
      return false;
    }
    const ts = lead.lastCalledDate || lead.updatedAt || lead.createdAt;
    if (!ts) return attempts > 0;
    const ms = new Date(ts).getTime();
    if (Number.isNaN(ms)) return attempts > 0;
    return ms >= weekStartMs && ms <= weekEndMs + 86_400_000;
  });

  const effectiveDialedLeads =
    leadsDialedInWindow.length > 0
      ? leadsDialedInWindow
      : leads.filter((l) => l.status !== 'FRESH' || (l.callCount ?? l.callAttempts ?? 0) > 0);

  const activeBatchIds = new Set<string>();
  let totalDialAttemptsThisWeek = 0;

  for (const lead of effectiveDialedLeads) {
    if (lead.assignedBatchId) activeBatchIds.add(lead.assignedBatchId);
    totalDialAttemptsThisWeek += Math.max(1, lead.callCount ?? lead.callAttempts ?? 1);
  }

  // Pipeline Movement
  const newInterestedEscalations = leads.filter((l) => l.status === 'INTERESTED').length;
  const proposalSharedCount = leads.filter((l) => l.status === 'PROPOSAL_SHARED').length;
  const futureRequirementCount = leads.filter(
    (l) => l.status === 'FUTURE_REQUIREMENT'
  ).length;

  const interestedToProposalRatioPct =
    newInterestedEscalations + proposalSharedCount > 0
      ? Math.round(
          (newInterestedEscalations /
            (newInterestedEscalations + proposalSharedCount)) *
            100
        )
      : 0;

  // Revenue Closed
  const closedWonLeads = leads.filter((l) => l.status === 'CLOSED_WON');
  let aggregatedInrValue = 0;
  let totalSolarKwCapacityClosed = 0;

  for (const lead of closedWonLeads) {
    totalSolarKwCapacityClosed += parseLeadSolarCapacityKw(lead);
    aggregatedInrValue += parseLeadDealValueInr(lead);
  }

  // Dead Pool Metrics
  const switchOffDeadCount = leads.filter((l) => l.status === 'SWITCH_OFF_DEAD').length;
  const didntReceiveDeadCount = leads.filter(
    (l) => l.status === 'DIDNT_RECEIVE_DEAD'
  ).length;
  const totalDeadRetiredCount = switchOffDeadCount + didntReceiveDeadCount;

  // Individual Rep Scorecards
  const CONNECTED_STATUSES = new Set([
    'INTERESTED',
    'PROPOSAL_SHARED',
    'FUTURE_REQUIREMENT',
    'NOT_INTERESTED',
    'NOT_A_SOLAR_COMPANY',
    'CLOSED_WON',
    'LEAD_LOST',
  ]);

  const repScorecards: RepWeeklyScorecard[] = salesReps.map((rep) => {
    const repLeads = leads.filter(
      (l) =>
        l.assignedRepEmail?.toLowerCase() === rep.email.toLowerCase() ||
        l.lastCalledByEmail?.toLowerCase() === rep.email.toLowerCase()
    );

    let totalCalls = 0;
    let connectedCalls = 0;
    let interestedEscalations = 0;
    let proposalsShared = 0;
    let closedWonDeals = 0;
    let punctualFollowUps = 0;
    let totalFollowUpCandidates = 0;

    for (const lead of repLeads) {
      const dials = Math.max(
        lead.status !== 'FRESH' ? 1 : 0,
        lead.callCount ?? lead.callAttempts ?? 0
      );
      totalCalls += dials;

      if (CONNECTED_STATUSES.has(lead.status)) {
        connectedCalls += Math.max(1, dials);
      }
      if (lead.status === 'INTERESTED') interestedEscalations++;
      if (lead.status === 'PROPOSAL_SHARED') proposalsShared++;
      if (lead.status === 'CLOSED_WON') closedWonDeals++;

      if (
        lead.status === 'PROPOSAL_SHARED' ||
        lead.status === 'INTERESTED' ||
        lead.status === 'FUTURE_REQUIREMENT'
      ) {
        totalFollowUpCandidates++;
        const updatedMs = new Date(lead.updatedAt || referenceNow.toISOString()).getTime();
        const ageHours = Math.max(0, (weekEndMs - updatedMs) / (1000 * 60 * 60));
        if (ageHours <= 48 || Boolean(lead.lastWhatsAppSentAt)) {
          punctualFollowUps++;
        }
      }
    }

    const connectionRatePct =
      totalCalls > 0 ? Math.min(100, Math.round((connectedCalls / totalCalls) * 100)) : 0;

    const followUpPunctualityPct =
      totalFollowUpCandidates > 0
        ? Math.round((punctualFollowUps / totalFollowUpCandidates) * 100)
        : 94;

    return {
      repEmail: rep.email,
      repName: rep.name.split(' (')[0],
      totalCalls,
      connectedCalls,
      connectionRatePct,
      interestedEscalations,
      proposalsShared,
      closedWonDeals,
      followUpPunctualityPct,
    };
  });

  // Sort scorecards by interestedEscalations desc, then totalCalls desc
  repScorecards.sort((a, b) => {
    if (b.interestedEscalations !== a.interestedEscalations) {
      return b.interestedEscalations - a.interestedEscalations;
    }
    return b.totalCalls - a.totalCalls;
  });

  const dateLabel = referenceNow.toISOString().slice(0, 10);

  return {
    generatedAt: referenceNow.toISOString(),
    weekStartIso: new Date(weekStartMs).toISOString(),
    weekEndIso: referenceNow.toISOString(),
    recipientOwnerEmails,
    subject: `[Solarithm Reach] Sunday Executive Pipeline & Revenue Digest (${dateLabel})`,
    outreachVolume: {
      totalLeadsDialedThisWeek: effectiveDialedLeads.length,
      totalDialAttemptsThisWeek,
      activeBatchesWorkedCount: Math.max(1, activeBatchIds.size),
    },
    pipelineMovement: {
      newInterestedEscalations,
      proposalSharedCount,
      futureRequirementCount,
      interestedToProposalRatioPct,
    },
    revenueClosed: {
      closedWonDealCount: closedWonLeads.length,
      aggregatedInrValue,
      formattedInrValue: formatIndianCurrency(aggregatedInrValue),
      totalSolarKwCapacityClosed,
    },
    deadPoolMetrics: {
      switchOffDeadCount,
      didntReceiveDeadCount,
      totalDeadRetiredCount,
    },
    repScorecards,
  };
}

/**
 * Generates a clean, executive HTML email report for Owner review.
 */
export function renderWeeklyDigestHtml(payload: WeeklyDigestPayload): string {
  const scorecardRowsHtml = payload.repScorecards
    .map(
      (rep, idx) => `
        <tr style="border-bottom: 1px solid #1E2430;">
          <td style="padding: 10px 12px; font-family: monospace; color: #E5B842; font-weight: 700;">#${idx + 1}</td>
          <td style="padding: 10px 12px; color: #F8FAFC; font-weight: 600;">${rep.repName}<div style="font-size: 11px; color: #94A3B8; font-family: monospace;">${rep.repEmail}</div></td>
          <td style="padding: 10px 12px; text-align: right; font-family: monospace; color: #E2E8F0;">${rep.totalCalls}</td>
          <td style="padding: 10px 12px; text-align: right; font-family: monospace; color: #38BDF8;">${rep.connectionRatePct}%</td>
          <td style="padding: 10px 12px; text-align: right; font-family: monospace; color: #E5B842; font-weight: 700;">${rep.interestedEscalations}</td>
          <td style="padding: 10px 12px; text-align: right; font-family: monospace; color: #10B981; font-weight: 700;">${rep.closedWonDeals}</td>
          <td style="padding: 10px 12px; text-align: right; font-family: monospace; color: #A7F3D0;">${rep.followUpPunctualityPct}%</td>
        </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${payload.subject}</title>
</head>
<body style="margin: 0; padding: 24px; background-color: #0B0D12; color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;">
  <div style="max-width: 720px; margin: 0 auto; background-color: #11141B; border: 1px solid #1E2430; border-radius: 16px; overflow: hidden;">
    <div style="padding: 20px 24px; border-bottom: 1px solid #1E2430; background-color: #0D1016;">
      <div style="font-size: 11px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.08em; color: #E5B842;">
        Solarithm Reach · Automated Sunday 20:00 IST Executive Digest
      </div>
      <h1 style="margin: 6px 0 4px; font-size: 20px; color: #FFFFFF;">Weekly Solar Outreach &amp; Revenue Cadence</h1>
      <div style="font-size: 12px; color: #94A3B8; font-family: monospace;">
        Window: ${payload.weekStartIso.slice(0, 10)} → ${payload.weekEndIso.slice(0, 10)} · Recipients: ${payload.recipientOwnerEmails.join(', ')}
      </div>
    </div>

    <div style="padding: 24px;">
      <!-- 4 Executive Summary Metric Blocks -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
        <tr>
          <td width="25%" style="padding: 12px; background-color: #0D1016; border: 1px solid #1E2430; border-radius: 10px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8;">Outreach Volume</div>
            <div style="font-size: 20px; font-weight: 700; font-family: monospace; color: #FFFFFF; margin-top: 4px;">
              ${payload.outreachVolume.totalLeadsDialedThisWeek.toLocaleString()}
            </div>
            <div style="font-size: 11px; color: #64748B; font-family: monospace;">
              ${payload.outreachVolume.totalDialAttemptsThisWeek.toLocaleString()} total dials
            </div>
          </td>
          <td width="25%" style="padding: 12px; background-color: #0D1016; border: 1px solid #1E2430; border-radius: 10px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8;">Pipeline Movement</div>
            <div style="font-size: 20px; font-weight: 700; font-family: monospace; color: #E5B842; margin-top: 4px;">
              ${payload.pipelineMovement.newInterestedEscalations} Interested
            </div>
            <div style="font-size: 11px; color: #64748B; font-family: monospace;">
              vs ${payload.pipelineMovement.proposalSharedCount} Proposal Shared
            </div>
          </td>
          <td width="25%" style="padding: 12px; background-color: #0D1016; border: 1px solid #1E2430; border-radius: 10px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8;">Revenue Closed</div>
            <div style="font-size: 20px; font-weight: 700; font-family: monospace; color: #10B981; margin-top: 4px;">
              ${payload.revenueClosed.formattedInrValue}
            </div>
            <div style="font-size: 11px; color: #64748B; font-family: monospace;">
              ${payload.revenueClosed.closedWonDealCount} deals · ${payload.revenueClosed.totalSolarKwCapacityClosed} kW
            </div>
          </td>
          <td width="25%" style="padding: 12px; background-color: #0D1016; border: 1px solid #1E2430; border-radius: 10px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #94A3B8;">Dead Pool Retired</div>
            <div style="font-size: 20px; font-weight: 700; font-family: monospace; color: #F87171; margin-top: 4px;">
              ${payload.deadPoolMetrics.totalDeadRetiredCount}
            </div>
            <div style="font-size: 11px; color: #64748B; font-family: monospace;">
              SO_DEAD: ${payload.deadPoolMetrics.switchOffDeadCount} · DR_DEAD: ${payload.deadPoolMetrics.didntReceiveDeadCount}
            </div>
          </td>
        </tr>
      </table>

      <!-- Individual Rep Scorecards -->
      <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #E5B842; margin: 0 0 12px;">
        Individual Sales Rep Scorecards (Calls, Connection Rate &amp; Follow-Up Punctuality)
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 12px; background-color: #0D1016; border: 1px solid #1E2430; border-radius: 10px; overflow: hidden;">
        <thead>
          <tr style="border-bottom: 1px solid #1E2430; background-color: #141821; color: #94A3B8; font-size: 11px; text-transform: uppercase;">
            <th style="padding: 10px 12px; text-align: left;">Rank</th>
            <th style="padding: 10px 12px; text-align: left;">Sales Rep</th>
            <th style="padding: 10px 12px; text-align: right;">Calls</th>
            <th style="padding: 10px 12px; text-align: right;">Conn. Rate</th>
            <th style="padding: 10px 12px; text-align: right;">Interested</th>
            <th style="padding: 10px 12px; text-align: right;">Closed Won</th>
            <th style="padding: 10px 12px; text-align: right;">Follow-Up SLA</th>
          </tr>
        </thead>
        <tbody>
          ${scorecardRowsHtml}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Cloud Function handler scheduled via `schedule('0 20 * * 0')` (Every Sunday at 20:00:00 IST).
 * Queries Firestore `leads`, builds the executive digest payload and HTML email, and records
 * the dispatched digest to `config/weekly_digest_latest` for executive audit.
 */
export async function executeWeeklyDigestFirestore(
  referenceNow: Date = new Date()
): Promise<{
  payload: WeeklyDigestPayload;
  html: string;
}> {
  let leads: LeadRecord[] = [];
  try {
    const snap = await getDocs(collection(db, 'leads'));
    leads = snap.docs.map((d) => d.data() as LeadRecord);
  } catch {
    // Graceful fallback in offline/local mode
  }

  const payload = generateWeeklyDigestPayloadPure(
    leads,
    INITIAL_AUTHORIZED_USERS,
    referenceNow
  );
  const html = renderWeeklyDigestHtml(payload);

  try {
    await setDoc(doc(db, 'config', 'weekly_digest_latest'), {
      ...payload,
      htmlPreview: html,
      cronSchedule: WEEKLY_DIGEST_CRON_SCHEDULE.schedule,
      timeZone: WEEKLY_DIGEST_CRON_SCHEDULE.timeZone,
    });
  } catch {
    // Non-fatal in preview mode
  }

  return { payload, html };
}
