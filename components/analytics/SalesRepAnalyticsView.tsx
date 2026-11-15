'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  AnalyticsDateFilter,
  computeSalesRepAnalyticsPure,
} from '@/lib/performanceAnalytics';
import {
  DailyRepStatRecord,
  fetchDailyStatsFromFirestore,
} from '@/lib/dailyStatsService';
import { AuthorizedUser, LeadRecord } from '@/lib/types';

export interface SalesRepAnalyticsViewProps {
  leads: LeadRecord[];
  currentUser: AuthorizedUser;
  dateFilter: AnalyticsDateFilter;
  dailyTarget?: number;
  dailyStats?: DailyRepStatRecord[];
}

export function SalesRepAnalyticsView({
  leads,
  currentUser,
  dateFilter,
  dailyStats,
}: SalesRepAnalyticsViewProps) {
  const [fetchedDailyStats, setFetchedDailyStats] = useState<DailyRepStatRecord[]>([]);

  useEffect(() => {
    let isMounted = true;
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

  const effectiveDailyStats = dailyStats ?? fetchedDailyStats;

  const report = useMemo(
    () =>
      computeSalesRepAnalyticsPure(
        leads,
        currentUser.email,
        currentUser.name,
        dateFilter,
        120,
        undefined,
        effectiveDailyStats
      ),
    [leads, currentUser.email, currentUser.name, dateFilter, effectiveDailyStats]
  );

  return (
    <div data-testid="sales-rep-analytics-view" className="space-y-6">
      {/* A. Personal KPI Summary Strip (5 compact Zerodha-style metric boxes) */}
      <section
        aria-label="Personal KPI Summary Strip"
        data-testid="sales-rep-kpi-strip"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3.5"
      >
        {/* 1. My Calls (Selected Period) */}
        <div
          data-testid="kpi-my-calls-period"
          className="p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 min-w-0"
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            My Calls (Selected Period)
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 sm:mt-1">
            {report.kpiStrip.myCallsSelectedPeriod.toLocaleString()}
          </div>
          <div className="text-[10px] sm:text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 sm:mt-1 truncate">
            Today&apos;s Calls: {report.kpiStrip.myCallsToday.toLocaleString()}
          </div>
        </div>

        {/* 2. New Leads Added by Me */}
        <div
          data-testid="kpi-new-leads-added"
          className="p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 min-w-0"
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            New Leads Added by Me
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-blue-600 dark:text-blue-400 mt-0.5 sm:mt-1">
            {report.kpiStrip.newLeadsAddedByMe.toLocaleString()}
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 sm:mt-1 truncate">
            Self-sourced via + Add Lead
          </div>
        </div>

        {/* 3. Proposals Shared */}
        <div
          data-testid="kpi-proposals-shared"
          className="p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 min-w-0"
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Proposals Shared
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-0.5 sm:mt-1">
            {report.kpiStrip.proposalsShared.toLocaleString()}
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 sm:mt-1 truncate">
            Active proposal pipeline
          </div>
        </div>

        {/* 4. Converted to Interested */}
        <div
          data-testid="kpi-converted-to-interested"
          className="p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-[#D4AF37]/40 min-w-0"
        >
          <div className="text-[10px] sm:text-[11px] font-semibold text-amber-600 dark:text-[#D4AF37] truncate">
            Converted to Interested
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 sm:mt-1">
            {report.kpiStrip.convertedToInterested.toLocaleString()}
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 sm:mt-1 truncate">
            Handed over to Owner Queue
          </div>
        </div>

        {/* 5. Interested Converted to Clients */}
        <div
          data-testid="kpi-interested-converted-to-clients"
          className="p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-emerald-500/35 col-span-2 sm:col-span-1 min-w-0"
        >
          <div className="text-[10px] sm:text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 truncate">
            Interested Converted to Clients
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-0.5 sm:mt-1">
            {report.kpiStrip.interestedConvertedToClients.toLocaleString()}
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 sm:mt-1 truncate">
            Closed Won by Owner
          </div>
        </div>
      </section>

      {/* B. Personal Performance Charts (3 Smooth Curved Spline AreaChart Cards) */}
      <section
        aria-label="Personal Performance Charts"
        data-testid="sales-rep-charts-grid"
        className="grid grid-cols-1 lg:grid-cols-2 gap-5"
      >
        {/* Chart 01: My Daily Calling Trend (Smooth Spline AreaChart) */}
        <div
          data-testid="chart-my-daily-calling-trend"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                01. My Daily Calling Trend
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Smooth day-by-day calling trajectory ({report.bounds.startDateStr} to{' '}
                {report.bounds.endDateStr})
              </p>
            </div>
            <span className="text-[11px] font-mono text-amber-600 dark:text-[#D4AF37]">
              Total: {report.kpiStrip.myCallsSelectedPeriod.toLocaleString()} calls
            </span>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={report.myDailyCallingTrend}
                margin={{ top: 12, right: 16, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradMyCallingTrend"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#D4AF37" stopOpacity={0.0} />
                  </linearGradient>
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
                <Area
                  type="monotone"
                  dataKey="callsDialed"
                  name="Calls Dialed"
                  stroke="#D4AF37"
                  strokeWidth={2.5}
                  fill="url(#gradMyCallingTrend)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 02: My Conversion Pipeline (Smooth Stage-to-Stage Spline Curve) */}
        <div
          data-testid="chart-my-conversion-pipeline"
          className="p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                02. My Conversion Pipeline (Dialed &rarr; Interested &rarr; Won Clients)
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Calls Made &rarr; Proposals Shared &rarr; Clients Converted to Interested &rarr; Final Clients (Won)
              </p>
            </div>
          </div>

          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={report.myConversionPipeline}
                margin={{ top: 10, right: 18, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradMyPipelineVelocity"
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
                  name="My Pipeline Leads"
                  stroke="#D4AF37"
                  strokeWidth={2.5}
                  fill="url(#gradMyPipelineVelocity)"
                  dot={{ r: 3, strokeWidth: 2, fill: '#10B981' }}
                  activeDot={{ r: 5 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Exact Stage-to-Stage Conversion Percentages */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            {report.myConversionPipeline.map((stage) => (
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

        {/* Chart 03: My Daily Activity Breakdown (Smooth Overlapping Spline AreaChart) */}
        <div
          data-testid="chart-my-daily-activity-breakdown"
          className="lg:col-span-2 p-4 rounded-xl bg-white dark:bg-[#11141B] border border-neutral-200 dark:border-neutral-800 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                03. My Daily Activity Breakdown
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Smooth day-by-day curves of Calls Dialed, New Leads Added (+ Add Lead), and Interested Leads Generated
              </p>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={report.myDailyActivityBreakdown}
                margin={{ top: 10, right: 16, left: -16, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="gradRepCallsDialed"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#64748B" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#64748B" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient
                    id="gradRepNewLeadsAdded"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient
                    id="gradRepInterestedGen"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#D4AF37" stopOpacity={0.0} />
                  </linearGradient>
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
                <Area
                  type="monotone"
                  dataKey="callsDialed"
                  name="Calls Dialed"
                  stroke="#64748B"
                  strokeWidth={2.5}
                  fill="url(#gradRepCallsDialed)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
                <Area
                  type="monotone"
                  dataKey="newLeadsAdded"
                  name="New Leads Added"
                  stroke="#3B82F6"
                  strokeWidth={2.5}
                  fill="url(#gradRepNewLeadsAdded)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
                <Area
                  type="monotone"
                  dataKey="interestedGenerated"
                  name="Interested Leads Generated"
                  stroke="#D4AF37"
                  strokeWidth={2.5}
                  fill="url(#gradRepInterestedGen)"
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}
