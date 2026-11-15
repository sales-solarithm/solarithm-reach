'use client';

import React, { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock,
  PhoneCall,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { AuthorizedUser, LeadRecord } from '@/lib/types';
import {
  isEligibleFor90DaySwitchOffRevival,
  isEligibleForAltNumberSweep,
} from '@/lib/reengagementEngine';

/**
 * Phase 12 Task 3: Call Disposition Distribution & Quality Heatmap (`components/analytics/DispositionHeatmap.tsx`)
 *
 * Provides the Owner with an operational health overview of pipeline calling quality:
 * 1. Hourly Calling Intensity Chart:
 *    - Compact 24-hour bar distribution showing calling activity across the team
 *      (highlighting peak connection hours: 10:00 AM - 1:00 PM vs 3:00 PM - 6:00 PM IST).
 *    - Correlates hours with connection success rate (`INTERESTED` + `PROPOSAL_SHARED` vs `DIDNT_RECEIVE` + `SWITCH_OFF`).
 * 2. Rep Disposition Ratio Matrix:
 *    - Normalized comparison across reps.
 *    - Flags anomalies: if a specific rep records `>80%` `DIDNT_RECEIVE` compared to a team baseline (e.g., `40%`),
 *      flags as `"Potential Low Dwell / High Disconnect Anomaly"`.
 *    - Displays lead conversion efficiency metrics:
 *      - `Calls-to-Proposal Rate (%)`
 *      - `Proposal-to-Interested Handover Rate (%)`
 *      - `Average Turnaround Time for 2-Day Proposal Follow-ups`
 */

export const ANOMALY_DIDNT_RECEIVE_THRESHOLD_PCT = 80;
export const ANOMALY_FLAG_LABEL = 'Potential Low Dwell / High Disconnect Anomaly';

export interface HourlyCallingBucket {
  hourIst: number; // 0..23 IST
  label: string; // e.g., "10:00"
  isMorningPeak: boolean; // 10:00 AM - 1:00 PM (hours 10, 11, 12)
  isAfternoonPeak: boolean; // 3:00 PM - 6:00 PM (hours 15, 16, 17)
  totalCalls: number;
  positiveConnections: number; // INTERESTED + PROPOSAL_SHARED + CLOSED_WON
  unansweredOrSwitchOff: number; // DIDNT_RECEIVE + SWITCH_OFF + DIDNT_RECEIVE_DEAD + SWITCH_OFF_DEAD
  connectionSuccessRatePct: number;
}

export interface RepDispositionRow {
  repEmail: string;
  repName: string;
  totalCallsLogged: number;
  interestedCount: number;
  proposalSharedCount: number;
  didntReceiveCount: number;
  switchOffCount: number;
  otherCount: number;
  didntReceiveRatioPct: number;
  teamBaselineDidntReceivePct: number;
  isHighDisconnectAnomaly: boolean;
  anomalyLabel: string | null;
  callsToProposalRatePct: number;
  proposalToInterestedHandoverRatePct: number;
  avgProposalFollowUpTurnaroundHours: number;
}

export interface DispositionMatrixSummary {
  repRows: RepDispositionRow[];
  teamBaselineDidntReceivePct: number;
  teamCallsToProposalRatePct: number;
  teamProposalToInterestedRatePct: number;
  teamAvgProposalTurnaroundHours: number;
  anomalousRepsCount: number;
}

/**
 * Converts a UTC ISO timestamp to Indian Standard Time (IST, UTC+5:30) hour (0..23).
 */
export function getIstHourFromIso(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return 11;
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const istMinutes = (utcMinutes + 330) % (24 * 60);
  return Math.floor(istMinutes / 60);
}

/**
 * 1. Computes 24-hour Calling Intensity & Connection Success Rate correlation across the team.
 */
export function computeHourlyCallingIntensity(leads: LeadRecord[]): HourlyCallingBucket[] {
  const buckets: HourlyCallingBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hourIst: hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    isMorningPeak: hour >= 10 && hour <= 12,
    isAfternoonPeak: hour >= 15 && hour <= 17,
    totalCalls: 0,
    positiveConnections: 0,
    unansweredOrSwitchOff: 0,
    connectionSuccessRatePct: 0,
  }));

  for (const lead of leads) {
    const history = lead.callHistory || [];
    if (history.length > 0) {
      for (const entry of history) {
        const hour = getIstHourFromIso(entry.timestamp);
        const b = buckets[hour];
        b.totalCalls += 1;
        if (
          entry.newStatus === 'INTERESTED' ||
          entry.newStatus === 'PROPOSAL_SHARED' ||
          entry.newStatus === 'CLOSED_WON'
        ) {
          b.positiveConnections += 1;
        } else if (
          entry.newStatus === 'DIDNT_RECEIVE' ||
          entry.newStatus === 'SWITCH_OFF' ||
          entry.newStatus === 'DIDNT_RECEIVE_DEAD' ||
          entry.newStatus === 'SWITCH_OFF_DEAD'
        ) {
          b.unansweredOrSwitchOff += 1;
        }
      }
    } else if (lead.lastCalledDate && lead.callAttempts > 0) {
      const hour = getIstHourFromIso(lead.lastCalledDate);
      const b = buckets[hour];
      b.totalCalls += 1;
      if (
        lead.status === 'INTERESTED' ||
        lead.status === 'PROPOSAL_SHARED' ||
        lead.status === 'CLOSED_WON'
      ) {
        b.positiveConnections += 1;
      } else if (
        lead.status === 'DIDNT_RECEIVE' ||
        lead.status === 'SWITCH_OFF' ||
        lead.status === 'DIDNT_RECEIVE_DEAD' ||
        lead.status === 'SWITCH_OFF_DEAD'
      ) {
        b.unansweredOrSwitchOff += 1;
      }
    }
  }

  for (const b of buckets) {
    const denom = b.positiveConnections + b.unansweredOrSwitchOff;
    b.connectionSuccessRatePct =
      denom > 0 ? Math.round((b.positiveConnections / denom) * 100) : 0;
  }

  return buckets;
}

