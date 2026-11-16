'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from 'recharts';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  Search,
  Users,
  X,
} from 'lucide-react';
import { ActiveReachSalesRep, getActiveSalesReps } from '@/lib/employeeQueries';
import {
  AnalyticsDateFilter,
  computeOwnerAnalyticsPure,
  filterAndSortScorecardRows,
  RepFocusMode,
  resolveDefaultRepFocusMode,
  resolveFocusedOwnerChartViewPure,
  ScorecardSortField,
  SortDirection,
  SparklinePoint,
} from '@/lib/performanceAnalytics';
import {
  DailyRepStatRecord,
  fetchDailyStatsFromFirestore,
} from '@/lib/dailyStatsService';
import { LeadRecord } from '@/lib/types';
import { formatRepName } from '@/lib/utils';

export interface OwnerAnalyticsViewProps {
  leads: LeadRecord[];
  dateFilter: AnalyticsDateFilter;
  dailyStats?: DailyRepStatRecord[];
}

/**
 * Compact 7-Day Mini Smooth Sparkline rendered inside each rep's table row
 * using lightweight pure SVG cubic-bezier interpolation (zero ResizeObserver overhead for 30+ reps).
 */
function MiniSmoothSparkline({
  data,
  color,
  repEmail,
}: {
  data: SparklinePoint[];
  color: string;
  repEmail: string;
}) {
  const safeId = `spark-${repEmail.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const total7d = data.reduce((sum, pt) => sum + pt.calls, 0);

  const width = 80;
  const height = 24;
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const maxCalls = Math.max(...data.map((d) => d.calls), 1);
  const pts = data.map((d, idx) => {
    const x =
      data.length > 1
        ? padX + (idx / (data.length - 1)) * innerW
        : width / 2;
    const y = padY + innerH - (d.calls / maxCalls) * innerH;
    return { x, y };
  });

  // Build smooth cubic bezier path
  let linePath = '';
  if (pts.length > 0) {
    linePath = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cpx1 = p0.x + (p1.x - p0.x) / 2;
      const cpy1 = p0.y;
      const cpx2 = p0.x + (p1.x - p0.x) / 2;
      const cpy2 = p1.y;
      linePath += ` C ${cpx1.toFixed(1)} ${cpy1.toFixed(1)}, ${cpx2.toFixed(1)} ${cpy2.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }
  }

  const areaPath =
    pts.length > 1
      ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(height - 1).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(height - 1).toFixed(1)} Z`
      : '';

  return (
    <div
      data-testid={`sparkline-7d-${repEmail}`}
      className="inline-flex items-center gap-1.5 justify-end"
    >
      <div className="w-20 h-6 flex items-center">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-20 h-6 overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={safeId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0.0} />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill={`url(#${safeId})`} />}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={color}
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          )}
        </svg>
      </div>
      <span className="text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400 w-5 text-right">
        {total7d}d
      </span>
    </div>
  );
}

