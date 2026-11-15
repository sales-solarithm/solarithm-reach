'use client';

import React, { useEffect, useState } from 'react';
import {
  Target,
  CheckCircle2,
  Sliders,
  X,
  RotateCcw,
  TrendingUp,
  Clock,
  PhoneCall,
} from 'lucide-react';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { reachDb as db } from '@/lib/firebaseDual';
import { LeadRecord } from '@/lib/types';

export interface TeamTargetsConfig {
  dailyDialsTarget: number;
  weeklyInterestedTarget: number;
  proposalTurnaroundTargetHours: number;
  updatedAt?: string;
  updatedByEmail?: string;
}

export const DEFAULT_TEAM_TARGETS: TeamTargetsConfig = {
  dailyDialsTarget: 120,
  weeklyInterestedTarget: 10,
  proposalTurnaroundTargetHours: 48,
};

const LOCAL_TARGETS_STORAGE_KEY = 'solarithm_reach_team_targets_v1';

/**
 * Baseline morning shift dial counts per rep (empty by default — all call counters
 * are dynamically computed from live leads dialed today).
 */
export const REP_MORNING_SHIFT_BASELINES: Record<string, number> = {};

export interface RepDailyProgressMetrics {
  callsCount: number;
  targetCount: number;
  percentage: number;
  clampedWidthPercent: number;
  label: string;
  isTargetMet: boolean;
  barColorHex: '#E5B842' | '#10B981';
  barColorClass: string;
}

/**
 * Pure deterministic calculator for Task 1.2: Individual Rep Progress Bar.
 * Formats `"Today's Calls: X / 120 (Y%)"` and shifts bar color from
 * Solarithm Gold (`#E5B842`) to Emerald (`#10B981`) upon crossing 100%.
 */
export function computeRepDailyProgress(
  callsCount: number,
  dailyDialsTarget: number
): RepDailyProgressMetrics {
  const safeCalls = Math.max(0, Math.floor(callsCount));
  const safeTarget = Math.max(1, Math.floor(dailyDialsTarget || 120));
  const percentage = Math.round((safeCalls / safeTarget) * 100);
  const clampedWidthPercent = Math.min(100, Math.max(0, percentage));
  const isTargetMet = percentage >= 100;

  return {
    callsCount: safeCalls,
    targetCount: safeTarget,
    percentage: percentage,
    clampedWidthPercent,
    label: `Today's Calls: ${safeCalls} / ${safeTarget} (${percentage}%)`,
    isTargetMet,
    barColorHex: isTargetMet ? '#10B981' : '#E5B842',
    barColorClass: isTargetMet ? 'bg-emerald-500' : 'bg-[#E5B842]',
  };
}

/**
 * Computes a sales rep's total calls today strictly from live leads where
 * `assignedRepEmail` or `lastCalledByEmail` matches the rep AND `lastCalledDate`
 * starts with today's ISO date string (`YYYY-MM-DD`).
 */
export function computeRepTodayCallsFromLeads(
  repEmail: string,
  leads: LeadRecord[],
  baselineOverride?: number
): number {
  const normalizedEmail = (repEmail || '').trim().toLowerCase();
  const baseCount = baselineOverride !== undefined ? baselineOverride : 0;

  if (!normalizedEmail) return baseCount;

  const todayPrefix = new Date().toISOString().slice(0, 10);
  let sessionCallsToday = 0;

  for (const lead of leads) {
    const calledByRep =
      lead.lastCalledByEmail?.toLowerCase().trim() === normalizedEmail ||
      lead.assignedRepEmail?.toLowerCase().trim() === normalizedEmail;
    if (
      calledByRep &&
      lead.lastCalledDate &&
      lead.lastCalledDate.startsWith(todayPrefix)
    ) {
      sessionCallsToday += 1;
    }
  }

  return baseCount + sessionCallsToday;
}

