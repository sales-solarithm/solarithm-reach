'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, MessageSquareShare, PhoneCall, RotateCcw } from 'lucide-react';
import { LeadRecord, UserRole } from '@/lib/types';
import {
  WHATSAPP_TEMPLATES,
  WhatsAppTemplateId,
  buildWhatsAppDeepLink,
  compileWhatsAppTemplate,
  getRecommendedWhatsAppTemplateId,
} from '@/config/whatsappTemplates';
import {
  LogWhatsAppDispatchResult,
  hasRecentWhatsAppTouchpoint,
  logWhatsAppDispatch,
} from '@/lib/whatsappLogger';

/**
 * Phase 13 Task 1 & 2: 1-Click WhatsApp Quick Action & Template Engine (`components/calling/WhatsAppAction.tsx`)
 *
 * - Standardized Deep-Link Generation: `https://wa.me/91${lead.phoneNumber}?text=${encodeURIComponent(compiledMessage)}`
 * - Dedicated WhatsApp action button alongside the `tel:` dialer button in muted emerald
 *   (`text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20`).
 * - Contextual template dropdown (Templates A, B, C, D) with automatic `[Company Name]` and `[Email]`
 *   placeholder substitution and an inline editable preview box before clicking send.
 */

interface WhatsAppActionProps {
  lead: LeadRecord;
  currentUser: {
    email: string;
    name: string;
    role: UserRole;
  };
  onDispatched?: (result: LogWhatsAppDispatchResult) => void;
}

export function WhatsAppAction({
  lead,
  currentUser,
  onDispatched,
}: WhatsAppActionProps) {
  const recommendedId = useMemo(
    () => getRecommendedWhatsAppTemplateId(lead.status),
    [lead.status]
  );

  const [selectedTemplateId, setSelectedTemplateId] =
    useState<WhatsAppTemplateId>(recommendedId);
  const [compiledMessage, setCompiledMessage] = useState<string>(() =>
    compileWhatsAppTemplate(recommendedId, lead)
  );
  const [justSentStamp, setJustSentStamp] = useState<string | null>(null);

  // Sync template & message when switching to a different lead in the Call Action Drawer
  useEffect(() => {
    const nextRec = getRecommendedWhatsAppTemplateId(lead.status);
    setSelectedTemplateId(nextRec);
    setCompiledMessage(compileWhatsAppTemplate(nextRec, lead));
    setJustSentStamp(null);
  }, [lead.id, lead.companyName, lead.email, lead.status]);

  const handleSelectTemplate = (templateId: WhatsAppTemplateId) => {
    setSelectedTemplateId(templateId);
    setCompiledMessage(compileWhatsAppTemplate(templateId, lead));
  };

  const handleResetTemplateText = () => {
    setCompiledMessage(compileWhatsAppTemplate(selectedTemplateId, lead));
  };

  const selectedTemplateObj = useMemo(
    () =>
      WHATSAPP_TEMPLATES.find((t) => t.id === selectedTemplateId) ||
      WHATSAPP_TEMPLATES[0],
    [selectedTemplateId]
  );

  const whatsappDeepLink = useMemo(
    () => buildWhatsAppDeepLink(lead.phoneNumber, compiledMessage),
    [lead.phoneNumber, compiledMessage]
  );

  const sentWithin7Days = useMemo(
    () => hasRecentWhatsAppTouchpoint(lead),
    [lead]
  );

  const handleSendWhatsAppClick = async () => {
    const result = await logWhatsAppDispatch({
      lead,
      rep: currentUser,
      templateName: selectedTemplateObj.name,
      compiledMessage,
    });
    setJustSentStamp(result.subcollectionEntry.dispatchedAt);
    onDispatched?.(result);
  };

  return (
    <div
      data-testid="whatsapp-action-card"
      className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#0B0D12] border border-slate-200 dark:border-white/10 space-y-3"
    >
      {/* Top Row: Quick-Action Dialer (`tel:`) + 1-Click WhatsApp Button (`wa.me/91...`) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <span>Direct Outreach &amp; Collateral Dispatch</span>
            {(sentWithin7Days || justSentStamp) && (
              <span
                data-testid="drawer-whatsapp-7d-badge"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-mono text-[10px] normal-case"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span>Sent &le;7d</span>
              </span>
            )}
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
            Endpoint: <code className="text-emerald-500">wa.me/91{lead.phoneNumber}</code>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Standard `tel:` Dialer Button */}
          <a
            href={`tel:+91${lead.phoneNumber}`}
            data-testid="drawer-tel-dial-btn"
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-white hover:bg-slate-100 dark:bg-[#141821] dark:hover:bg-white/[0.08] text-slate-800 dark:text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <PhoneCall className="w-3.5 h-3.5 text-[#E5B842]" />
            <span>Dial {lead.formattedPhone}</span>
          </a>

          {/* Dedicated 1-Click WhatsApp Action Button (Muted Emerald) */}
          <a
            href={whatsappDeepLink}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="drawer-whatsapp-send-btn"
            onClick={() => {
              void handleSendWhatsAppClick();
            }}
            className="px-3 py-1.5 rounded-lg text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <MessageSquareShare className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span>Send WhatsApp</span>
            <ExternalLink className="w-3 h-3 opacity-75" />
          </a>
        </div>
      </div>

      {/* Template Dropdown Selector (Templates A, B, C, D) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label
            htmlFor="whatsapp-template-select"
            className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
          >
            Solarithm WhatsApp Template Library
          </label>
          <button
            type="button"
            onClick={handleResetTemplateText}
            title="Reset message text to template default"
            className="text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-white flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset Variables</span>
          </button>
        </div>

        <select
          id="whatsapp-template-select"
          data-testid="whatsapp-template-select"
          value={selectedTemplateId}
          onChange={(e) => handleSelectTemplate(e.target.value as WhatsAppTemplateId)}
          className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500"
        >
          {WHATSAPP_TEMPLATES.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      </div>

      {/* Inline Editable Preview Box with Compiled Placeholders */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label
            htmlFor="whatsapp-compiled-preview"
            className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
          >
            Editable Message Preview (Auto-Filled Variables)
          </label>
          <span className="text-[10px] font-mono text-slate-400">
            Email: {lead.email || 'your registered email'}
          </span>
        </div>
        <textarea
          id="whatsapp-compiled-preview"
          data-testid="whatsapp-compiled-preview"
          rows={3}
          value={compiledMessage}
          onChange={(e) => setCompiledMessage(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#141821] border border-slate-200 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200 leading-relaxed focus:outline-none focus:border-emerald-500"
        />
      </div>

      {/* Confirmation Stamp when Dispatched */}
      {(justSentStamp || lead.lastWhatsAppSentAt) && (
        <div
          data-testid="whatsapp-dispatch-stamp"
          className="flex items-center justify-between text-[11px] font-mono text-emerald-600 dark:text-emerald-400 pt-1 border-t border-slate-200/70 dark:border-white/5"
        >
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span>
              Logged WHATSAPP_DISPATCHED ·{' '}
              {justSentStamp
                ? selectedTemplateObj.code
                : lead.lastWhatsAppTemplateName?.split(' (')[0] || 'Template'}
            </span>
          </span>
          <span>
            {(justSentStamp || lead.lastWhatsAppSentAt || '').slice(0, 16).replace('T', ' ')} UTC
          </span>
        </div>
      )}
    </div>
  );
}
