'use client';

import React, { useState } from 'react';
import { X, Phone, MapPin, Clock, Flame, Pencil } from 'lucide-react';
import {
  AuthorizedUser,
  LeadRecord,
  LeadStatus,
  OwnerSubStatus,
} from '@/lib/types';
import { sanitizeIndianPhone } from '@/lib/phoneSanitizer';
import {
  formatCoEscalatedPillText,
  formatOwnerSubStatusBadgePure,
  stripSystemIngestionNotePure,
} from '@/lib/leadStore';
import { Drawer } from '@/components/shared/Drawer';
import { formatRepName } from '@/lib/utils';

export interface CallingTableProps {
  leads: LeadRecord[];
  currentUser: AuthorizedUser;
  selectedLead: LeadRecord | null;
  emptyStateMessage?: string;
  onSelectLead: (lead: LeadRecord | null) => void;
  onUpdateCompanyName?: (leadId: string, newCompanyName: string) => void;
  onSaveCallUpdate: (params: {
    leadId: string;
    newStatus: LeadStatus;
    ownerSubStatus?: OwnerSubStatus;
    callDate: string;
    notes: string;
    loadNext: boolean;
    editedCompanyName?: string;
  }) => void;
}

export function formatDisplayPhone(lead: LeadRecord): string {
  if (lead.formattedPhone && lead.formattedPhone.startsWith('+91 ')) {
    return lead.formattedPhone;
  }
  const res = sanitizeIndianPhone(lead.phoneNumber);
  return res.isValid ? res.formatted : `+91 ${lead.phoneNumber}`;
}

export function formatTelHref(lead: LeadRecord): string {
  const res = sanitizeIndianPhone(lead.phoneNumber);
  const digits = res.isValid ? res.cleaned : String(lead.phoneNumber || '').replace(/\D/g, '');
  return `tel:+91${digits}`;
}