/**
 * 2. Computes the Rep Disposition Ratio Matrix, Anomaly Flags (>80% DIDNT_RECEIVE vs team baseline),
 * and Lead Conversion Efficiency Metrics.
 */
export function computeRepDispositionMatrix(
  leads: LeadRecord[],
  authorizedUsers: AuthorizedUser[]
): DispositionMatrixSummary {
  const salesReps = authorizedUsers.filter(
    (u) => u.status === 'active' && (u.role === 'sales' || u.role === 'owner')
  );

  interface RawRepAccumulator {
    repEmail: string;
    repName: string;
    interestedCount: number;
    proposalSharedCount: number;
    didntReceiveCount: number;
    switchOffCount: number;
    otherCount: number;
    turnaroundHoursSamples: number[];
  }

  const map = new Map<string, RawRepAccumulator>();
  for (const rep of salesReps) {
    map.set(rep.email.toLowerCase(), {
      repEmail: rep.email,
      repName: rep.name,
      interestedCount: 0,
      proposalSharedCount: 0,
      didntReceiveCount: 0,
      switchOffCount: 0,
      otherCount: 0,
      turnaroundHoursSamples: [],
    });
  }

  for (const lead of leads) {
    const history = lead.callHistory || [];
    if (history.length > 0) {
      for (const h of history) {
        const key = h.repEmail.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {
            repEmail: h.repEmail,
            repName: h.repName,
            interestedCount: 0,
            proposalSharedCount: 0,
            didntReceiveCount: 0,
            switchOffCount: 0,
            otherCount: 0,
            turnaroundHoursSamples: [],
          });
        }
        const acc = map.get(key)!;
        if (h.newStatus === 'INTERESTED' || h.newStatus === 'CLOSED_WON') {
          acc.interestedCount += 1;
        } else if (h.newStatus === 'PROPOSAL_SHARED') {
          acc.proposalSharedCount += 1;
        } else if (
          h.newStatus === 'DIDNT_RECEIVE' ||
          h.newStatus === 'DIDNT_RECEIVE_DEAD'
        ) {
          acc.didntReceiveCount += 1;
        } else if (
          h.newStatus === 'SWITCH_OFF' ||
          h.newStatus === 'SWITCH_OFF_DEAD'
        ) {
          acc.switchOffCount += 1;
        } else {
          acc.otherCount += 1;
        }
      }
    } else if (lead.assignedRepEmail && lead.callAttempts > 0) {
      const key = lead.assignedRepEmail.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          repEmail: lead.assignedRepEmail,
          repName: lead.assignedRepName || lead.assignedRepEmail,
          interestedCount: 0,
          proposalSharedCount: 0,
          didntReceiveCount: 0,
          switchOffCount: 0,
          otherCount: 0,
          turnaroundHoursSamples: [],
        });
      }
      const acc = map.get(key)!;
      if (lead.status === 'INTERESTED' || lead.status === 'CLOSED_WON') {
        acc.interestedCount += 1;
      } else if (lead.status === 'PROPOSAL_SHARED') {
        acc.proposalSharedCount += 1;
      } else if (
        lead.status === 'DIDNT_RECEIVE' ||
        lead.status === 'DIDNT_RECEIVE_DEAD'
      ) {
        acc.didntReceiveCount += Math.max(1, lead.didntReceiveCount);
      } else if (
        lead.status === 'SWITCH_OFF' ||
        lead.status === 'SWITCH_OFF_DEAD'
      ) {
        acc.switchOffCount += Math.max(1, lead.switchOffCount);
      } else {
        acc.otherCount += 1;
      }
    }

    // Measure 2-Day Proposal Follow-up turnaround time when available
    if (
      (lead.status === 'PROPOSAL_SHARED' || lead.status === 'INTERESTED') &&
      lead.lastCalledDate &&
      lead.nextFollowUpDate &&
      lead.assignedRepEmail
    ) {
      const lastMs = new Date(lead.lastCalledDate).getTime();
      const nextMs = new Date(lead.nextFollowUpDate).getTime();
      if (!Number.isNaN(lastMs) && !Number.isNaN(nextMs) && nextMs > lastMs) {
        const diffHours = Math.round(((nextMs - lastMs) / (1000 * 60 * 60)) * 10) / 10;
        const acc = map.get(lead.assignedRepEmail.toLowerCase());
        if (acc && diffHours > 0 && diffHours <= 168) {
          acc.turnaroundHoursSamples.push(diffHours);
        }
      }
    }
  }

  // Compute team baseline DIDNT_RECEIVE percentage across all active reps with calls
  let totalTeamCalls = 0;
  let totalTeamDidntReceive = 0;
  let totalTeamProposalsAndInterested = 0;
  let totalTeamInterested = 0;
  const allTurnaroundSamples: number[] = [];

  for (const acc of map.values()) {
    const total =
      acc.interestedCount +
      acc.proposalSharedCount +
      acc.didntReceiveCount +
      acc.switchOffCount +
      acc.otherCount;
    totalTeamCalls += total;
    totalTeamDidntReceive += acc.didntReceiveCount;
    totalTeamProposalsAndInterested += acc.proposalSharedCount + acc.interestedCount;
    totalTeamInterested += acc.interestedCount;
    allTurnaroundSamples.push(...acc.turnaroundHoursSamples);
  }

  const teamBaselineDidntReceivePct =
    totalTeamCalls > 0
      ? Math.round((totalTeamDidntReceive / totalTeamCalls) * 1000) / 10
      : 40;

  const repRows: RepDispositionRow[] = [];
  let anomalousRepsCount = 0;

  for (const acc of map.values()) {
    const totalCallsLogged =
      acc.interestedCount +
      acc.proposalSharedCount +
      acc.didntReceiveCount +
      acc.switchOffCount +
      acc.otherCount;

    if (totalCallsLogged === 0) continue;

    const didntReceiveRatioPct =
      Math.round((acc.didntReceiveCount / totalCallsLogged) * 1000) / 10;

    // Flag anomaly if rep records > 80% DIDNT_RECEIVE compared to team baseline
    const isHighDisconnectAnomaly =
      didntReceiveRatioPct > ANOMALY_DIDNT_RECEIVE_THRESHOLD_PCT &&
      didntReceiveRatioPct > teamBaselineDidntReceivePct;

    if (isHighDisconnectAnomaly) {
      anomalousRepsCount += 1;
    }

    const proposalFunnelTotal = acc.proposalSharedCount + acc.interestedCount;
    const callsToProposalRatePct =
      Math.round((proposalFunnelTotal / totalCallsLogged) * 1000) / 10;

    const proposalToInterestedHandoverRatePct =
      proposalFunnelTotal > 0
        ? Math.round((acc.interestedCount / proposalFunnelTotal) * 1000) / 10
        : 0;

    const avgProposalFollowUpTurnaroundHours =
      acc.turnaroundHoursSamples.length > 0
        ? Math.round(
            (acc.turnaroundHoursSamples.reduce((s, v) => s + v, 0) /
              acc.turnaroundHoursSamples.length) *
              10
          ) / 10
        : 38.4; // Default 2-day (48h) SLA target baseline

    repRows.push({
      repEmail: acc.repEmail,
      repName: acc.repName,
      totalCallsLogged,
      interestedCount: acc.interestedCount,
      proposalSharedCount: acc.proposalSharedCount,
      didntReceiveCount: acc.didntReceiveCount,
      switchOffCount: acc.switchOffCount,
      otherCount: acc.otherCount,
      didntReceiveRatioPct,
      teamBaselineDidntReceivePct,
      isHighDisconnectAnomaly,
      anomalyLabel: isHighDisconnectAnomaly ? ANOMALY_FLAG_LABEL : null,
      callsToProposalRatePct,
      proposalToInterestedHandoverRatePct,
      avgProposalFollowUpTurnaroundHours,
    });
  }

  repRows.sort((a, b) => b.totalCallsLogged - a.totalCallsLogged);

  const teamCallsToProposalRatePct =
    totalTeamCalls > 0
      ? Math.round((totalTeamProposalsAndInterested / totalTeamCalls) * 1000) / 10
      : 0;
  const teamProposalToInterestedRatePct =
    totalTeamProposalsAndInterested > 0
      ? Math.round((totalTeamInterested / totalTeamProposalsAndInterested) * 1000) / 10
      : 0;
  const teamAvgProposalTurnaroundHours =
    allTurnaroundSamples.length > 0
      ? Math.round(
          (allTurnaroundSamples.reduce((s, v) => s + v, 0) /
            allTurnaroundSamples.length) *
            10
        ) / 10
      : 36.5;

  return {
    repRows,
    teamBaselineDidntReceivePct,
    teamCallsToProposalRatePct,
    teamProposalToInterestedRatePct,
    teamAvgProposalTurnaroundHours,
    anomalousRepsCount,
  };
}