export function loadLocalTeamTargets(): TeamTargetsConfig {
  if (typeof window === 'undefined') return DEFAULT_TEAM_TARGETS;
  try {
    const raw = window.localStorage.getItem(LOCAL_TARGETS_STORAGE_KEY);
    if (!raw) return DEFAULT_TEAM_TARGETS;
    const parsed = JSON.parse(raw) as Partial<TeamTargetsConfig>;
    return {
      dailyDialsTarget:
        typeof parsed.dailyDialsTarget === 'number' && parsed.dailyDialsTarget > 0
          ? parsed.dailyDialsTarget
          : DEFAULT_TEAM_TARGETS.dailyDialsTarget,
      weeklyInterestedTarget:
        typeof parsed.weeklyInterestedTarget === 'number' &&
        parsed.weeklyInterestedTarget > 0
          ? parsed.weeklyInterestedTarget
          : DEFAULT_TEAM_TARGETS.weeklyInterestedTarget,
      proposalTurnaroundTargetHours:
        typeof parsed.proposalTurnaroundTargetHours === 'number' &&
        parsed.proposalTurnaroundTargetHours > 0
          ? parsed.proposalTurnaroundTargetHours
          : DEFAULT_TEAM_TARGETS.proposalTurnaroundTargetHours,
      updatedAt: parsed.updatedAt,
      updatedByEmail: parsed.updatedByEmail,
    };
  } catch {
    return DEFAULT_TEAM_TARGETS;
  }
}