export function formatCityState(lead: LeadRecord): string {
  const parts = [lead.city, lead.state].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

export function formatLastCalledDate(lastCalledDate: string | null): string {
  if (!lastCalledDate) return 'Never';
  return lastCalledDate.slice(0, 10);
}

export function formatLastCalledByRepNamePure(lead: LeadRecord): string {
  const raw = lead.lastCalledByName || lead.assignedRepName || '';
  return formatRepName(raw);
}

export function formatRetryCooldownSummaryPure(lead: LeadRecord): {
  attempts: number;
  didntReceiveCount: number;
  switchOffCount: number;
  hasRetries: boolean;
  summaryText: string;
} {
  const attempts = Number(lead.callAttempts || 0);
  const didntReceiveCount = Number(lead.didntReceiveCount || 0);
  const switchOffCount = Number(lead.switchOffCount || 0);
  const hasRetries = didntReceiveCount > 0 || switchOffCount > 0;
  const parts: string[] = [];
  if (didntReceiveCount > 0) {
    parts.push(`Didn't Receive: ${didntReceiveCount}`);
  }
  if (switchOffCount > 0) {
    parts.push(`Switch Off: ${switchOffCount}`);
  }
  return {
    attempts,
    didntReceiveCount,
    switchOffCount,
    hasRetries,
    summaryText:
      parts.length > 0
        ? parts.join(' · ')
        : 'Didn\'t Receive: 0 · Switch Off: 0',
  };
}

export function getStatusPillClasses(status: LeadStatus): string {
  switch (status) {
    case 'FRESH':
    case 'REVIVED_FRESH':
      return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20';
    case 'INTERESTED':
      return 'bg-amber-400/15 text-amber-700 dark:text-[#E5B842] border-amber-400/35';
    case 'PROPOSAL_SHARED':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30';
    case 'FUTURE_REQUIREMENT':
      return 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30';
    case 'CLOSED_WON':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
    case 'DIDNT_RECEIVE':
    case 'SWITCH_OFF':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25';
    default:
      return 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/25';
  }
}

export const CALLING_TABLE_PAGE_SIZE = 50;

export function paginateCallingLeadsPure(
  leads: LeadRecord[],
  currentPage: number,
  pageSize: number = CALLING_TABLE_PAGE_SIZE
): {
  paginatedLeads: LeadRecord[];
  currentPage: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  totalCount: number;
} {
  const safePageSize = Math.min(CALLING_TABLE_PAGE_SIZE, Math.max(1, pageSize));
  const totalCount = leads.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const clampedPage = Math.min(Math.max(1, currentPage), totalPages);
  const startOffset = (clampedPage - 1) * safePageSize;
  const paginatedLeads = leads.slice(startOffset, startOffset + safePageSize);
  const startIndex = totalCount === 0 ? 0 : startOffset + 1;
  const endIndex = totalCount === 0 ? 0 : startOffset + paginatedLeads.length;

  return {
    paginatedLeads,
    currentPage: clampedPage,
    totalPages,
    startIndex,
    endIndex,
    totalCount,
  };
}

export interface LeadNoteHistoryTimelineItem {
  id: string;
  repName: string;
  timestamp: string;
  noteText: string;
  statusLabel?: string;
}

export function buildLeadNotesActivityHistoryPure(
  lead: LeadRecord | null | undefined
): LeadNoteHistoryTimelineItem[] {
  if (!lead) return [];
  const items: LeadNoteHistoryTimelineItem[] = [];
  const seenTexts = new Set<string>();

  if (Array.isArray(lead.callHistory) && lead.callHistory.length > 0) {
    const sorted = [...lead.callHistory].sort((a, b) =>
      String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
    );
    for (const entry of sorted) {
      const cleaned = stripSystemIngestionNotePure(entry.note);
      if (!cleaned) continue;
      seenTexts.add(cleaned);
      const repDisplay = formatRepName(
        entry.repName || entry.repEmail || lead.lastCalledByName || lead.assignedRepName || 'Sales Rep'
      );
      const rawTs = String(entry.timestamp || '');
      const formattedTs = rawTs.includes('T')
        ? rawTs.slice(0, 16).replace('T', ' ')
        : rawTs.slice(0, 10) || 'Recorded';
      items.push({
        id: entry.id || `${rawTs}-${items.length}`,
        repName: repDisplay,
        timestamp: formattedTs,
        noteText: cleaned,
        statusLabel: entry.newStatus,
      });
    }
  }

  const legacyNotes = stripSystemIngestionNotePure(lead.notes);
  if (legacyNotes && items.length === 0) {
    const fallbackRep = formatRepName(
      lead.lastCalledByName || lead.assignedRepName || 'Sales Rep'
    );
    const fallbackTs = String(
      lead.lastCalledDate || lead.updatedAt || lead.createdAt || ''
    ).slice(0, 10);
    const segments = legacyNotes
      .split(/\s*\|\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      if (seenTexts.has(segments[i])) continue;
      items.push({
        id: `legacy-note-${i}`,
        repName: fallbackRep,
        timestamp: fallbackTs || 'Recorded',
        noteText: segments[i],
      });
    }
  }

  return items;
}

export function CallingTable({
  leads,
  currentUser,
  selectedLead,
  emptyStateMessage = 'No leads in current view.',
  onSelectLead,
  onUpdateCompanyName,
  onSaveCallUpdate,
}: CallingTableProps) {
  const roleUpper = String(currentUser.role || '').trim().toUpperCase();
  const isOwner = Boolean(
    currentUser.isOwnerTier || roleUpper === 'OWNER' || roleUpper === 'ADMIN'
  );

  const [currentPage, setCurrentPage] = useState<number>(1);
  const [drawerStatus, setDrawerStatus] = useState<LeadStatus | ''>('');
  const [drawerOwnerSubStatus, setDrawerOwnerSubStatus] =
    useState<OwnerSubStatus>('PENDING_FIRST_CALL');
  const [drawerCallDate, setDrawerCallDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [drawerNotes, setDrawerNotes] = useState<string>('');
  const [isEditingCompanyName, setIsEditingCompanyName] = useState<boolean>(false);
  const [draftCompanyName, setDraftCompanyName] = useState<string>('');
  const [lastSelectedLeadId, setLastSelectedLeadId] = useState<string | null>(null);

  if (selectedLead && selectedLead.id !== lastSelectedLeadId) {
    setLastSelectedLeadId(selectedLead.id);
    setDrawerStatus('');
    const initialSubStatus: OwnerSubStatus =
      selectedLead.ownerSubStatus &&
      selectedLead.ownerSubStatus !== 'WON' &&
      selectedLead.ownerSubStatus !== 'LOST'
        ? selectedLead.ownerSubStatus
        : 'PENDING_FIRST_CALL';
    setDrawerOwnerSubStatus(initialSubStatus);
    setDrawerCallDate(new Date().toISOString().slice(0, 10));
    setDrawerNotes('');
    setIsEditingCompanyName(false);
    setDraftCompanyName(selectedLead.companyName);
  } else if (!selectedLead && lastSelectedLeadId !== null) {
    setLastSelectedLeadId(null);
    setIsEditingCompanyName(false);
    setDraftCompanyName('');
  }

  const handleApplyCompanyNameOnly = () => {
    if (!selectedLead) return;
    const trimmed = draftCompanyName.trim();
    if (!trimmed) {
      setDraftCompanyName(selectedLead.companyName);
      setIsEditingCompanyName(false);
      return;
    }
    if (trimmed !== selectedLead.companyName) {
      onUpdateCompanyName?.(selectedLead.id, trimmed);
    }
    setIsEditingCompanyName(false);
  };

  const getPendingEditedCompanyName = (): string | undefined => {
    if (!selectedLead) return undefined;
    const trimmed = draftCompanyName.trim();
    if (trimmed && trimmed !== selectedLead.companyName) {
      return trimmed;
    }
    return undefined;
  };

  const pagination = paginateCallingLeadsPure(leads, currentPage, CALLING_TABLE_PAGE_SIZE);
  // Hard cap to 50 rows max in the DOM at one time
  const pageLeads = pagination.paginatedLeads.slice(0, CALLING_TABLE_PAGE_SIZE);
  const isEditingInterestedLead = selectedLead?.status === 'INTERESTED';

  return (
    <>
      <div
        data-testid="calling-table-container"
        className="bg-white dark:bg-[#11141B] border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden"
      >
        {/* 4.A Desktop View (hidden md:block): High-density Zerodha-style table layout */}
        <div className="hidden md:block overflow-x-auto">
          <table
            data-testid="calling-queue-table"
            className="w-full text-left border-collapse"
          >
            <thead>
              <tr className="h-[38px] border-b border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-[#0D1016] text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-3.5 py-2">Company Name</th>
                <th className="px-3.5 py-2">Phone Number</th>
                <th className="px-3.5 py-2">City, State</th>
                <th className="px-3.5 py-2">Attempts &amp; Retries</th>
                <th className="px-3.5 py-2">Last Called By</th>
                <th className="px-3.5 py-2">Last Called</th>
                <th className="px-3.5 py-2">Status</th>
                <th className="px-3.5 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
              {pageLeads.length === 0 ? (
                <tr className="h-[48px]">
                  <td
                    colSpan={8}
                    data-testid="calling-table-empty-state"
                    className="px-4 py-7 text-center text-xs text-slate-500 dark:text-slate-400"
                  >
                    {emptyStateMessage}
                  </td>
                </tr>
              ) : (
                pageLeads.map((lead) => {
                  const coEscalatedPill = formatCoEscalatedPillText(lead);
                  const isReadOnlyHandover = !isOwner && lead.status === 'INTERESTED';
                  const isInterestedLead = lead.status === 'INTERESTED';
                  const ownerSubBadge = isInterestedLead
                    ? formatOwnerSubStatusBadgePure(lead.ownerSubStatus)
                    : null;
                  const originatingRepShort = lead.assignedRepName
                    ? formatRepName(lead.assignedRepName)
                    : null;
                  const retryInfo = formatRetryCooldownSummaryPure(lead);
                  const lastCalledByLabel = formatLastCalledByRepNamePure(lead);

                  return (
                    <tr
                      key={lead.id}
                      data-testid={`calling-row-${lead.id}`}
                      onClick={() => {
                        if (!isReadOnlyHandover) onSelectLead(lead);
                      }}
                      className={`h-[39px] hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors ${
                        isReadOnlyHandover ? 'cursor-default' : 'cursor-pointer'
                      }`}
                    >
                      {/* 1. Company Name (Bold, clean text) */}
                      <td className="px-3.5 py-1.5 font-semibold text-slate-900 dark:text-white max-w-[280px]">
                        <div className="truncate">{lead.companyName}</div>
                        {coEscalatedPill && (
                          <span
                            data-testid={`co-escalated-pill-${lead.id}`}
                            className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[10px] font-mono font-semibold text-emerald-700 dark:text-emerald-300"
                          >
                            <Flame className="w-3 h-3 text-amber-500 shrink-0" />
                            <span>{coEscalatedPill}</span>
                          </span>
                        )}
                      </td>

                      {/* 2. Phone Number (Display formatted: +91 XXXXX XXXXX, click to open drawer) */}
                      <td className="px-3.5 py-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          data-testid={`phone-trigger-${lead.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!isReadOnlyHandover) onSelectLead(lead);
                          }}
                          className="font-mono text-xs font-medium text-amber-600 dark:text-[#E5B842] hover:underline cursor-pointer"
                        >
                          {formatDisplayPhone(lead)}
                        </button>
                      </td>

                      {/* 3. City, State */}
                      <td className="px-3.5 py-1.5 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatCityState(lead)}
                      </td>

                      {/* 4. Attempts & Retries (Total Call Attempts + Didn't Receive / Switch Off cycle count) */}
                      <td
                        data-testid={`attempts-retries-cell-${lead.id}`}
                        className="px-3.5 py-1.5 font-mono text-[11px] whitespace-nowrap"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-700 dark:text-slate-300 tabular-nums">
                            Attempts: {retryInfo.attempts}
                          </span>
                          {(retryInfo.hasRetries || isOwner) && (
                            <span
                              data-testid={`retry-cooldown-badge-${lead.id}`}
                              className={`px-1.5 py-0.5 rounded border text-[10px] tabular-nums ${
                                retryInfo.hasRetries
                                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300 font-semibold'
                                  : 'bg-slate-50 dark:bg-white/[0.03] border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {retryInfo.summaryText}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 5. Last Called By (Rep Name) */}
                      <td
                        data-testid={`last-called-by-cell-${lead.id}`}
                        className="px-3.5 py-1.5 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap"
                      >
                        {lastCalledByLabel}
                      </td>

                      {/* 6. Last Called (Date or "Never") */}
                      <td className="px-3.5 py-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {formatLastCalledDate(lead.lastCalledDate)}
                      </td>

                      {/* 7. Status (Minimal colored text pill + Owner Closing Sub-Status & Rep Attribution on INTERESTED) */}
                      <td className="px-3.5 py-1.5 whitespace-nowrap">
                        {isInterestedLead && ownerSubBadge ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              data-testid={`owner-substatus-badge-${lead.id}`}
                              className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${ownerSubBadge.classes}`}
                            >
                              {ownerSubBadge.label}
                            </span>
                            {originatingRepShort && (
                              <span
                                data-testid={`originating-rep-badge-${lead.id}`}
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-[10px] font-mono text-slate-600 dark:text-slate-300"
                              >
                                By: {originatingRepShort}
                              </span>
                            )}
                            <span
                              data-testid={`owner-attempts-badge-${lead.id}`}
                              className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-[10px] font-mono text-slate-500 dark:text-slate-400 tabular-nums"
                            >
                              Owner Attempts: {lead.ownerCallAttempts || 0}
                            </span>
                          </div>
                        ) : (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${getStatusPillClasses(
                              lead.status
                            )}`}
                          >
                            {lead.status}
                          </span>
                        )}
                      </td>

                      {/* 8. Action (Simple button: [Call / Update] or Read-Only Handover badge) */}
                      <td className="px-3.5 py-1.5 text-right whitespace-nowrap">
                        {isReadOnlyHandover ? (
                          <span
                            data-testid={`readonly-handover-badge-${lead.id}`}
                            className="inline-flex items-center px-2 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-[10px] font-mono font-medium text-amber-700 dark:text-amber-300"
                          >
                            Handed Over to Owner
                          </span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`call-update-btn-${lead.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectLead(lead);
                            }}
                            className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.09] text-[11px] font-medium text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
                          >
                            Call / Update
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 4.B Mobile View (block md:hidden): Touch-friendly Card Stack */}
        <div
          data-testid="calling-mobile-card-list"
          className="block md:hidden divide-y divide-slate-200 dark:divide-white/10"
        >
          {pageLeads.length === 0 ? (
            <div
              data-testid="calling-mobile-empty-state"
              className="px-4 py-8 text-center text-xs text-slate-500 dark:text-slate-400"
            >
              {emptyStateMessage}
            </div>
          ) : (
            pageLeads.map((lead) => {
              const coEscalatedPill = formatCoEscalatedPillText(lead);
              const isInterestedLead = lead.status === 'INTERESTED';
              const ownerSubBadge = isInterestedLead
                ? formatOwnerSubStatusBadgePure(lead.ownerSubStatus)
                : null;
              const originatingRepShort = lead.assignedRepName
                ? formatRepName(lead.assignedRepName)
                : null;
              const retryInfo = formatRetryCooldownSummaryPure(lead);
              const lastCalledByLabel = formatLastCalledByRepNamePure(lead);

              return (
                <div
                  key={`mobile-card-${lead.id}`}
                  data-testid={`calling-mobile-card-${lead.id}`}
                  className="p-3.5 space-y-2.5 bg-white dark:bg-[#11141B] hover:bg-slate-50/70 dark:hover:bg-white/[0.02] transition-colors"
                >
                  {/* Card Header: Company Name (Bold) + Status Pill (right-aligned) */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 dark:text-white leading-snug break-words">
                        {lead.companyName}
                      </div>
                      {coEscalatedPill && (
                        <span
                          data-testid={`mobile-co-escalated-pill-${lead.id}`}
                          className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[10px] font-mono font-semibold text-emerald-700 dark:text-emerald-300"
                        >
                          <Flame className="w-3 h-3 text-amber-500 shrink-0" />
                          <span>{coEscalatedPill}</span>
                        </span>
                      )}
                    </div>
                    {isInterestedLead && ownerSubBadge ? (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-semibold shrink-0 ${ownerSubBadge.classes}`}
                      >
                        {ownerSubBadge.label}
                      </span>
                    ) : (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-semibold shrink-0 ${getStatusPillClasses(
                          lead.status
                        )}`}
                      >
                        {lead.status}
                      </span>
                    )}
                  </div>

                  {/* Attempts, Retries, and Last Called By Metadata */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-700 dark:text-slate-300">
                      Attempts: {retryInfo.attempts}
                    </span>
                    {(retryInfo.hasRetries || isOwner) && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-300">
                        {retryInfo.summaryText}
                      </span>
                    )}
                    {lastCalledByLabel !== '—' && (
                      <span>· Caller: {lastCalledByLabel}</span>
                    )}
                  </div>

                  {isInterestedLead && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      {originatingRepShort && <span>By: {originatingRepShort}</span>}
                      <span>·</span>
                      <span>Owner Attempts: {lead.ownerCallAttempts || 0}</span>
                    </div>
                  )}

                  {/* Card Body: Formatted Phone Number (tap-to-call link tel:+91...), City & State, and Last Called timestamp */}
                  <div className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3 text-xs">
                    <a
                      href={formatTelHref(lead)}
                      data-testid={`mobile-tel-link-${lead.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-amber-600 dark:text-[#E5B842] hover:underline"
                    >
                      <Phone className="w-3.5 h-3.5 shrink-0" />
                      <span>{formatDisplayPhone(lead)}</span>
                    </a>

                    <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1 truncate max-w-[140px]">
                        <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="truncate">{formatCityState(lead)}</span>
                      </span>
                      <span className="inline-flex items-center gap-1 font-mono whitespace-nowrap">
                        <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                        <span>{formatLastCalledDate(lead.lastCalledDate)}</span>
                      </span>
                    </div>
                  </div>

                  {/* Card Footer: Full-width primary action button ([Call / Update] or Read-Only Handover badge) */}
                  <div className="pt-1">
                    {!isOwner && lead.status === 'INTERESTED' ? (
                      <div
                        data-testid={`mobile-readonly-handover-badge-${lead.id}`}
                        className="w-full py-2 px-3 rounded-lg border border-amber-400/30 bg-amber-400/10 text-xs font-mono font-semibold text-amber-700 dark:text-amber-300 text-center"
                      >
                        Handed Over to Owner (Read-Only)
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={`mobile-call-update-btn-${lead.id}`}
                        onClick={() => onSelectLead(lead)}
                        className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors cursor-pointer text-center"
                      >
                        Call / Update
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 4.C High-Performance 50-Row Pagination Footer ([Prev 50] / Fast Page Selector / [Next 50]) */}
        {pagination.totalCount > 0 && (
          <div
            data-testid="calling-table-pagination-bar"
            className="px-3.5 py-2.5 border-t border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-[#0D1016] flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span
              data-testid="calling-table-pagination-summary"
              className="font-mono text-[11px] text-slate-500 dark:text-slate-400"
            >
              Page {pagination.currentPage} of {pagination.totalPages} · 50 rows per page (Showing{' '}
              {pagination.startIndex.toLocaleString()}–{pagination.endIndex.toLocaleString()} of{' '}
              {pagination.totalCount.toLocaleString()})
            </span>
            <div className="flex items-center gap-2">
              {pagination.totalPages > 1 && (
                <select
                  aria-label="Fast Page Selector"
                  data-testid="calling-page-selector"
                  value={pagination.currentPage}
                  onChange={(e) => setCurrentPage(Number(e.target.value) || 1)}
                  className="px-2 py-1 rounded-md border border-slate-200 dark:border-white/10 bg-white dark:bg-[#11141B] text-[11px] font-mono text-slate-700 dark:text-slate-200 cursor-pointer focus:outline-none focus:border-amber-400"
                >
                  {Array.from(
                    { length: Math.min(pagination.totalPages, 200) },
                    (_, idx) => idx + 1
                  ).map((pageNum) => (
                    <option key={pageNum} value={pageNum}>
                      Page {pageNum} of {pagination.totalPages}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                data-testid="calling-prev-50-btn"
                disabled={pagination.currentPage <= 1}
                onClick={() =>
                  setCurrentPage((p) => Math.max(1, Math.min(p, pagination.totalPages) - 1))
                }
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-white/10 bg-white dark:bg-[#11141B] text-[11px] font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                Prev 50
              </button>
              <button
                type="button"
                data-testid="calling-next-50-btn"
                disabled={pagination.currentPage >= pagination.totalPages}
                onClick={() =>
                  setCurrentPage((p) =>
                    Math.min(pagination.totalPages, Math.max(1, p) + 1)
                  )
                }
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-white/10 bg-white dark:bg-[#11141B] text-[11px] font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                Next 50
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 5. Slide-Over Call Drawer (Full-Screen Sheet on Mobile: w-full h-full sm:w-full sm:max-w-md) */}
      <Drawer
        isOpen={Boolean(selectedLead)}
        onClose={() => onSelectLead(null)}
        ariaLabel="Call Disposition Drawer"
        testId="call-action-drawer"
        maxWidthClass="sm:max-w-md"
      >
        {selectedLead && (
          <>
            <div className="space-y-5">
              {/* Header with Inline Editable Company Name */}
              <div className="flex items-start justify-between border-b border-slate-200 dark:border-white/10 pb-4">
                <div className="min-w-0 pr-2 flex-1">
                  {isEditingCompanyName ? (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <input
                        type="text"
                        data-testid="edit-company-name-input"
                        autoFocus
                        value={draftCompanyName}
                        onChange={(e) => setDraftCompanyName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleApplyCompanyNameOnly();
                          } else if (e.key === 'Escape') {
                            setDraftCompanyName(selectedLead.companyName);
                            setIsEditingCompanyName(false);
                          }
                        }}
                        aria-label="Edit Company Name"
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-amber-400 text-sm font-bold text-slate-900 dark:text-white focus:outline-none"
                      />
                      <button
                        type="button"
                        data-testid="apply-company-name-btn"
                        onClick={handleApplyCompanyNameOnly}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shrink-0 transition-colors cursor-pointer"
                      >
                        <span>✓ Apply</span>
                      </button>
                      <button
                        type="button"
                        data-testid="cancel-edit-company-name-btn"
                        onClick={() => {
                          setDraftCompanyName(selectedLead.companyName);
                          setIsEditingCompanyName(false);
                        }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0 cursor-pointer"
                        aria-label="Cancel company name edit"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 flex-wrap">
                      <h3
                        data-testid="drawer-company-name-heading"
                        onClick={() => {
                          setDraftCompanyName(selectedLead.companyName);
                          setIsEditingCompanyName(true);
                        }}
                        title="Click to edit company name"
                        className="text-base font-bold text-slate-900 dark:text-white break-words hover:text-amber-600 dark:hover:text-[#E5B842] transition-colors cursor-pointer"
                      >
                        {selectedLead.companyName}
                      </h3>
                      <button
                        type="button"
                        data-testid="edit-company-name-btn"
                        onClick={() => {
                          setDraftCompanyName(selectedLead.companyName);
                          setIsEditingCompanyName(true);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 dark:border-white/15 bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.04] dark:hover:bg-white/[0.09] text-[11px] font-medium text-slate-600 dark:text-slate-300 transition-colors cursor-pointer shrink-0 mt-0.5"
                      >
                        <Pencil className="w-3 h-3 text-amber-500" />
                        <span>Edit Name</span>
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <a
                      href={formatTelHref(selectedLead)}
                      className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-amber-600 dark:text-[#E5B842] hover:underline"
                    >
                      <Phone className="w-3.5 h-3.5" />
                      <span>{formatDisplayPhone(selectedLead)}</span>
                    </a>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {formatCityState(selectedLead)}
                    </span>
                  </div>
                  {/* Call Attempts & Retry / Cooldown Cycle Strip inside Drawer */}
                  <div
                    data-testid="drawer-attempt-retry-strip"
                    className="flex flex-wrap items-center gap-1.5 mt-2 text-[11px] font-mono"
                  >
                    <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-700 dark:text-slate-200 tabular-nums">
                      Total Attempts: {selectedLead.callAttempts || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-300 tabular-nums">
                      Didn&apos;t Receive: {selectedLead.didntReceiveCount || 0} · Switch Off:{' '}
                      {selectedLead.switchOffCount || 0}
                    </span>
                    {formatLastCalledByRepNamePure(selectedLead) !== '—' && (
                      <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
                        Last Caller: {formatLastCalledByRepNamePure(selectedLead)}
                      </span>
                    )}
                  </div>
                  {formatCoEscalatedPillText(selectedLead) && (
                    <div className="mt-2">
                      <span
                        data-testid="drawer-co-escalated-pill"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-300"
                      >
                        <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        <span>{formatCoEscalatedPillText(selectedLead)}</span>
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="close-call-drawer-btn"
                  onClick={() => onSelectLead(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Hot Client Escalation Banner inside Drawer */}
              {selectedLead.isDualRepEscalation && selectedLead.hotEscalationNote && (
                <div
                  data-testid="drawer-hot-escalation-banner"
                  className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-1 text-xs"
                >
                  <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
                    <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span>Hot Client Handover Note ({formatRepName(selectedLead.escalatedByName || 'Sales Rep')})</span>
                  </div>
                  <p className="text-slate-700 dark:text-slate-200 leading-relaxed">
                    {selectedLead.hotEscalationNote}
                  </p>
                </div>
              )}

              {/* Executive Deal Conversion Actions for Owner on Interested / Queue Leads */}
              {isOwner && (
                <div
                  data-testid="owner-executive-conversion-panel"
                  className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2.5"
                >
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <span className="font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                      Executive Deal Conversion
                    </span>
                    {formatCoEscalatedPillText(selectedLead) ? (
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold truncate max-w-[220px]">
                        {formatCoEscalatedPillText(selectedLead)}
                      </span>
                    ) : (
                      selectedLead.assignedRepName && (
                        <span className="font-mono text-slate-500 dark:text-slate-400 truncate max-w-[180px]">
                          Rep: {formatRepName(selectedLead.assignedRepName)}
                        </span>
                      )
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      data-testid="owner-convert-closed-won-btn"
                      onClick={() =>
                        onSaveCallUpdate({
                          leadId: selectedLead.id,
                          newStatus: 'CLOSED_WON',
                          ownerSubStatus: 'WON',
                          callDate: drawerCallDate,
                          notes:
                            drawerNotes.trim() ||
                            'Converted to paying client (Closed Won) by Owner.',
                          loadNext: false,
                          editedCompanyName: getPendingEditedCompanyName(),
                        })
                      }
                      className="py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer text-center"
                    >
                      Convert to Client (Closed Won)
                    </button>
                    <button
                      type="button"
                      data-testid="owner-mark-lead-lost-btn"
                      onClick={() =>
                        onSaveCallUpdate({
                          leadId: selectedLead.id,
                          newStatus: 'LEAD_LOST',
                          ownerSubStatus: 'LOST',
                          callDate: drawerCallDate,
                          notes:
                            drawerNotes.trim() ||
                            'Marked as Lead Lost by Owner.',
                          loadNext: false,
                          editedCompanyName: getPendingEditedCompanyName(),
                        })
                      }
                      className="py-2 px-3 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-700 dark:text-red-300 text-xs font-semibold transition-colors cursor-pointer text-center"
                    >
                      Mark as Lead Lost
                    </button>
                  </div>
                </div>
              )}

              {/* 1. Status Selector:
                  - When editing an INTERESTED lead: HIDE standard cold-calling status dropdown & render dedicated OWNER CLOSING STATUS selector (`ownerSubStatus`) that permanently locks lead out of Fresh Pool.
                  - Otherwise: render standard Sales Rep cold-calling status dropdown. */}
              {isEditingInterestedLead ? (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label
                      htmlFor="drawer-owner-substatus-select"
                      className="block text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-[#E5B842]"
                    >
                      Owner Closing Status
                    </label>
                    <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                      Locked in Owner Queue · Never returns to Fresh Pool
                    </span>
                  </div>
                  <select
                    id="drawer-owner-substatus-select"
                    data-testid="drawer-owner-substatus-select"
                    value={drawerOwnerSubStatus}
                    onChange={(e) =>
                      setDrawerOwnerSubStatus(e.target.value as OwnerSubStatus)
                    }
                    className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-[#E5B842]/50 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none focus:border-[#E5B842]"
                  >
                    <option value="PENDING_FIRST_CALL">
                      Pending First Owner Call (Default newly handed over by Sales Rep)
                    </option>
                    <option value="DIDNT_RECEIVE_RETRY">
                      Didn&apos;t Receive — Owner Retry (Stays in Owner Queue · Never goes to Fresh Pool)
                    </option>
                    <option value="SWITCH_OFF_RETRY">
                      Switch Off / Busy — Owner Retry (Stays in Owner Queue)
                    </option>
                    <option value="QUOTE_SHARED">
                      Commercial Proposal / Quote Shared (Stays in Owner Queue with follow-up date)
                    </option>
                    <option value="SITE_VISIT_SCHEDULED">
                      Technical / Site Visit Scheduled (Site survey or technical meeting in progress)
                    </option>
                    <option value="NEGOTIATION">
                      Under Final Negotiation (Discussing final commercial terms)
                    </option>
                    <option value="FUTURE_PROJECT">
                      Future Project (Keep in Owner Queue under Owner supervision)
                    </option>
                  </select>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="drawer-status-select"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5"
                  >
                    Status
                  </label>
                  <select
                    id="drawer-status-select"
                    data-testid="drawer-status-select"
                    value={drawerStatus}
                    onChange={(e) => setDrawerStatus(e.target.value as LeadStatus | '')}
                    className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none focus:border-amber-400"
                  >
                    <option value="">-- Select Call Outcome --</option>
                    <option value="PROPOSAL_SHARED">
                      Proposal Shared (Moves to Proposals Shared tab · 2-Day Follow-up)
                    </option>
                    <option value="INTERESTED">
                      Interested (Escalates to Owner Closing Queue)
                    </option>
                    <option value="FUTURE_REQUIREMENT">
                      Future Requirement (Moves to Future Requirement tab · 30-Day Follow-up)
                    </option>
                    <option value="DIDNT_RECEIVE">
                      Didn&apos;t Receive (48h Cooldown Retry · Max 10 attempts)
                    </option>
                    <option value="SWITCH_OFF">
                      Switch Off (48h Cooldown Retry · Max 3 attempts)
                    </option>
                    <option value="NOT_INTERESTED">
                      Not Interested (Moves to Dead / Closed Out)
                    </option>
                    <option value="NOT_A_SOLAR_COMPANY">
                      Not a Solar Company (Moves to Dead / Closed Out)
                    </option>
                  </select>
                </div>
              )}

              {/* 2. Call Date */}
              <div>
                <label
                  htmlFor="drawer-call-date-input"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5"
                >
                  Call Date
                </label>
                <input
                  id="drawer-call-date-input"
                  data-testid="drawer-call-date-input"
                  type="date"
                  value={drawerCallDate}
                  onChange={(e) => setDrawerCallDate(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* Scrollable Previous Notes & Activity History Timeline */}
              {(() => {
                const historyTimeline = buildLeadNotesActivityHistoryPure(selectedLead);
                if (historyTimeline.length === 0) return null;
                return (
                  <div
                    data-testid="drawer-historical-notes-timeline"
                    className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-2"
                  >
                    <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      <span>Previous Notes &amp; Activity History</span>
                      <span className="font-mono">{historyTimeline.length}</span>
                    </div>
                    <div className="max-h-36 overflow-y-auto space-y-2 pr-1">
                      {historyTimeline.map((entry) => (
                        <div
                          key={entry.id}
                          data-testid="drawer-history-timeline-item"
                          className="p-2 rounded bg-white dark:bg-[#11141B] border border-slate-200/70 dark:border-white/5 space-y-0.5"
                        >
                          <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-slate-500 dark:text-slate-400">
                            <span className="font-semibold text-slate-700 dark:text-slate-200 truncate">
                              {entry.repName}
                            </span>
                            <span className="shrink-0">{entry.timestamp}</span>
                          </div>
                          <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                            {entry.noteText}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* 3. Notes (Always opens empty for current call discussion) */}
              <div>
                <label
                  htmlFor="drawer-notes-textarea"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5"
                >
                  Notes
                </label>
                <textarea
                  id="drawer-notes-textarea"
                  data-testid="drawer-notes-textarea"
                  rows={4}
                  value={drawerNotes}
                  onChange={(e) => setDrawerNotes(e.target.value)}
                  placeholder="Enter call discussion notes..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-amber-400 resize-none"
                />
              </div>
            </div>

            {/* Sticky Footer: [Save & Load Next] */}
            <div className="sticky bottom-0 bg-white dark:bg-[#11141B] pt-4 mt-4 border-t border-slate-200 dark:border-white/10 flex items-center gap-2">
              <button
                type="button"
                data-testid="save-and-load-next-btn"
                disabled={!isEditingInterestedLead && !drawerStatus}
                onClick={() => {
                  if (!isEditingInterestedLead && !drawerStatus) return;
                  const pendingCompanyName = getPendingEditedCompanyName();
                  setIsEditingCompanyName(false);
                  if (isEditingInterestedLead) {
                    onSaveCallUpdate({
                      leadId: selectedLead.id,
                      newStatus: 'INTERESTED',
                      ownerSubStatus: drawerOwnerSubStatus,
                      callDate: drawerCallDate,
                      notes: drawerNotes,
                      loadNext: true,
                      editedCompanyName: pendingCompanyName,
                    });
                  } else if (drawerStatus) {
                    onSaveCallUpdate({
                      leadId: selectedLead.id,
                      newStatus: drawerStatus,
                      callDate: drawerCallDate,
                      notes: drawerNotes,
                      loadNext: true,
                      editedCompanyName: pendingCompanyName,
                    });
                  }
                }}
                className="flex-1 py-2.5 px-4 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Save &amp; Load Next
              </button>
              <button
                type="button"
                onClick={() => onSelectLead(null)}
                className="py-2.5 px-3.5 rounded-xl border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
