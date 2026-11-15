'use client';

import React, { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  PhoneForwarded,
  Sun,
  Moon,
  Monitor,
  LogOut,
  FileSpreadsheet,
  Plus,
  Sparkles,
  UserCheck,
  Settings,
  AlertTriangle,
  RotateCcw,
  ArrowRightLeft,
  Activity,
  History,
  WifiOff,
  Wifi,
  BarChart3,
  Trophy,
  Target,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { LeadRecord } from '@/lib/types';
import {
  RepDailyProgressBar,
  TeamTargetsConfig,
} from '@/components/settings/TargetSettings';

export type ConsoleTabId =
  | 'global_pool'
  | 'batch_health'
  | 'disposition_analytics'
  | 'team_leaderboard'
  | 'duplicate_audit'
  | 'audit_trail'
  | 'owner_closing_queue'
  | 'rep_daily_batch'
  | 'rep_dialed_leads';

interface TopNavProps {
  activeTab: ConsoleTabId;
  onSelectTab: (tab: ConsoleTabId) => void;
  interestedCount: number;
  duplicateCount: number;
  auditLogsCount?: number;
  leads?: LeadRecord[];
  teamTargets?: TeamTargetsConfig;
  isOfflineMode?: boolean;
  pendingDispositionsCount?: number;
  onToggleOfflineSimulation?: () => void;
  onFlushOfflineQueueNow?: () => void;
  onOpenExcelModal: () => void;
  onOpenAddLeadModal: () => void;
  onRequestForceReleaseUncalled?: () => void;
  onRequestCooldownSweep?: () => void;
  onOpenLeadTransferModal?: () => void;
  onOpenIntegrityDiagnosticModal?: () => void;
  onOpenDisasterRecoveryModal?: () => void;
  onOpenTargetSettingsModal?: () => void;
}

export function TopNav({
  activeTab,
  onSelectTab,
  interestedCount,
  duplicateCount,
  auditLogsCount = 0,
  leads = [],
  teamTargets,
  isOfflineMode = false,
  pendingDispositionsCount = 0,
  onToggleOfflineSimulation,
  onFlushOfflineQueueNow,
  onOpenExcelModal,
  onOpenAddLeadModal,
  onRequestForceReleaseUncalled,
  onRequestCooldownSweep,
  onOpenLeadTransferModal,
  onOpenIntegrityDiagnosticModal,
  onOpenDisasterRecoveryModal,
  onOpenTargetSettingsModal,
}: TopNavProps) {
  const { user, authorizedUsers, switchRoleProfile, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!user) return null;

  const isOwner = Boolean(
    user.isOwnerTier ||
      user.role === 'OWNER' ||
      user.role === 'ADMIN' ||
      (user.role as string) === 'owner'
  );

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#0D1016]/95 backdrop-blur border-b border-slate-200 dark:border-white/10">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6">
        {/* Top Row: Brand Zone — Quick Actions & Role/Theme Switcher */}
        <div className="flex items-center justify-between gap-4 py-3">
          {/* Left: Squircle Icon + Solarithm Reach Title + Subtitle */}
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center shrink-0">
              <PhoneForwarded className="w-5 h-5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
                  Solarithm <span className="text-[#E5B842]">Reach</span>
                </span>
                <span className="hidden sm:inline-block text-xs text-slate-400 dark:text-slate-500">
                  ·
                </span>
                <span className="hidden sm:inline-block text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
                  Enterprise Solar Outreach Console
                </span>
              </div>
              <p className="sm:hidden text-[11px] text-slate-500 dark:text-slate-400 truncate">
                Enterprise Solar Outreach Console
              </p>
            </div>
          </div>

          {/* Right: Offline Status Indicator, Ingestion Actions, Role Switcher, Theme Switcher, Logout */}
          <div className="flex items-center gap-2.5 shrink-0">
            {/* Phase 12 Task 1: Amber Offline Mode Status Badge & Simulation/Sync Trigger */}
            {(isOfflineMode || pendingDispositionsCount > 0) && (
              <div
                role="status"
                data-testid="offline-mode-status-pill"
                className="px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-xs font-semibold flex items-center gap-2 whitespace-nowrap"
              >
                <WifiOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>
                  Offline Mode: {pendingDispositionsCount} dispositions pending sync
                </span>
                {pendingDispositionsCount > 0 && onFlushOfflineQueueNow && (
                  <button
                    type="button"
                    data-testid="reconnect-and-sync-btn"
                    onClick={onFlushOfflineQueueNow}
                    className="ml-1 px-2 py-0.5 rounded bg-amber-500 text-slate-950 text-[11px] font-bold hover:bg-amber-400 transition-colors cursor-pointer"
                  >
                    Reconnect &amp; Sync
                  </button>
                )}
              </div>
            )}

            {onToggleOfflineSimulation && (
              <button
                type="button"
                data-testid="toggle-offline-mode-btn"
                onClick={onToggleOfflineSimulation}
                title={
                  isOfflineMode
                    ? 'Reconnect to network & flush pending_dispositions'
                    : 'Simulate network drop (navigator.onLine === false) to test offline calling queue'
                }
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  isOfflineMode
                    ? 'border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300'
                }`}
              >
                {isOfflineMode ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Go Online</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden xl:inline">Simulate Offline</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={onOpenAddLeadModal}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-800 dark:text-slate-200 text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Add Lead</span>
            </button>

            <button
              type="button"
              onClick={onOpenExcelModal}
              className="px-3.5 py-1.5 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] text-white text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-[#E5B842]" />
              <span>Import Excel / CSV</span>
            </button>

            {/* Quick Role Profile Switcher for testing Owner vs Sales Rep */}
            <div className="hidden lg:flex items-center gap-1.5 pl-2 border-l border-slate-200 dark:border-white/10">
              <UserCheck className="w-3.5 h-3.5 text-slate-400" />
              <select
                aria-label="Active Workspace Profile"
                value={user.email}
                onChange={(e) => switchRoleProfile(e.target.value)}
                className="bg-slate-100 dark:bg-[#151922] border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#E5B842]"
              >
                {authorizedUsers.map((u) => (
                  <option key={u.email} value={u.email}>
                    {u.role === 'owner' ? 'Owner' : 'Sales Rep'}: {u.name.split(' (')[0]}
                  </option>
                ))}
              </select>
            </div>

            {/* Theme Switcher: Light, Dark, System Default */}
            {mounted && (
              <div
                role="group"
                aria-label="Theme Switcher"
                className="flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-[#151922] border border-slate-200 dark:border-white/10"
              >
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  title="Light Theme"
                  aria-label="Light Theme"
                  className={`p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                    theme === 'light'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  title="Dark Theme"
                  aria-label="Dark Theme"
                  className={`p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                    theme === 'dark'
                      ? 'bg-[#222834] text-[#E5B842] shadow-xs'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('system')}
                  title="System Default Theme"
                  aria-label="System Default Theme"
                  className={`p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                    theme === 'system'
                      ? 'bg-white dark:bg-[#222834] text-slate-900 dark:text-[#E5B842] shadow-xs'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  <Monitor className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Owner-Exclusive Emergency Maintenance & Settings Menu */}
            {isOwner && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  title="Owner Maintenance & Settings"
                  aria-label="Owner Maintenance & Settings"
                  data-testid="owner-settings-menu-btn"
                  className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                    settingsOpen
                      ? 'border-[#E5B842] bg-[#E5B842]/15 text-[#E5B842]'
                      : 'border-slate-200 dark:border-white/10 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                  }`}
                >
                  <Settings className="w-4 h-4" />
                </button>

                {settingsOpen && (
                  <div
                    role="menu"
                    aria-label="Owner Maintenance Menu"
                    className="absolute right-0 mt-2 w-80 rounded-xl bg-white dark:bg-[#131720] border border-slate-200 dark:border-white/15 shadow-2xl p-2 z-50 space-y-1"
                  >
                    <div className="px-2.5 py-1.5 border-b border-slate-100 dark:border-white/10">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Owner Emergency Maintenance
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        Cloud Cron Fallback &amp; Cooldown Sweeper Controls
                      </div>
                    </div>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="force-release-uncalled-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onRequestForceReleaseUncalled?.();
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-amber-500/10 border border-transparent hover:border-amber-500/30 transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-semibold text-slate-900 dark:text-white">
                          Force Release Uncalled Leads Now
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Unlinks all uncalled FRESH batch leads &amp; closes active batches with confirmation.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="open-lead-transfer-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onOpenLeadTransferModal?.();
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <ArrowRightLeft className="w-4 h-4 text-[#E5B842] shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          Lead Re-Assignment &amp; Rep Handover
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Selective transfer (PROPOSAL_SHARED / FUTURE_REQUIREMENT) &amp; Mid-Day Release.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="open-integrity-diagnostic-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onOpenIntegrityDiagnosticModal?.();
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <Activity className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          Data Integrity &amp; Orphan Cleaner
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Diagnose &amp; remediate orphaned reps, dead caps, &amp; &gt;14d follow-ups.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="run-cooldown-sweeper-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onRequestCooldownSweep?.();
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          Run 48h Cooldown &amp; Dead-Lead Sweeper
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Clears expired DIDNT_RECEIVE locks &amp; audits SWITCH_OFF &ge; 3.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="open-disaster-recovery-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onOpenDisasterRecoveryModal?.();
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <History className="w-4 h-4 text-[#E5B842] shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          Disaster Recovery, Snapshot &amp; Import Rollback
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Export leads_snapshot_YYYY_MM_DD.json.gz &amp; rollback importBatchId.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-testid="open-target-settings-menu-btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        onOpenTargetSettingsModal?.();
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors flex items-start gap-2.5 cursor-pointer"
                    >
                      <Target className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                          Rep Target &amp; KPI Configuration (`config/targets`)
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Configure daily dials (120), weekly interested (10) &amp; 48h SLA.
                        </div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="p-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Bottom Row: Role-Gated Console Navigation Tabs */}
        <nav
          aria-label="Pipeline Navigation"
          className="flex items-center justify-between gap-4 border-t border-slate-100 dark:border-white/5 pt-1 overflow-x-auto"
        >
          <div className="flex items-center gap-1">
            {isOwner ? (
              <>
                <button
                  type="button"
                  onClick={() => onSelectTab('global_pool')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'global_pool'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Global Lead Pool
                </button>

                <button
                  type="button"
                  onClick={() => onSelectTab('batch_health')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'batch_health'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Daily Batch Health &amp; Shuffler
                </button>

                <button
                  type="button"
                  data-testid="tab-disposition-analytics"
                  onClick={() => onSelectTab('disposition_analytics')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'disposition_analytics'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>Disposition Heatmap &amp; Re-engagement</span>
                </button>

                <button
                  type="button"
                  data-testid="tab-team-leaderboard"
                  onClick={() => onSelectTab('team_leaderboard')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'team_leaderboard'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <Trophy className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>Team Leaderboard &amp; Targets</span>
                </button>

                <button
                  type="button"
                  onClick={() => onSelectTab('duplicate_audit')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'duplicate_audit'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Duplicate Audit ({duplicateCount})
                </button>

                <button
                  type="button"
                  data-testid="tab-audit-trail"
                  onClick={() => onSelectTab('audit_trail')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'audit_trail'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <History className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>Audit Trail ({auditLogsCount})</span>
                </button>

                {/* Exclusive Highlighted "Interested (Owner Closing Queue)" Tab */}
                <button
                  type="button"
                  onClick={() => onSelectTab('owner_closing_queue')}
                  className={`ml-2 px-3.5 py-1.5 my-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'owner_closing_queue'
                      ? 'bg-[#E5B842] text-slate-950 shadow-xs'
                      : 'bg-[#E5B842]/15 text-[#B88917] dark:text-[#E5B842] hover:bg-[#E5B842]/25 border border-[#E5B842]/30'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Interested (Owner Closing Queue) · {interestedCount}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onSelectTab('rep_daily_batch')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'rep_daily_batch'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Daily Fresh Batches
                </button>

                <button
                  type="button"
                  onClick={() => onSelectTab('rep_dialed_leads')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'rep_dialed_leads'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  My Dialed Leads
                </button>

                <button
                  type="button"
                  data-testid="tab-team-leaderboard"
                  onClick={() => onSelectTab('team_leaderboard')}
                  className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'team_leaderboard'
                      ? 'border-[#E5B842] text-slate-900 dark:text-white font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <Trophy className="w-3.5 h-3.5 text-[#E5B842]" />
                  <span>Team Leaderboard</span>
                </button>
              </>
            )}
          </div>

          {/* Right metadata indicator: Individual Rep Progress Bar (in Sales Rep view) + Active user & role */}
          <div className="flex items-center gap-3 py-1.5 whitespace-nowrap">
            {!isOwner && (
              <RepDailyProgressBar
                repEmail={user.email}
                leads={leads}
                targets={teamTargets}
              />
            )}
            <div className="hidden md:flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{user.name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px] text-[#B88917] dark:text-[#E5B842]">
                {isOwner ? 'OWNER ACCESS' : 'SALES REP ACCESS'}
              </span>
            </div>
          </div>
        </nav>
      </div>
    </header>
  );
}