export function saveLocalTeamTargets(config: TeamTargetsConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_TARGETS_STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LOCAL_TARGETS_STORAGE_KEY,
        newValue: JSON.stringify(config),
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export async function saveTeamTargetsToFirestore(
  config: TeamTargetsConfig,
  actorEmail?: string
): Promise<TeamTargetsConfig> {
  const payload: TeamTargetsConfig = {
    dailyDialsTarget: Math.max(1, Math.round(config.dailyDialsTarget)),
    weeklyInterestedTarget: Math.max(1, Math.round(config.weeklyInterestedTarget)),
    proposalTurnaroundTargetHours: Math.max(
      1,
      Math.round(config.proposalTurnaroundTargetHours)
    ),
    updatedAt: new Date().toISOString(),
    updatedByEmail: actorEmail || 'owner@solarithmdesign.com',
  };

  saveLocalTeamTargets(payload);

  try {
    await setDoc(doc(db, 'config', 'targets'), payload, { merge: true });
  } catch {
    // Graceful fallback when running in offline/preview mode
  }

  return payload;
}

export async function fetchTeamTargetsFromFirestore(): Promise<TeamTargetsConfig> {
  const local = loadLocalTeamTargets();
  try {
    const snap = await getDoc(doc(db, 'config', 'targets'));
    if (snap.exists()) {
      const data = snap.data() as Partial<TeamTargetsConfig>;
      const merged: TeamTargetsConfig = {
        dailyDialsTarget:
          typeof data.dailyDialsTarget === 'number' && data.dailyDialsTarget > 0
            ? data.dailyDialsTarget
            : local.dailyDialsTarget,
        weeklyInterestedTarget:
          typeof data.weeklyInterestedTarget === 'number' &&
          data.weeklyInterestedTarget > 0
            ? data.weeklyInterestedTarget
            : local.weeklyInterestedTarget,
        proposalTurnaroundTargetHours:
          typeof data.proposalTurnaroundTargetHours === 'number' &&
          data.proposalTurnaroundTargetHours > 0
            ? data.proposalTurnaroundTargetHours
            : local.proposalTurnaroundTargetHours,
        updatedAt: data.updatedAt || local.updatedAt,
        updatedByEmail: data.updatedByEmail || local.updatedByEmail,
      };
      saveLocalTeamTargets(merged);
      return merged;
    }
  } catch {
    // Ignore offline error
  }
  return local;
}

interface RepDailyProgressBarProps {
  repEmail: string;
  leads: LeadRecord[];
  targets?: TeamTargetsConfig;
}

/**
 * Unobtrusive, minimal progress counter rendered inside the Sales Rep view header:
 * `"Today's Calls: 64 / 120 (53%)"`
 * Progress bar in Solarithm Gold (`#E5B842`) that dynamically shifts to emerald upon crossing 100%.
 */
export function RepDailyProgressBar({
  repEmail,
  leads,
  targets,
}: RepDailyProgressBarProps) {
  const [liveTargets, setLiveTargets] = useState<TeamTargetsConfig>(
    targets || DEFAULT_TEAM_TARGETS
  );
  const [bonusSimulatedCalls, setBonusSimulatedCalls] = useState<number>(0);

  useEffect(() => {
    if (targets) {
      setLiveTargets(targets);
      return;
    }
    setLiveTargets(loadLocalTeamTargets());

    let unsub: (() => void) | undefined;
    try {
      unsub = onSnapshot(
        doc(db, 'config', 'targets'),
        (snap) => {
          if (snap.exists()) {
            const data = snap.data() as Partial<TeamTargetsConfig>;
            setLiveTargets((prev) => ({
              dailyDialsTarget:
                typeof data.dailyDialsTarget === 'number'
                  ? data.dailyDialsTarget
                  : prev.dailyDialsTarget,
              weeklyInterestedTarget:
                typeof data.weeklyInterestedTarget === 'number'
                  ? data.weeklyInterestedTarget
                  : prev.weeklyInterestedTarget,
              proposalTurnaroundTargetHours:
                typeof data.proposalTurnaroundTargetHours === 'number'
                  ? data.proposalTurnaroundTargetHours
                  : prev.proposalTurnaroundTargetHours,
            }));
          }
        },
        () => {
          // Ignore snapshot listener permission error in preview
        }
      );
    } catch {
      // Ignore
    }

    const handleStorage = (e: StorageEvent) => {
      if (e.key === LOCAL_TARGETS_STORAGE_KEY) {
        setLiveTargets(loadLocalTeamTargets());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      unsub?.();
      window.removeEventListener('storage', handleStorage);
    };
  }, [targets]);

  const activeTargets = targets || liveTargets;
  const baseTodayCalls = computeRepTodayCallsFromLeads(repEmail, leads);
  const totalTodayCalls = baseTodayCalls + bonusSimulatedCalls;
  const progress = computeRepDailyProgress(
    totalTodayCalls,
    activeTargets.dailyDialsTarget
  );

  return (
    <div
      data-testid="rep-daily-progress-bar"
      className="flex items-center gap-3 px-3 py-1.5 rounded-xl bg-slate-100/90 dark:bg-[#151922] border border-slate-200 dark:border-white/10"
    >
      <div className="min-w-[185px]">
        <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
          <span
            data-testid="rep-daily-progress-label"
            className="font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap"
          >
            {progress.label}
          </span>
          {progress.isTargetMet && (
            <span
              data-testid="rep-daily-target-met-badge"
              className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase"
            >
              Goal Met
            </span>
          )}
        </div>
        <div
          role="progressbar"
          aria-valuenow={progress.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Daily Dials Target Progress"
          className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden mt-1"
        >
          <div
            data-testid="rep-daily-progress-fill"
            data-color-state={progress.isTargetMet ? 'emerald' : 'gold'}
            style={{ width: `${progress.clampedWidthPercent}%` }}
            className={`h-full transition-all duration-300 ${
              progress.isTargetMet ? 'bg-emerald-500' : 'bg-[#E5B842]'
            }`}
          />
        </div>
      </div>

      <button
        type="button"
        data-testid="simulate-target-100-btn"
        onClick={() =>
          setBonusSimulatedCalls((prev) =>
            prev > 0
              ? 0
              : Math.max(1, activeTargets.dailyDialsTarget - baseTodayCalls + 4)
          )
        }
        title={
          bonusSimulatedCalls > 0
            ? 'Reset to actual intraday call count'
            : 'Test crossing 100% Daily Target (Solarithm Gold -> Emerald)'
        }
        className="px-2 py-0.5 rounded-md border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0D1016] text-[10px] font-mono text-slate-600 dark:text-slate-300 hover:border-[#E5B842] transition-colors cursor-pointer shrink-0"
      >
        {bonusSimulatedCalls > 0 ? 'Reset 53%' : 'Test 100%+'}
      </button>
    </div>
  );
}

interface TargetSettingsProps {
  isOpen?: boolean;
  onClose?: () => void;
  targets: TeamTargetsConfig;
  onSaveTargets: (nextConfig: TeamTargetsConfig) => Promise<void> | void;
  actorEmail?: string;
  inlineMode?: boolean;
}

/**
 * Task 1: Rep Target & KPI Configuration (`components/settings/TargetSettings.tsx`).
 * Provides the Owner with tools to establish and track calling benchmarks in `config/targets`.
 */
export function TargetSettings({
  isOpen = true,
  onClose,
  targets,
  onSaveTargets,
  actorEmail,
  inlineMode = false,
}: TargetSettingsProps) {
  const [dailyDialsTarget, setDailyDialsTarget] = useState<number>(
    targets.dailyDialsTarget
  );
  const [weeklyInterestedTarget, setWeeklyInterestedTarget] = useState<number>(
    targets.weeklyInterestedTarget
  );
  const [proposalTurnaroundTargetHours, setProposalTurnaroundTargetHours] =
    useState<number>(targets.proposalTurnaroundTargetHours);
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setDailyDialsTarget(targets.dailyDialsTarget);
    setWeeklyInterestedTarget(targets.weeklyInterestedTarget);
    setProposalTurnaroundTargetHours(targets.proposalTurnaroundTargetHours);
  }, [
    targets.dailyDialsTarget,
    targets.weeklyInterestedTarget,
    targets.proposalTurnaroundTargetHours,
  ]);

  if (!inlineMode && !isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const updated = await saveTeamTargetsToFirestore(
        {
          dailyDialsTarget,
          weeklyInterestedTarget,
          proposalTurnaroundTargetHours,
        },
        actorEmail
      );
      await onSaveTargets(updated);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    setDailyDialsTarget(DEFAULT_TEAM_TARGETS.dailyDialsTarget);
    setWeeklyInterestedTarget(DEFAULT_TEAM_TARGETS.weeklyInterestedTarget);
    setProposalTurnaroundTargetHours(
      DEFAULT_TEAM_TARGETS.proposalTurnaroundTargetHours
    );
    const updated = await saveTeamTargetsToFirestore(
      DEFAULT_TEAM_TARGETS,
      actorEmail
    );
    await onSaveTargets(updated);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 3000);
  };

  const previewProgress53 = computeRepDailyProgress(64, dailyDialsTarget);
  const previewProgress100 = computeRepDailyProgress(
    dailyDialsTarget,
    dailyDialsTarget
  );

  const formContent = (
    <form
      onSubmit={handleSave}
      data-testid="target-settings-form"
      className="space-y-5"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 1. dailyDialsTarget */}
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="input-daily-dials-target"
              className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5"
            >
              <PhoneCall className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Daily Dials Target</span>
            </label>
            <span className="text-[10px] font-mono text-slate-400">
              calls/day/rep
            </span>
          </div>
          <input
            id="input-daily-dials-target"
            data-testid="input-daily-dials-target"
            type="number"
            min={10}
            max={1000}
            value={dailyDialsTarget}
            onChange={(e) =>
              setDailyDialsTarget(Math.max(1, parseInt(e.target.value || '120', 10)))
            }
            className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/15 font-mono text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            Key: <code>dailyDialsTarget</code> (Default: 120)
          </p>
        </div>

        {/* 2. weeklyInterestedTarget */}
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="input-weekly-interested-target"
              className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5"
            >
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
              <span>Weekly Interested Target</span>
            </label>
            <span className="text-[10px] font-mono text-slate-400">
              qualified/wk/rep
            </span>
          </div>
          <input
            id="input-weekly-interested-target"
            data-testid="input-weekly-interested-target"
            type="number"
            min={1}
            max={200}
            value={weeklyInterestedTarget}
            onChange={(e) =>
              setWeeklyInterestedTarget(
                Math.max(1, parseInt(e.target.value || '10', 10))
              )
            }
            className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/15 font-mono text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            Key: <code>weeklyInterestedTarget</code> (Default: 10)
          </p>
        </div>

        {/* 3. proposalTurnaroundTargetHours */}
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="input-proposal-turnaround-hours"
              className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5"
            >
              <Clock className="w-3.5 h-3.5 text-sky-400" />
              <span>Proposal Turnaround SLA</span>
            </label>
            <span className="text-[10px] font-mono text-slate-400">hours SLA</span>
          </div>
          <input
            id="input-proposal-turnaround-hours"
            data-testid="input-proposal-turnaround-hours"
            type="number"
            min={1}
            max={336}
            value={proposalTurnaroundTargetHours}
            onChange={(e) =>
              setProposalTurnaroundTargetHours(
                Math.max(1, parseInt(e.target.value || '48', 10))
              )
            }
            className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/15 font-mono text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            Key: <code>proposalTurnaroundTargetHours</code> (Default: 48h)
          </p>
        </div>
      </div>

      {/* Live Preview of Sales Rep Header Progress Bar States */}
      <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Sales Rep Header Progress Bar Preview (Solarithm Gold #E5B842 → Emerald &ge;100%)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-white dark:bg-[#131720] border border-slate-200 dark:border-white/10 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-800 dark:text-slate-200 font-semibold">
                {previewProgress53.label}
              </span>
              <span className="text-[10px] text-[#E5B842]">In Progress (&lt;100%)</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
              <div
                style={{ width: `${previewProgress53.clampedWidthPercent}%` }}
                className="h-full bg-[#E5B842]"
              />
            </div>
          </div>

          <div className="p-3 rounded-lg bg-white dark:bg-[#131720] border border-slate-200 dark:border-white/10 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-800 dark:text-slate-200 font-semibold">
                {previewProgress100.label}
              </span>
              <span className="text-[10px] text-emerald-500 font-semibold">
                Target Crossed (&ge;100%)
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
              <div
                style={{ width: `${previewProgress100.clampedWidthPercent}%` }}
                className="h-full bg-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-white/10">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults (120 / 10 / 48h)</span>
          </button>

          {savedNotice && (
            <span
              data-testid="targets-saved-badge"
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Saved to config/targets</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!inlineMode && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-200 dark:border-white/15 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              Close
            </button>
          )}
          <button
            type="submit"
            data-testid="save-targets-btn"
            disabled={isSaving}
            className="px-4 py-2 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Target className="w-3.5 h-3.5 text-[#E5B842]" />
            <span>{isSaving ? 'Saving...' : 'Save Rep Targets (config/targets)'}</span>
          </button>
        </div>
      </div>
    </form>
  );

  if (inlineMode) {
    return (
      <div
        data-testid="target-settings-inline-card"
        className="bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 rounded-2xl p-5 shadow-xs space-y-4"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#E5B842]" />
              <span>Rep Target &amp; KPI Configuration (`config/targets`)</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Establish calling benchmarks for daily dials, weekly interested escalations, and proposal turnaround SLA.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-lg bg-[#E5B842]/15 border border-[#E5B842]/30 text-[11px] font-mono text-[#B88917] dark:text-[#E5B842]">
            config/targets
          </span>
        </div>
        {formContent}
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="target-settings-modal-title"
      data-testid="target-settings-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#12161F] border border-slate-200 dark:border-white/15 shadow-2xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-white/10 pb-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#E5B842]/15 border border-[#E5B842]/30 flex items-center justify-center shrink-0">
              <Target className="w-5 h-5 text-[#E5B842]" />
            </div>
            <div>
              <h3
                id="target-settings-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white"
              >
                Rep Target &amp; KPI Configuration (`config/targets`)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Configure calling benchmarks synced across Sales Rep headers and the Real-Time Team Leaderboard.
              </p>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {formContent}
      </div>
    </div>
  );
}
