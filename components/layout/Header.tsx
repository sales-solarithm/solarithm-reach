'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  PhoneForwarded,
  Sun,
  Moon,
  Monitor,
  LogOut,
  FileSpreadsheet,
  Plus,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { LeadRecord, UserRole } from '@/lib/types';
import { WipeDataButton } from '@/components/admin/WipeDataButton';
import {
  DEFAULT_TEAM_TARGETS,
  TeamTargetsConfig,
  computeRepTodayCallsFromLeads,
} from '@/components/settings/TargetSettings';
import {
  REACH_FIREBASE_CONFIG,
  verifyReachCloudConnectionFromServer,
} from '@/lib/firebaseDual';

export interface HeaderProps {
  leads?: LeadRecord[];
  batchesCount?: number;
  teamTargets?: TeamTargetsConfig;
  dailyCallsCountOverride?: number;
  onOpenExcelModal?: () => void;
  onOpenAddLeadModal?: () => void;
  onWipeAllData?: () => void;
}

export function formatRoleBadgeText(role: UserRole | string, rawName: string): string {
  const cleanName = (rawName || '').split(' (')[0].trim();
  const roleUpper = String(role || '').trim().toUpperCase();
  if (roleUpper === 'ADMIN') {
    return `[Admin] ${cleanName || 'Admin'}`;
  }
  if (roleUpper === 'OWNER') {
    return `[Owner] ${cleanName || 'Jay Shah'}`;
  }
  return `[Sales Rep] ${cleanName || 'Sales Rep'}`;
}

