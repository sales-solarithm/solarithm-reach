'use client';

import React from 'react';
import {
  OwnerMetricStripData,
  SalesRepMetricStripData,
} from '@/lib/dashboardMetrics';

export interface MetricCardsProps {
  isOwner: boolean;
  ownerMetrics: OwnerMetricStripData;
  salesMetrics: SalesRepMetricStripData;
  activeStatusFilter?: string;
  onSelectStatusFilter?: (status: string) => void;
}

/**
 * Adaptive Status Metric Cards (Zerodha Kite Style)
 * - Mobile: grid-cols-2 (2 compact tiles per row, scaled padding & typography)
 * - Tablet: sm:grid-cols-3 / md:grid-cols-4
 * - Desktop: lg:grid-cols-6 (Owner) or lg:grid-cols-4 (Sales Rep)
 */
export function MetricCards({
  isOwner,
  ownerMetrics,
  salesMetrics,
  activeStatusFilter,
  onSelectStatusFilter,
}: MetricCardsProps) {
  if (isOwner) {
    return (
      <section
        aria-label="Owner Status Metric Strip"
        data-testid="owner-metric-strip"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3"
      >
        {/* 1. Total Fresh Pool */}
        <div
          data-testid="owner-fresh-pool-metric-tile"
          onClick={() => onSelectStatusFilter?.('FRESH')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
            activeStatusFilter === 'FRESH'
              ? 'border-amber-500 ring-1 ring-amber-500/30'
              : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Total Fresh Pool
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 sm:mt-1">
            {ownerMetrics.totalFreshPool.toLocaleString()}
          </div>
        </div>

        {/* 2. Proposals Shared */}
        <div
          data-testid="owner-proposals-metric-tile"
          onClick={() => onSelectStatusFilter?.('PROPOSAL_SHARED')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
            activeStatusFilter === 'PROPOSAL_SHARED'
              ? 'border-sky-500 ring-1 ring-sky-500/30'
              : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Proposals Shared
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-0.5 sm:mt-1">
            {ownerMetrics.proposalsShared.toLocaleString()}
          </div>
        </div>

        {/* 3. Interested (Owner Queue) — Highlighted with subtle gold border #E5B842 */}
        <div
          data-testid="owner-interested-metric-tile"
          onClick={() => onSelectStatusFilter?.('INTERESTED')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-[#E5B842] cursor-pointer hover:bg-[#E5B842]/[0.06] transition-colors min-w-0 ${
            activeStatusFilter === 'INTERESTED'
              ? 'ring-2 ring-[#E5B842]/60 bg-[#E5B842]/[0.08]'
              : 'bg-[#E5B842]/[0.03]'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-semibold text-amber-600 dark:text-[#E5B842] leading-tight">
            Interested (Owner Queue)
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-amber-600 dark:text-[#E5B842] mt-0.5 sm:mt-1">
            {ownerMetrics.interestedOwnerQueue.toLocaleString()}
          </div>
        </div>

        {/* 4. Future Requirement */}
        <div
          data-testid="owner-future-metric-tile"
          onClick={() => onSelectStatusFilter?.('FUTURE_REQUIREMENT')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
            activeStatusFilter === 'FUTURE_REQUIREMENT'
              ? 'border-indigo-500 ring-1 ring-indigo-500/30'
              : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Future Requirement
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-indigo-600 dark:text-indigo-400 mt-0.5 sm:mt-1">
            {ownerMetrics.futureRequirement.toLocaleString()}
          </div>
        </div>

        {/* 5. Calls Dialed Today */}
        <div
          data-testid="owner-calls-today-metric-tile"
          onClick={() => onSelectStatusFilter?.('CALLS_DIALED_TODAY')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
            activeStatusFilter === 'CALLS_DIALED_TODAY'
              ? 'border-emerald-500 ring-1 ring-emerald-500/30'
              : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Calls Dialed Today
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-0.5 sm:mt-1">
            {ownerMetrics.callsDialedToday.toLocaleString()}
          </div>
        </div>

        {/* 6. Dead / Closed Out */}
        <div
          data-testid="owner-dead-closed-metric-tile"
          onClick={() => onSelectStatusFilter?.('DEAD_CLOSED_OUT')}
          className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
            activeStatusFilter === 'DEAD_CLOSED_OUT'
              ? 'border-red-500/70 ring-1 ring-red-500/30'
              : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
          }`}
        >
          <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
            Dead / Closed Out
          </div>
          <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-600 dark:text-slate-300 mt-0.5 sm:mt-1">
            {ownerMetrics.deadClosedOut.toLocaleString()}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Sales Rep Status Metric Strip"
      data-testid="sales-metric-strip"
      className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-5 gap-2.5 sm:gap-3"
    >
      {/* 1. Batch Leads Remaining */}
      <div
        data-testid="sales-batch-remaining-metric-tile"
        onClick={() => onSelectStatusFilter?.('FRESH')}
        className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
          activeStatusFilter === 'FRESH'
            ? 'border-amber-500 ring-1 ring-amber-500/30'
            : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
        }`}
      >
        <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
          Batch Leads Remaining
        </div>
        <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 sm:mt-1">
          {salesMetrics.batchLeadsRemaining.toLocaleString()}
        </div>
      </div>

      {/* 2. My Calls Today */}
      <div
        data-testid="sales-calls-today-metric-tile"
        onClick={() => onSelectStatusFilter?.('CALLS_DIALED_TODAY')}
        className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
          activeStatusFilter === 'CALLS_DIALED_TODAY'
            ? 'border-amber-500 ring-1 ring-amber-500/30'
            : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
        }`}
      >
        <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
          My Calls Today
        </div>
        <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-amber-600 dark:text-[#E5B842] mt-0.5 sm:mt-1">
          {salesMetrics.myCallsToday.toLocaleString()}
        </div>
      </div>

      {/* 3. Proposals Pending Follow-up */}
      <div
        data-testid="sales-proposals-metric-tile"
        onClick={() => onSelectStatusFilter?.('PROPOSAL_SHARED')}
        className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 ${
          activeStatusFilter === 'PROPOSAL_SHARED'
            ? 'border-sky-500 ring-1 ring-sky-500/30'
            : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
        }`}
      >
        <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
          Proposals Pending Follow-up
        </div>
        <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-0.5 sm:mt-1">
          {salesMetrics.proposalsPendingFollowUp.toLocaleString()}
        </div>
      </div>

      {/* 4. Interested (Owner Queue) — Highlighted with subtle gold border #E5B842 */}
      <div
        data-testid="sales-interested-metric-tile"
        onClick={() => onSelectStatusFilter?.('INTERESTED')}
        className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border border-[#E5B842] cursor-pointer hover:bg-[#E5B842]/[0.06] transition-colors min-w-0 ${
          activeStatusFilter === 'INTERESTED'
            ? 'ring-2 ring-[#E5B842]/60 bg-[#E5B842]/[0.08]'
            : 'bg-[#E5B842]/[0.03]'
        }`}
      >
        <div className="text-[10px] sm:text-[11px] font-semibold text-amber-600 dark:text-[#E5B842] leading-tight">
          Interested (Owner Queue)
        </div>
        <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-amber-600 dark:text-[#E5B842] mt-0.5 sm:mt-1">
          {(salesMetrics.interestedCount ?? 0).toLocaleString()}
        </div>
      </div>

      {/* 5. Future Requirements Due */}
      <div
        data-testid="sales-future-metric-tile"
        onClick={() => onSelectStatusFilter?.('FUTURE_REQUIREMENT')}
        className={`p-2.5 sm:p-3.5 rounded-xl bg-white dark:bg-[#11141B] border cursor-pointer transition-colors min-w-0 col-span-2 sm:col-span-1 ${
          activeStatusFilter === 'FUTURE_REQUIREMENT'
            ? 'border-indigo-500 ring-1 ring-indigo-500/30'
            : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
        }`}
      >
        <div className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
          Future Requirements Due
        </div>
        <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-indigo-600 dark:text-indigo-400 mt-0.5 sm:mt-1">
          {salesMetrics.futureRequirementsDue.toLocaleString()}
        </div>
      </div>
    </section>
  );
}
