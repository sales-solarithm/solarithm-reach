'use client';

import React from 'react';
import { Calendar } from 'lucide-react';
import { AnalyticsDatePreset } from '@/lib/performanceAnalytics';

export const DATE_PRESET_OPTIONS: {
  value: AnalyticsDatePreset;
  label: string;
}[] = [
  { value: 'TODAY', label: 'Today' },
  { value: 'LAST_7_DAYS', label: 'Last 7 Days' },
  { value: 'THIS_MONTH', label: 'This Month' },
  { value: 'LAST_30_DAYS', label: 'Last 30 Days' },
  { value: 'ALL_TIME', label: 'All Time' },
  { value: 'CUSTOM', label: 'Custom' },
];

export interface WorkspaceNavProps {
  activeWorkspaceView: 'OUTREACH' | 'ANALYTICS';
  onChangeWorkspaceView: (view: 'OUTREACH' | 'ANALYTICS') => void;
  analyticsDatePreset: AnalyticsDatePreset;
  onChangeDatePreset: (preset: AnalyticsDatePreset) => void;
  customStartDate: string;
  onChangeCustomStartDate: (date: string) => void;
  customEndDate: string;
  onChangeCustomEndDate: (date: string) => void;
}

/**
 * Scrollable Workspace Navigation & Global Date Range Bar (Zerodha Kite Style).
 * Uses horizontal scroll containment (`overflow-x-auto scrollbar-none whitespace-nowrap`)
 * so mobile users can swipe through tabs and date presets without horizontal page overflow.
 */
export function WorkspaceNav({
  activeWorkspaceView,
  onChangeWorkspaceView,
  analyticsDatePreset,
  onChangeDatePreset,
  customStartDate,
  onChangeCustomStartDate,
  customEndDate,
  onChangeCustomEndDate,
}: WorkspaceNavProps) {
  return (
    <nav
      aria-label="Workspace View Switcher"
      data-testid="workspace-view-switcher-bar"
      className="w-full border-b border-slate-200 dark:border-white/10 bg-white dark:bg-[#0D0F14]"
    >
      <div className="max-w-[1440px] mx-auto px-3 sm:px-6 min-h-[44px] py-1.5 flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-3">
        {/* Primary Workspace Tabs (Horizontally scrollable on mobile) */}
        <div className="flex items-center gap-5 sm:gap-6 overflow-x-auto scrollbar-none whitespace-nowrap">
          <button
            type="button"
            data-testid="tab-outreach-workspace"
            onClick={() => onChangeWorkspaceView('OUTREACH')}
            className={`py-1.5 sm:py-2 text-xs font-semibold border-b-2 transition-colors shrink-0 cursor-pointer ${
              activeWorkspaceView === 'OUTREACH'
                ? 'border-[#D4AF37] text-slate-900 dark:text-white'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            Outreach Workspace
          </button>

          <button
            type="button"
            data-testid="tab-performance-analytics"
            onClick={() => onChangeWorkspaceView('ANALYTICS')}
            className={`py-1.5 sm:py-2 text-xs font-semibold border-b-2 transition-colors shrink-0 cursor-pointer ${
              activeWorkspaceView === 'ANALYTICS'
                ? 'border-[#D4AF37] text-slate-900 dark:text-white'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            Performance &amp; Analytics
          </button>
        </div>

        {/* Global Date Range Filter (Horizontally scrollable pill strip on mobile) */}
        <div
          role="group"
          aria-label="Global Date Range Filter"
          data-testid="analytics-date-range-filter"
          className="flex items-center gap-1.5 overflow-x-auto scrollbar-none whitespace-nowrap pb-0.5 md:pb-0"
        >
          <Calendar className="w-3.5 h-3.5 text-slate-400 mr-1 hidden sm:inline shrink-0" />
          {DATE_PRESET_OPTIONS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              data-testid={`date-preset-${preset.value}`}
              onClick={() => onChangeDatePreset(preset.value)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 cursor-pointer ${
                analyticsDatePreset === preset.value
                  ? 'bg-slate-900 text-white dark:bg-[#1E2430] dark:text-[#D4AF37] border border-slate-900 dark:border-[#D4AF37]/40'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {preset.label}
            </button>
          ))}

          {analyticsDatePreset === 'CUSTOM' && (
            <div className="flex items-center gap-1.5 ml-1 shrink-0">
              <input
                type="date"
                aria-label="Custom start date"
                data-testid="custom-start-date-input"
                value={customStartDate}
                onChange={(e) => onChangeCustomStartDate(e.target.value)}
                className="px-2 py-0.5 rounded bg-slate-50 dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-[11px] font-mono text-slate-900 dark:text-white"
              />
              <span className="text-[11px] text-slate-400">to</span>
              <input
                type="date"
                aria-label="Custom end date"
                data-testid="custom-end-date-input"
                value={customEndDate}
                onChange={(e) => onChangeCustomEndDate(e.target.value)}
                className="px-2 py-0.5 rounded bg-slate-50 dark:bg-[#11141B] border border-slate-200 dark:border-white/10 text-[11px] font-mono text-slate-900 dark:text-white"
              />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