export function formatUserAvatarInitials(rawName: string): string {
  const cleanName = (rawName || '').split(' (')[0].trim();
  if (!cleanName) return 'SR';
  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

export function formatSubduedDailyCallsText(calls: number, _target?: number): string {
  const safeCalls = Math.max(0, Math.floor(calls));
  return `Today's Calls: ${safeCalls}`;
}

export function Header({
  leads = [],
  batchesCount = 0,
  teamTargets: _teamTargets = DEFAULT_TEAM_TARGETS,
  dailyCallsCountOverride,
  onOpenExcelModal,
  onOpenAddLeadModal,
  onWipeAllData,
}: HeaderProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [cloudDbConnected, setCloudDbConnected] = useState<boolean>(true);
  const profileDropdownRef = useRef<HTMLDivElement | null>(null);
  const cloudProjectId = String(
    REACH_FIREBASE_CONFIG.projectId || 'solarithm-tools-370ed'
  );

  useEffect(() => {
    let active = true;
    void verifyReachCloudConnectionFromServer().then((res) => {
      if (active) {
        setMounted(true);
        setCloudDbConnected(res.connected);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        profileDropdownRef.current &&
        !profileDropdownRef.current.contains(e.target as Node)
      ) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  if (!user) return null;

  const isOwner = Boolean(
    user.isOwnerTier ||
      user.role === 'OWNER' ||
      user.role === 'ADMIN' ||
      (user.role as string) === 'owner'
  );
  const isSales = Boolean(
    (user.isSalesTier && !user.isOwnerTier) ||
      (!isOwner &&
        (user.role === 'SALES' ||
          user.role === 'LEAD_SALES' ||
          (user.role as string) === 'sales'))
  );

  const repCallsToday =
    dailyCallsCountOverride !== undefined
      ? dailyCallsCountOverride
      : computeRepTodayCallsFromLeads(user.email, leads);

  const avatarInitials = formatUserAvatarInitials(user.name);
  const fullRoleBadgeText = formatRoleBadgeText(user.role, user.name);

  return (
    <header
      data-testid="app-header"
      className="sticky top-0 z-30 bg-white/95 dark:bg-[#0D1016]/95 backdrop-blur border-b border-slate-200 dark:border-white/10"
    >
      {/* Responsive Header Stack:
          - Mobile (< md): 2-row compact stack (Top Row: Brand + Theme Toggle + Avatar/Profile Dropdown & Logout; Bottom Row: Daily Calls pill + compact action buttons)
          - Tablet/Desktop (md+): Single horizontal bar (h-14)
      */}
      <div className="max-w-[1440px] mx-auto px-3 sm:px-6 py-2 md:py-0 md:h-14 flex flex-wrap md:flex-nowrap items-center justify-between gap-y-2 gap-x-3">
        {/* Top Row Left (order-1): Compact squircle icon with gold glyph, Title Solarithm Reach & subtext Enterprise Outreach */}
        <div className="order-1 flex items-center gap-2.5 sm:gap-3 min-w-0">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center shrink-0">
            <PhoneForwarded className="w-4 h-4 text-amber-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm sm:text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
                Solarithm <span className="text-amber-400">Reach</span>
              </span>
              <span className="hidden lg:inline-block text-xs text-slate-400 dark:text-slate-600">
                ·
              </span>
              <span className="hidden lg:inline-block text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
                Enterprise Outreach
              </span>
              <span
                data-testid="cloud-db-status-badge"
                title={`Live Cloud Firestore Project: ${cloudProjectId}`}
                className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-mono whitespace-nowrap ${
                  cloudDbConnected
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                    : 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    cloudDbConnected ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                <span>Cloud DB: {cloudProjectId}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Center on Desktop / Bottom Row Left on Mobile (order-3 md:order-2): Sales Rep Today's Calls Pill */}
        {isSales && (
          <div
            data-testid="sales-daily-calls-pill"
            className="order-3 md:order-2 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-[11px] sm:text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap"
          >
            {formatSubduedDailyCallsText(repCallsToday)}
          </div>
        )}

        {/* Bottom Row on Mobile / Right-Center on Desktop (order-4 md:order-3): Compact Action Buttons */}
        <div
          className={`order-4 md:order-3 flex items-center gap-2 shrink-0 flex-wrap ${
            isSales ? 'ml-auto md:ml-0' : 'w-full md:w-auto justify-end pt-1.5 md:pt-0 border-t border-slate-100 dark:border-white/5 md:border-t-0'
          }`}
        >
          {/* [+ Add Lead] available for BOTH Sales Representatives (isSalesTier) and Owners (isOwnerTier) */}
          {(isOwner || isSales) && (
            <button
              type="button"
              data-testid="header-add-single-lead-btn"
              onClick={onOpenAddLeadModal}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-800 dark:text-slate-200 font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>+ Add Lead</span>
            </button>
          )}

          {/* [Import Excel / CSV] and [Wipe All Leads & Batches] strictly inside isOwner block */}
          {isOwner && (
            <>
              <button
                type="button"
                data-testid="header-import-excel-btn"
                onClick={onOpenExcelModal}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-[#7C6328] hover:bg-[#8F722E] text-white font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                <span>Import Excel / CSV</span>
              </button>

              <WipeDataButton
                onWipeComplete={onWipeAllData}
                leadsCount={leads.length}
                batchesCount={batchesCount}
              />
            </>
          )}
        </div>

        {/* Top Row Right on Mobile / Far Right on Desktop (order-2 md:order-4): Profile Collapse, Theme Toggle, Sign-out */}
        <div
          ref={profileDropdownRef}
          className="order-2 md:order-4 relative flex items-center gap-1.5 sm:gap-2 shrink-0"
        >
          {/* Profile & Logout Collapse:
              - Mobile (< md): Clean avatar circle + truncated text badge (`max-w-[96px] truncate`) that toggles profile dropdown
              - Tablet/Desktop (md+): Full expanded `[Sales Rep] Savani Hasti Vijaybhai` / `[Owner] Jay Jalpa` badge
          */}
          <button
            type="button"
            data-testid="header-role-badge"
            onClick={() => setProfileMenuOpen((prev) => !prev)}
            title={fullRoleBadgeText}
            className="px-1.5 sm:px-2 md:px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-xs font-mono font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <span
              aria-hidden="true"
              className="inline-flex md:hidden w-5 h-5 rounded-full bg-amber-400/20 border border-amber-400/40 text-amber-600 dark:text-amber-300 text-[10px] font-bold items-center justify-center shrink-0"
            >
              {avatarInitials}
            </span>
            <span className="sr-only sm:not-sr-only sm:max-w-[150px] md:max-w-none sm:truncate">
              {fullRoleBadgeText}
            </span>
            <ChevronDown className="w-3 h-3 text-slate-400 md:hidden shrink-0" />
          </button>

          {/* Theme Toggle (Light / Dark / System) */}
          {mounted && (
            <div
              role="group"
              aria-label="Theme Switcher"
              className="flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-[#141821] border border-slate-200 dark:border-white/10"
            >
              <button
                type="button"
                onClick={() => setTheme('light')}
                title="Light Theme"
                aria-label="Light Theme"
                className={`p-1 sm:p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
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
                className={`p-1 sm:p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                  theme === 'dark'
                    ? 'bg-[#222834] text-amber-400 shadow-xs'
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
                className={`p-1 sm:p-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                  theme === 'system'
                    ? 'bg-white dark:bg-[#222834] text-slate-900 dark:text-amber-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Direct Sign-out Button */}
          <button
            type="button"
            data-testid="header-logout-btn"
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="p-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>

          {/* Compact Mobile Profile Dropdown Card */}
          {profileMenuOpen && (
            <div
              data-testid="header-mobile-profile-dropdown"
              className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/10 shadow-xl p-3 z-50 space-y-2.5 md:hidden"
            >
              <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100 dark:border-white/10">
                <div className="w-8 h-8 rounded-full bg-amber-400/20 border border-amber-400/40 text-amber-600 dark:text-amber-300 text-xs font-bold flex items-center justify-center shrink-0">
                  {avatarInitials}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                    {user.name}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {user.email}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 dark:text-slate-300">
                <span>Role</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-white/5">
                  {fullRoleBadgeText}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setProfileMenuOpen(false);
                  logout();
                }}
                className="w-full py-1.5 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