export function OwnerAnalyticsView({
  leads,
  dateFilter,
  dailyStats,
}: OwnerAnalyticsViewProps) {
  const [activeReps, setActiveReps] = useState<ActiveReachSalesRep[]>([]);
  const [fetchedDailyStats, setFetchedDailyStats] = useState<DailyRepStatRecord[]>([]);
  const [focusMode, setFocusMode] = useState<RepFocusMode>('TOP_5');
  const [customSelectedEmails, setCustomSelectedEmails] = useState<string[]>([]);
  const [isolatedRepEmail, setIsolatedRepEmail] = useState<string | null>(null);
  const [isCustomDropdownOpen, setIsCustomDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState('');

  // Scorecard table scaling controls (search + column sorting for 30+ reps)
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [sortField, setSortField] = useState<ScorecardSortField>('callsDialed');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Chart 02 X-axis mode ('TIMELINE' over selected date range vs 'BY_REP' across sorted reps)
  const [chart2AxisMode, setChart2AxisMode] = useState<'TIMELINE' | 'BY_REP'>('TIMELINE');

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isMounted = true;
    getActiveSalesReps({ includeOwners: false })
      .then((reps) => {
        if (isMounted) {
          setActiveReps(reps);
          setFocusMode(resolveDefaultRepFocusMode(reps.length));
        }
      })
      .catch(() => {
        // Fallback handled inside computeOwnerAnalyticsPure
      });
    if (!dailyStats) {
      fetchDailyStatsFromFirestore()
        .then((stats) => {
          if (isMounted) setFetchedDailyStats(stats);
        })
        .catch(() => {});
    }
    return () => {
      isMounted = false;
    };
  }, [dailyStats]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsCustomDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const effectiveDailyStats = dailyStats ?? fetchedDailyStats;

  const report = useMemo(
    () =>
      computeOwnerAnalyticsPure(
        leads,
        activeReps,
        dateFilter,
        undefined,
        effectiveDailyStats
      ),
    [leads, activeReps, dateFilter, effectiveDailyStats]
  );

  // Initialize default customSelectedEmails to first 2 reps if empty when opening custom mode
  const effectiveCustomEmails = useMemo(() => {
    if (customSelectedEmails.length > 0) return customSelectedEmails;
    return report.repSeriesMeta.slice(0, 2).map((r) => r.repEmail);
  }, [customSelectedEmails, report.repSeriesMeta]);

  const focusedView = useMemo(
    () =>
      resolveFocusedOwnerChartViewPure(report, {
        focusMode,
        customSelectedEmails: effectiveCustomEmails,
        isolatedRepEmail,
        leads,
      }),
    [report, focusMode, effectiveCustomEmails, isolatedRepEmail, leads]
  );

  const chart2Data = useMemo(
    () =>
      chart2AxisMode === 'TIMELINE'
        ? focusedView.focusedDailyOutcomeSplineSeries.map((pt) => ({
            xAxisLabel: pt.label,
            interestedGenerated: pt.interestedGenerated,
            newLeadsAdded: pt.newLeadsAdded,
            convertedToClientsWon: pt.convertedToClientsWon,
            teamAvgInterested: pt.teamAvgInterested,
          }))
        : focusedView.focusedComparisonPoints.map((pt) => ({
            xAxisLabel: pt.shortName,
            interestedGenerated: pt.interestedGenerated,
            newLeadsAdded: pt.newLeadsAdded,
            convertedToClientsWon: pt.convertedToClientsWon,
            teamAvgInterested: 0,
          })),
    [
      chart2AxisMode,
      focusedView.focusedDailyOutcomeSplineSeries,
      focusedView.focusedComparisonPoints,
    ]
  );

  const filteredScorecardRows = useMemo(
    () =>
      filterAndSortScorecardRows(
        report.scorecardRows,
        tableSearchQuery,
        sortField,
        sortDirection
      ),
    [report.scorecardRows, tableSearchQuery, sortField, sortDirection]
  );

  const searchableDropdownReps = useMemo(() => {
    const q = dropdownSearch.trim().toLowerCase();
    if (!q) return report.scorecardRows;
    return report.scorecardRows.filter(
      (r) =>
        r.repName.toLowerCase().includes(q) ||
        r.repEmail.toLowerCase().includes(q)
    );
  }, [report.scorecardRows, dropdownSearch]);

  const totalDispositionCount = useMemo(
    () =>
      report.callDispositionBreakdown.reduce((sum, item) => sum + item.count, 0),
    [report.callDispositionBreakdown]
  );

  const handleSortColumn = (field: ScorecardSortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleToggleCustomRep = (repEmail: string) => {
    const clean = repEmail.toLowerCase().trim();
    setIsolatedRepEmail(null);
    setFocusMode('CUSTOM');
    setCustomSelectedEmails((prev) => {
      const base = prev.length > 0 ? prev : effectiveCustomEmails;
      if (base.includes(clean)) {
        if (base.length <= 1) return base; // Keep at least 1 selected
        return base.filter((e) => e !== clean);
      }
      if (base.length >= 6) {
        return [...base.slice(1), clean]; // Cap at 6 reps max
      }
      return [...base, clean];
    });
  };

  const handleRowClickToIsolate = (repEmail: string) => {
    const clean = repEmail.toLowerCase().trim();
    setIsolatedRepEmail((prev) => (prev === clean ? null : clean));
  };

  const isolatedRepMeta = useMemo(() => {
    if (!isolatedRepEmail) return null;
    return (
      report.scorecardRows.find((r) => r.repEmail === isolatedRepEmail) || null
    );
  }, [isolatedRepEmail, report.scorecardRows]);

  const renderSortIcon = (field: ScorecardSortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3 h-3 text-slate-400 inline ml-1" />;
    }
    return sortDirection === 'desc' ? (
      <ArrowDown className="w-3 h-3 text-[#D4AF37] inline ml-1" />
    ) : (
      <ArrowUp className="w-3 h-3 text-[#D4AF37] inline ml-1" />
    );
  };

  return (
    <div data-testid="owner-analytics-view" className="space-y-6">
      {/* 2.1 Future-Proof Rep Focus & Comparison Selector Control Bar */}
      <section
        aria-label="Rep Focus and Comparison Selector"
        data-testid="rep-focus-selector-bar"
        className="p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 mr-1">
            <Users className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Rep Chart Focus:</span>
          </div>

          {/* Mode 1: All Team Aggregate */}
          <button
            type="button"
            data-testid="focus-mode-all-team"
            onClick={() => {
              setIsolatedRepEmail(null);
              setFocusMode('ALL_TEAM');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              !isolatedRepEmail && focusMode === 'ALL_TEAM'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold'
                : 'bg-slate-100 text-slate-600 hover:text-slate-900 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            All Team Aggregate
          </button>

          {/* Mode 2: Top 5 Performers */}
          <button
            type="button"
            data-testid="focus-mode-top-5"
            onClick={() => {
              setIsolatedRepEmail(null);
              setFocusMode('TOP_5');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              !isolatedRepEmail && focusMode === 'TOP_5'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold'
                : 'bg-slate-100 text-slate-600 hover:text-slate-900 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            Top 5 Performers
          </button>

          {/* Mode 3: Compare Specific Reps (Custom Searchable Multi-Select Dropdown, 1–6 Reps) */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              data-testid="focus-mode-custom-compare"
              onClick={() => {
                setIsolatedRepEmail(null);
                setFocusMode('CUSTOM');
                setIsCustomDropdownOpen((prev) => !prev);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                !isolatedRepEmail && focusMode === 'CUSTOM'
                  ? 'bg-[#D4AF37]/15 text-amber-800 dark:text-[#D4AF37] border border-[#D4AF37]/40 font-semibold'
                  : 'bg-slate-100 text-slate-600 hover:text-slate-900 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:text-white border border-transparent'
              }`}
            >
              <span>
                Compare Specific Reps ({effectiveCustomEmails.length}/6)
              </span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {isCustomDropdownOpen && (
              <div
                data-testid="custom-rep-compare-dropdown"
                className="absolute left-0 mt-1.5 w-72 rounded-xl bg-white dark:bg-[#141821] border border-neutral-200 dark:border-neutral-800 shadow-xl z-30 p-2.5 space-y-2"
              >
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 px-1">
                  <span>Select 1 to 6 Reps to Compare</span>
                  <span className="font-mono">
                    {effectiveCustomEmails.length} / 6
                  </span>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    data-testid="custom-rep-dropdown-search"
                    value={dropdownSearch}
                    onChange={(e) => setDropdownSearch(e.target.value)}
                    placeholder="Search sales rep..."
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 bg-slate-50 dark:bg-[#0D1016] text-slate-900 dark:text-white focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800/60">
                  {searchableDropdownReps.map((rep) => {
                    const isChecked = effectiveCustomEmails.includes(
                      rep.repEmail
                    );
                    return (
                      <button
                        key={rep.repEmail}
                        type="button"
                        data-testid={`custom-rep-option-${rep.repEmail}`}
                        onClick={() => handleToggleCustomRep(rep.repEmail)}
                        className="w-full px-2 py-1.5 flex items-center justify-between text-left text-xs hover:bg-slate-50 dark:hover:bg-white/[0.04] rounded-md cursor-pointer"
                      >
                        <div className="min-w-0 pr-2">
                          <div className="font-medium text-slate-900 dark:text-white truncate">
                            {formatRepName(rep.repName)}
                          </div>
                          <div className="text-[10px] font-mono text-slate-500 truncate">
                            {rep.callsDialed} calls · {rep.interestedGenerated}{' '}
                            int
                          </div>
                        </div>
                        <span
                          className={`w-4 h-4 rounded flex items-center justify-center border ${
                            isChecked
                              ? 'bg-[#D4AF37] border-[#D4AF37] text-slate-950'
                              : 'border-slate-300 dark:border-slate-700'
                          }`}
                        >
                          {isChecked && <Check className="w-3 h-3 stroke-[2.5]" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right side: Active isolation indicator or scaling summary */}
        <div className="flex items-center gap-2">
          {isolatedRepMeta ? (
            <div
              data-testid="isolated-rep-active-banner"
              className="inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-xs text-amber-900 dark:text-[#D4AF37]"
            >
              <span>
                Isolated: <strong>{formatRepName(isolatedRepMeta.repName)}</strong> vs. Team Avg
              </span>
              <button
                type="button"
                data-testid="reset-isolated-rep-button"
                onClick={() => setIsolatedRepEmail(null)}
                className="inline-flex items-center gap-0.5 text-[11px] font-semibold underline hover:opacity-80 cursor-pointer"
              >
                <X className="w-3 h-3" />
                Reset
              </button>
            </div>
          ) : (
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Click any rep row below to isolate curve vs. team average
            </span>
          )}
        </div>
      </section>

      {/* A. Scalable Daily Sales Rep Scorecard Table (Supports 30+ Reps with Search, Column Sort & 7D Mini Sparkline) */}
      <section
        aria-label="Daily Sales Rep Scorecard Table"
        data-testid="owner-rep-scorecard-section"
        className="bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
              Daily Sales Rep Scorecard Table
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              Live Firestore breakdown ({report.bounds.startDateStr} to{' '}
              {report.bounds.endDateStr}) · Click any row to isolate rep trajectory
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Compact Search Input for 30+ Reps */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                data-testid="scorecard-rep-search-input"
                value={tableSearchQuery}
                onChange={(e) => setTableSearchQuery(e.target.value)}
                placeholder="Filter rep by name..."
                className="pl-8 pr-3 py-1 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-slate-50 dark:bg-[#0D1016] text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-[#D4AF37] w-48"
              />
            </div>

            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
              Active Sales Reps: {report.scorecardRows.length} · Total Dialed:{' '}
              <span className="font-semibold text-slate-900 dark:text-white">
                {report.totalsRow.callsDialed.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto max-h-[420px]">
          <table
            data-testid="owner-rep-scorecard-table"
            className="w-full text-left border-collapse"
          >
            <thead className="sticky top-0 z-10">
              <tr className="h-[38px] border-b border-neutral-200 dark:border-neutral-800 bg-slate-50/95 dark:bg-[#0D1016] text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 whitespace-nowrap">
                <th className="px-4 py-2">Sales Representative</th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-calls-dialed"
                    onClick={() => handleSortColumn('callsDialed')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    Calls Dialed
                    {renderSortIcon('callsDialed')}
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-new-leads-added"
                    onClick={() => handleSortColumn('newLeadsAdded')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    New Leads
                    {renderSortIcon('newLeadsAdded')}
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-proposals-shared"
                    onClick={() => handleSortColumn('proposalsShared')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    Proposals
                    {renderSortIcon('proposalsShared')}
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-interested-generated"
                    onClick={() => handleSortColumn('interestedGenerated')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    Interested
                    {renderSortIcon('interestedGenerated')}
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-converted-won"
                    onClick={() => handleSortColumn('convertedToClientsWon')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    Converted (Won)
                    {renderSortIcon('convertedToClientsWon')}
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-conversion-rate"
                    onClick={() => handleSortColumn('interestedConversionRate')}
                    className="inline-flex items-center justify-end hover:text-slate-900 dark:hover:text-white uppercase cursor-pointer whitespace-nowrap"
                  >
                    Conversion Rate (%)
                    {renderSortIcon('interestedConversionRate')}
                  </button>
                </th>
                <th className="px-4 py-2 text-right whitespace-nowrap">7D Mini Sparkline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70 text-xs">
              {filteredScorecardRows.length === 0 ? (
                <tr className="h-[44px]">
                  <td
                    colSpan={8}
                    className="px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400"
                  >
                    No matching sales representative profiles found.
                  </td>
                </tr>
              ) : (
                filteredScorecardRows.map((row, idx) => {
                  const isIsolated = isolatedRepEmail === row.repEmail;
                  const repColor =
                    report.repSeriesMeta.find((m) => m.repEmail === row.repEmail)
                      ?.color || '#D4AF37';

                  return (
                    <tr
                      key={row.repEmail}
                      data-testid={`scorecard-row-${row.repEmail}`}
                      onClick={() => handleRowClickToIsolate(row.repEmail)}
                      className={`h-[44px] transition-colors cursor-pointer ${
                        isIsolated
                          ? 'bg-amber-50/80 dark:bg-[#D4AF37]/12 ring-1 ring-inset ring-[#D4AF37]/50'
                          : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                      }`}
                    >
                      {/* 1. Sales Representative (Name + Email) */}
                      <td className="px-4 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: repColor }}
                          />
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                              <span>{formatRepName(row.repName)}</span>
                              {idx < 5 && report.scorecardRows.length > 5 && (
                                <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-[#D4AF37]">
                                  Top 5
                                </span>
                              )}
                              {isIsolated && (
                                <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-[#D4AF37] text-slate-950 font-bold">
                                  Isolated
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                              {row.repEmail}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* 2. Calls Dialed */}
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                        {row.callsDialed.toLocaleString()}
                      </td>

                      {/* 3. New Leads Added */}
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {row.newLeadsAdded.toLocaleString()}
                      </td>

                      {/* 4. Proposals Shared */}
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-600 dark:text-sky-400 whitespace-nowrap">
                        {row.proposalsShared.toLocaleString()}
                      </td>

                      {/* 5. Interested Generated */}
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-amber-600 dark:text-[#D4AF37] whitespace-nowrap">
                        {row.interestedGenerated.toLocaleString()}
                      </td>

                      {/* 6. Converted to Clients (Won) */}
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                        {row.convertedToClientsWon.toLocaleString()}
                      </td>

                      {/* 7. Conversion Rate (%) */}
                      <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">
                          {row.interestedConversionRate.toFixed(1)}% Int/Dial
                        </span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                          {row.wonConversionRate.toFixed(1)}% Won/Int
                        </span>
                      </td>

                      {/* 8. 7-Day Mini Smooth Sparkline */}
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <MiniSmoothSparkline
                          data={row.sparkline7d}
                          color={repColor}
                          repEmail={row.repEmail}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {report.scorecardRows.length > 0 && (
              <tfoot>
                <tr className="h-[40px] border-t border-neutral-200 dark:border-neutral-800 bg-slate-50/90 dark:bg-[#0D1016] text-xs font-semibold whitespace-nowrap">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                    Team Total ({report.scorecardRows.length} Reps)
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                    {report.totalsRow.callsDialed.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {report.totalsRow.newLeadsAdded.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-600 dark:text-sky-400">
                    {report.totalsRow.proposalsShared.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-600 dark:text-[#D4AF37]">
                    {report.totalsRow.interestedGenerated.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                    {report.totalsRow.convertedToClientsWon.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    <span className="text-slate-900 dark:text-white">
                      {report.totalsRow.interestedConversionRate.toFixed(1)}%
                      Int/Dial
                    </span>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {report.totalsRow.wonConversionRate.toFixed(1)}% Won/Int
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] text-slate-500">
                    Avg:{' '}
                    {(
                      report.totalsRow.callsDialed /
                      Math.max(report.scorecardRows.length, 1)
                    ).toFixed(1)}{' '}
                    calls/rep
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* B. Visual Charts Grid (2x2 Clean Card Grid using Smooth Monotone Spline AreaCharts) */}
      <section
        aria-label="Executive Performance Visual Charts Grid"
        data-testid="owner-charts-grid"
        className="grid grid-cols-1 lg:grid-cols-2 gap-5"
      >
        {/* Chart 01: Daily Calling Volume Trend (Smooth Spline AreaChart) */}
        <div
          data-testid="chart-daily-calling-volume"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                01. Daily Calling Volume Trend
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {focusedView.effectiveMode === 'ALL_TEAM'
                  ? 'Smooth team calling curve against Per-Rep Daily Average'
                  : focusedView.effectiveMode === 'ISOLATED_REP'
                    ? `Isolated daily curve for ${isolatedRepMeta?.shortName || 'Rep'} vs. Team Average`
                    : `Smooth day-by-day calling curves (${focusedView.visibleRepSeries.length} reps displayed)`}
              </p>
            </div>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
              {report.dailyCallingVolumeByRep.length} Days
            </span>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={report.dailyCallingVolumeByRep}
                margin={{ top: 10, right: 14, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradTotalTeamCalls"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#D4AF37" stopOpacity={0.0} />
                  </linearGradient>
                  {focusedView.visibleRepSeries.map((rep, idx) => (
                    <linearGradient
                      key={rep.repEmail}
                      id={`gradRepCalls-${idx}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={rep.color}
                        stopOpacity={0.22}
                      />
                      <stop
                        offset="95%"
                        stopColor={rep.color}
                        stopOpacity={0.0}
                      />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148, 163, 184, 0.15)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.2)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0F131A',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#F8FAFC',
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                />

                {focusedView.effectiveMode === 'ALL_TEAM' ? (
                  <Area
                    type="monotone"
                    dataKey="totalCalls"
                    name="Total Team Output"
                    stroke="#D4AF37"
                    strokeWidth={2.5}
                    fill="url(#gradTotalTeamCalls)"
                    dot={{ r: 3, strokeWidth: 2 }}
                    activeDot={{ r: 5 }}
                  />
                ) : (
                  focusedView.visibleRepSeries.map((rep, idx) => (
                    <Area
                      key={rep.repEmail}
                      type="monotone"
                      dataKey={rep.repEmail}
                      name={rep.shortName}
                      stroke={rep.color}
                      strokeWidth={2.5}
                      fill={`url(#gradRepCalls-${idx})`}
                      dot={{ r: 3, strokeWidth: 2 }}
                      activeDot={{ r: 5 }}
                    />
                  ))
                )}

                {/* Dashed Per-Rep Daily Average Reference Curve */}
                <Line
                  type="monotone"
                  dataKey="perRepDailyAverage"
                  name="Per-Rep Daily Average"
                  stroke="#94A3B8"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 02: Interested Leads vs. New Leads Added (Smooth Overlapping Spline AreaChart) */}
        <div
          data-testid="chart-interested-vs-new-leads"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                02. Interested Leads vs. New Leads Added
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Three smooth spline curves: Interested (#D4AF37), New Leads (+ Add Lead), and Closed Won
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
              <div className="inline-flex rounded-lg border border-neutral-200 dark:border-neutral-800 p-0.5 text-[10px] whitespace-nowrap">
                <button
                  type="button"
                  data-testid="chart2-axis-timeline"
                  onClick={() => setChart2AxisMode('TIMELINE')}
                  className={`px-2 py-0.5 rounded-md cursor-pointer whitespace-nowrap ${
                    chart2AxisMode === 'TIMELINE'
                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                  }`}
                >
                  By Date
                </button>
                <button
                  type="button"
                  data-testid="chart2-axis-by-rep"
                  onClick={() => setChart2AxisMode('BY_REP')}
                  className={`px-2 py-0.5 rounded-md cursor-pointer whitespace-nowrap ${
                    chart2AxisMode === 'BY_REP'
                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                  }`}
                >
                  By Rep
                </button>
              </div>
              <div className="hidden sm:flex items-center gap-2 text-[11px] font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                <span>Int: {focusedView.focusedTotals.interestedGenerated}</span>
                <span>·</span>
                <span>Added: {focusedView.focusedTotals.newLeadsAdded}</span>
              </div>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chart2Data}
                margin={{ top: 10, right: 14, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradInterestedGold"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#D4AF37" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient
                    id="gradNewLeadsBlue"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient
                    id="gradClosedWonEmerald"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148, 163, 184, 0.15)"
                />
                <XAxis
                  dataKey="xAxisLabel"
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.2)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0F131A',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#F8FAFC',
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                />
                <Area
                  type="monotone"
                  dataKey="interestedGenerated"
                  name="Interested Generated"
                  stroke="#D4AF37"
                  strokeWidth={2.5}
                  fill="url(#gradInterestedGold)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
                <Area
                  type="monotone"
                  dataKey="newLeadsAdded"
                  name="New Leads Added (+ Add Lead)"
                  stroke="#3B82F6"
                  strokeWidth={2.5}
                  fill="url(#gradNewLeadsBlue)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
                <Area
                  type="monotone"
                  dataKey="convertedToClientsWon"
                  name="Converted to Clients (Closed Won)"
                  stroke="#10B981"
                  strokeWidth={2.5}
                  fill="url(#gradClosedWonEmerald)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
                {chart2AxisMode === 'TIMELINE' &&
                  focusedView.effectiveMode === 'ISOLATED_REP' && (
                    <Line
                      type="monotone"
                      dataKey="teamAvgInterested"
                      name="Team Avg Interested"
                      stroke="#94A3B8"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 03: Full Pipeline Conversion Velocity (Smooth Monotone AreaChart with Gold-to-Emerald Gradient) */}
        <div
          data-testid="chart-pipeline-conversion-funnel"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                03. Full Pipeline Conversion Velocity
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Total Dialed &rarr; Proposals Shared &rarr; Interested (Owner Queue) &rarr; Closed Won
              </p>
            </div>
          </div>

          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={focusedView.focusedPipelineFunnel}
                margin={{ top: 10, right: 18, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradPipelineGoldEmerald"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.22} />
                    <stop offset="60%" stopColor="#10B981" stopOpacity={0.12} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148, 163, 184, 0.15)"
                />
                <XAxis
                  dataKey="shortStage"
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.2)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0F131A',
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#F8FAFC',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="Pipeline Leads"
                  stroke="#D4AF37"
                  strokeWidth={2.5}
                  fill="url(#gradPipelineGoldEmerald)"
                  dot={{ r: 3, strokeWidth: 2, fill: '#10B981' }}
                  activeDot={{ r: 5 }}
                />
                {focusedView.effectiveMode === 'ISOLATED_REP' && (
                  <Line
                    type="monotone"
                    dataKey="teamAverageCount"
                    name="Per-Rep Team Avg"
                    stroke="#94A3B8"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* 4 Clean Percentage Summary Callouts Along the Bottom Footer */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            {focusedView.focusedPipelineFunnel.map((stage) => (
              <div key={stage.stage} className="text-xs">
                <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                  {stage.shortStage}
                </div>
                <div className="font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
                  {stage.count.toLocaleString()}{' '}
                  <span className="text-[10px] font-normal text-slate-500">
                    ({stage.conversionFromPrevPct.toFixed(1)}%)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chart 04: Call Disposition Breakdown (Minimal Donut + Distribution Bar) */}
        <div
          data-testid="chart-call-disposition-breakdown"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                04. Call Disposition Breakdown
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Proportional split across call outcomes (
                {totalDispositionCount.toLocaleString()} logged outcomes)
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={
                      totalDispositionCount > 0
                        ? report.callDispositionBreakdown
                        : [{ name: 'No Calls Yet', count: 1, color: '#334155' }]
                    }
                    dataKey="count"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={74}
                    paddingAngle={2}
                  >
                    {(totalDispositionCount > 0
                      ? report.callDispositionBreakdown
                      : [{ name: 'No Calls Yet', count: 1, color: '#334155' }]
                    ).map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0F131A',
                      borderColor: 'rgba(255,255,255,0.12)',
                      borderRadius: '8px',
                      fontSize: '11px',
                      color: '#F8FAFC',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2">
              {report.callDispositionBreakdown.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-xs shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-slate-700 dark:text-slate-300 truncate">
                      {item.name}
                    </span>
                  </div>
                  <div className="font-mono text-xs tabular-nums text-slate-900 dark:text-white shrink-0">
                    {item.count.toLocaleString()}{' '}
                    <span className="text-[11px] text-slate-500">
                      ({item.percentage.toFixed(1)}%)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