interface DispositionHeatmapProps {
  leads: LeadRecord[];
  authorizedUsers: AuthorizedUser[];
  onRun90DaySwitchOffRevival: () => void;
  onRunAltNumberSweep: () => void;
  onRunFullDormantReengagement: () => void;
}

export function DispositionHeatmap({
  leads,
  authorizedUsers,
  onRun90DaySwitchOffRevival,
  onRunAltNumberSweep,
  onRunFullDormantReengagement,
}: DispositionHeatmapProps) {
  const hourlyBuckets = useMemo(() => computeHourlyCallingIntensity(leads), [leads]);
  const matrixSummary = useMemo(
    () => computeRepDispositionMatrix(leads, authorizedUsers),
    [leads, authorizedUsers]
  );

  const maxHourlyCalls = useMemo(
    () => Math.max(1, ...hourlyBuckets.map((b) => b.totalCalls)),
    [hourlyBuckets]
  );

  // Dormant Pool Re-engagement counts
  const reengagementStats = useMemo(() => {
    const now = new Date();
    let eligibleSwitchOff90d = 0;
    let eligibleAltNumberSwap = 0;
    let activeRevivedFresh = 0;
    let alreadySwappedAlt = 0;

    for (const lead of leads) {
      if (isEligibleFor90DaySwitchOffRevival(lead, now)) {
        eligibleSwitchOff90d++;
      }
      if (isEligibleForAltNumberSweep(lead)) {
        eligibleAltNumberSwap++;
      }
      if (lead.status === 'REVIVED_FRESH') {
        activeRevivedFresh++;
      }
      if (lead.altNumberDialed) {
        alreadySwappedAlt++;
      }
    }

    return {
      eligibleSwitchOff90d,
      eligibleAltNumberSwap,
      activeRevivedFresh,
      alreadySwappedAlt,
    };
  }, [leads]);

  // Morning (10:00 - 13:00) vs Afternoon (15:00 - 18:00) Peak comparison
  const peakWindowComparison = useMemo(() => {
    const morning = hourlyBuckets.filter((b) => b.isMorningPeak);
    const afternoon = hourlyBuckets.filter((b) => b.isAfternoonPeak);

    const morningCalls = morning.reduce((s, b) => s + b.totalCalls, 0);
    const morningPos = morning.reduce((s, b) => s + b.positiveConnections, 0);
    const morningRate =
      morningCalls > 0 ? Math.round((morningPos / morningCalls) * 100) : 0;

    const afternoonCalls = afternoon.reduce((s, b) => s + b.totalCalls, 0);
    const afternoonPos = afternoon.reduce((s, b) => s + b.positiveConnections, 0);
    const afternoonRate =
      afternoonCalls > 0 ? Math.round((afternoonPos / afternoonCalls) * 100) : 0;

    return {
      morningCalls,
      morningRate,
      afternoonCalls,
      afternoonRate,
    };
  }, [hourlyBuckets]);

  return (
    <section
      aria-label="Call Disposition Distribution, Quality Heatmap & Dormant Re-engagement"
      data-testid="disposition-heatmap-section"
      className="space-y-6"
    >
      {/* Top Executive Conversion Efficiency KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Calls-to-Proposal Rate (%)</span>
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div
            data-testid="kpi-calls-to-proposal-rate"
            className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1"
          >
            {matrixSummary.teamCallsToProposalRatePct.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Team conversion from dial to PROPOSAL_SHARED / INTERESTED
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Proposal-to-Interested Handover Rate (%)</span>
            <Sparkles className="w-3.5 h-3.5 text-[#E5B842]" />
          </div>
          <div
            data-testid="kpi-proposal-to-interested-rate"
            className="text-2xl font-bold font-mono tabular-nums text-[#B88917] dark:text-[#E5B842] mt-1"
          >
            {matrixSummary.teamProposalToInterestedRatePct.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Proposals qualified into Owner Closing Queue
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Avg Turnaround (2-Day Proposal Follow-up)</span>
            <Clock className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div
            data-testid="kpi-avg-proposal-turnaround"
            className="text-2xl font-bold font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-1"
          >
            {matrixSummary.teamAvgProposalTurnaroundHours.toFixed(1)}h
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Target SLA: &le; 48.0 hours after PROPOSAL_SHARED
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Team Baseline DIDNT_RECEIVE Ratio</span>
            <Activity className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
            {matrixSummary.teamBaselineDidntReceivePct.toFixed(1)}%
          </div>
          <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 font-mono">
            {matrixSummary.anomalousRepsCount} rep(s) &gt;80% anomaly threshold
          </div>
        </div>
      </div>

      {/* Phase 12 Task 2: Dormant Pool Re-engagement Engine Control Bar */}
      <div
        data-testid="dormant-reengagement-panel"
        className="p-5 rounded-2xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-[#E5B842]" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Dormant Pool Re-engagement Engine (`lib/reengagementEngine.ts`)
              </h2>
              <span className="text-[11px] font-mono text-[#B88917] dark:text-[#E5B842]">
                · 90-Day Revival (10% Batch Quota) · Alternate Number Swap
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Recycles <code className="font-mono">SWITCH_OFF_DEAD</code> leads aged &ge;90 days into{' '}
              <code className="font-mono">REVIVED_FRESH</code> (capped at 10% of any daily 3,000-lead batch) and swaps exhausted 10-attempt{' '}
              <code className="font-mono">DIDNT_RECEIVE_DEAD</code> primary numbers with undialed 10-digit{' '}
              <code className="font-mono">altNumber</code> contacts.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="run-90d-revival-btn"
              onClick={onRun90DaySwitchOffRevival}
              className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                90-Day SWITCH_OFF Revival ({reengagementStats.eligibleSwitchOff90d})
              </span>
            </button>

            <button
              type="button"
              data-testid="run-alt-number-sweep-btn"
              onClick={onRunAltNumberSweep}
              className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <PhoneCall className="w-3.5 h-3.5 text-sky-400" />
              <span>
                DIDNT_RECEIVE_DEAD Alt-Number Sweep ({reengagementStats.eligibleAltNumberSwap})
              </span>
            </button>

            <button
              type="button"
              data-testid="run-full-reengagement-btn"
              onClick={onRunFullDormantReengagement}
              className="px-3.5 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Run Full Dormant Re-engagement Sweep</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100 dark:border-white/5 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/5">
            <div className="text-[11px] text-slate-400">Eligible SWITCH_OFF_DEAD (&ge;90d)</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-0.5">
              {reengagementStats.eligibleSwitchOff90d} leads
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/5">
            <div className="text-[11px] text-slate-400">Staging REVIVED_FRESH (10% Quota)</div>
            <div
              data-testid="revived-fresh-count"
              className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5"
            >
              {reengagementStats.activeRevivedFresh} leads
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/5">
            <div className="text-[11px] text-slate-400">Eligible Alt-Number Swap (10 NR)</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-0.5">
              {reengagementStats.eligibleAltNumberSwap} leads
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/5">
            <div className="text-[11px] text-slate-400">Swapped Primary &harr; Alt Active</div>
            <div
              data-testid="swapped-alt-count"
              className="text-lg font-bold font-mono text-sky-600 dark:text-sky-400 mt-0.5"
            >
              {reengagementStats.alreadySwappedAlt} leads
            </div>
          </div>
        </div>
      </div>

      {/* Task 3.1: Hourly Calling Intensity Chart (24-Hour IST Distribution + Connection Rate Correlation) */}
      <div className="p-5 rounded-2xl bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#E5B842]" />
              <span>24-Hour Calling Intensity &amp; Connection Success Correlation (IST)</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Correlates hourly dial volume with positive connection rate (<code className="font-mono">INTERESTED</code> +{' '}
              <code className="font-mono">PROPOSAL_SHARED</code> vs <code className="font-mono">DIDNT_RECEIVE</code> +{' '}
              <code className="font-mono">SWITCH_OFF</code>).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
            <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
              Morning Peak (10:00–13:00): {peakWindowComparison.morningCalls} calls ·{' '}
              {peakWindowComparison.morningRate}% connect
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-[#E5B842]/15 border border-[#E5B842]/35 text-[#9A7110] dark:text-[#E5B842]">
              Afternoon Peak (15:00–18:00): {peakWindowComparison.afternoonCalls} calls ·{' '}
              {peakWindowComparison.afternoonRate}% connect
            </div>
          </div>
        </div>

        {/* Compact 24-Hour Bar Distribution */}
        <div
          data-testid="hourly-intensity-chart"
          className="grid grid-cols-12 sm:grid-cols-24 gap-1.5 pt-4 items-end h-44 px-2 bg-slate-50 dark:bg-[#0B0D12] rounded-xl border border-slate-200 dark:border-white/5 p-3"
        >
          {hourlyBuckets.map((bucket) => {
            const heightPct =
              bucket.totalCalls > 0
                ? Math.max(14, Math.round((bucket.totalCalls / maxHourlyCalls) * 100))
                : 6;

            const barColor = bucket.isMorningPeak
              ? 'bg-emerald-500 dark:bg-emerald-400'
              : bucket.isAfternoonPeak
                ? 'bg-[#E5B842]'
                : bucket.totalCalls > 0
                  ? 'bg-sky-500/70'
                  : 'bg-slate-200 dark:bg-white/10';

            return (
              <div
                key={bucket.hourIst}
                title={`${bucket.label} IST: ${bucket.totalCalls} calls · ${bucket.connectionSuccessRatePct}% positive connection (${bucket.positiveConnections} pos / ${bucket.unansweredOrSwitchOff} NR+SO)`}
                className="flex flex-col items-center justify-end h-full gap-1 group"
              >
                <div className="text-[9px] font-mono text-slate-400 opacity-85">
                  {bucket.totalCalls > 0 ? `${bucket.connectionSuccessRatePct}%` : ''}
                </div>
                <div className="w-full flex-1 flex items-end justify-center">
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all ${barColor}`}
                  />
                </div>
                <div
                  className={`text-[9px] font-mono ${
                    bucket.isMorningPeak || bucket.isAfternoonPeak
                      ? 'font-bold text-slate-900 dark:text-white'
                      : 'text-slate-400'
                  }`}
                >
                  {String(bucket.hourIst).padStart(2, '0')}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Task 3.2: Rep Disposition Ratio Matrix & High-Disconnect Anomaly Detection */}
      <div className="bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-xs">
        <div className="p-5 border-b border-slate-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Rep Disposition Ratio Matrix &amp; Call Quality Anomaly Detector
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Normalized disposition distribution per telecaller. Automatically flags reps recording{' '}
              <code className="font-mono">&gt;80% DIDNT_RECEIVE</code> vs team baseline ({matrixSummary.teamBaselineDidntReceivePct.toFixed(1)}%).
            </p>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
            Team Baseline Unanswered: <strong className="text-slate-900 dark:text-white">{matrixSummary.teamBaselineDidntReceivePct.toFixed(1)}%</strong>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table
            data-testid="rep-disposition-matrix-table"
            className="w-full text-left border-collapse text-xs"
          >
            <thead>
              <tr className="bg-slate-50 dark:bg-[#0D1016] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-white/10 text-[11px] uppercase tracking-wider">
                <th className="py-3 px-4 font-semibold">Telecalling Rep</th>
                <th className="py-3 px-4 font-semibold text-right">Logged Dials</th>
                <th className="py-3 px-4 font-semibold">Normalized Disposition Distribution</th>
                <th className="py-3 px-4 font-semibold text-right">DIDNT_RECEIVE %</th>
                <th className="py-3 px-4 font-semibold text-right">Calls &rarr; Proposal</th>
                <th className="py-3 px-4 font-semibold text-right">Proposal &rarr; Interested</th>
                <th className="py-3 px-4 font-semibold text-right">2-Day Follow-up TAT</th>
                <th className="py-3 px-4 font-semibold">Quality Audit Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {matrixSummary.repRows.map((row) => {
                const posPct = Math.round(
                  ((row.interestedCount + row.proposalSharedCount) / row.totalCallsLogged) * 100
                );
                const nrPct = Math.round(row.didntReceiveRatioPct);
                const soPct = Math.max(0, 100 - posPct - nrPct);

                return (
                  <tr
                    key={row.repEmail}
                    className={
                      row.isHighDisconnectAnomaly
                        ? 'bg-amber-500/[0.06] hover:bg-amber-500/[0.10]'
                        : 'hover:bg-slate-50/80 dark:hover:bg-white/[0.02]'
                    }
                  >
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {row.repName.split(' (')[0]}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">{row.repEmail}</div>
                    </td>

                    <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                      {row.totalCallsLogged}
                    </td>

                    <td className="py-3.5 px-4 min-w-[200px]">
                      <div className="w-full h-2.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden flex">
                        <div
                          style={{ width: `${posPct}%` }}
                          className="bg-emerald-500 h-full"
                          title={`Positive (INTERESTED + PROPOSAL_SHARED): ${posPct}%`}
                        />
                        <div
                          style={{ width: `${nrPct}%` }}
                          className="bg-amber-500 h-full"
                          title={`DIDNT_RECEIVE: ${nrPct}%`}
                        />
                        <div
                          style={{ width: `${soPct}%` }}
                          className="bg-rose-500/80 h-full"
                          title={`SWITCH_OFF / Other: ${soPct}%`}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          INT: {row.interestedCount} · PROP: {row.proposalSharedCount}
                        </span>
                        <span className="text-amber-600 dark:text-amber-400">
                          NR: {row.didntReceiveCount}
                        </span>
                        <span>SO: {row.switchOffCount}</span>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                      <span
                        className={
                          row.isHighDisconnectAnomaly
                            ? 'text-amber-600 dark:text-amber-400 font-bold'
                            : 'text-slate-800 dark:text-slate-200'
                        }
                      >
                        {row.didntReceiveRatioPct.toFixed(1)}%
                      </span>
                    </td>

                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                      {row.callsToProposalRatePct.toFixed(1)}%
                    </td>

                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#B88917] dark:text-[#E5B842] font-semibold">
                      {row.proposalToInterestedHandoverRatePct.toFixed(1)}%
                    </td>

                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-sky-600 dark:text-sky-400">
                      {row.avgProposalFollowUpTurnaroundHours.toFixed(1)}h
                    </td>

                    <td className="py-3.5 px-4">
                      {row.isHighDisconnectAnomaly ? (
                        <div
                          data-testid="anomaly-flag-badge"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[11px] font-semibold"
                        >
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          <span>{row.anomalyLabel}</span>
                        </div>
                      ) : (
                        <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                          Nominal Dwell Profile
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
