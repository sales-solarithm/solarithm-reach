import { LeadRecord, LeadStatus } from '@/lib/types';

/**
 * Phase 13 Task 2: Solarithm Outreach Template Library (`config/whatsappTemplates.ts`)
 *
 * Contextual WhatsApp message templates selectable via a 1-click dropdown inside the Call Action Drawer,
 * with automatic variable substitution (`[Company Name]`, `[Email]`, `[Portfolio Link]`).
 */

export type WhatsAppTemplateId =
  | 'TEMPLATE_A_INTRO'
  | 'TEMPLATE_B_PROPOSAL'
  | 'TEMPLATE_C_RETRY'
  | 'TEMPLATE_D_FUTURE';

export interface WhatsAppTemplateDefinition {
  id: WhatsAppTemplateId;
  code: 'Template A' | 'Template B' | 'Template C' | 'Template D';
  name: string;
  recommendedForStatuses: LeadStatus[];
  rawBody: string;
}

export const DEFAULT_SOLARITHM_PORTFOLIO_LINK = 'https://solarithmdesign.com/portfolio';

export const WHATSAPP_TEMPLATES: WhatsAppTemplateDefinition[] = [
  {
    id: 'TEMPLATE_A_INTRO',
    code: 'Template A',
    name: 'Template A (Introductory Brochure / Fresh Call)',
    recommendedForStatuses: ['FRESH', 'REVIVED_FRESH', 'INTERESTED'],
    rawBody:
      'Hello [Company Name] team, Jay Shah from SOLARITHM here. As discussed over our brief call, we specialize in complete solar PV engineering, 3D layouts, and PVsyst generation reports. Attaching our credential portfolio for your review: [Portfolio Link]',
  },
  {
    id: 'TEMPLATE_B_PROPOSAL',
    code: 'Template B',
    name: 'Template B (Proposal Shared Follow-Up)',
    recommendedForStatuses: ['PROPOSAL_SHARED'],
    rawBody:
      'Hi [Company Name], we have dispatched the engineering design proposal to your email ([Email]). Please review the kW sizing and single-line diagram scope. We will connect again in 48 hours for your feedback.',
  },
  {
    id: 'TEMPLATE_C_RETRY',
    code: 'Template C',
    name: "Template C (Didn't Receive / Busy Retry)",
    recommendedForStatuses: ['DIDNT_RECEIVE', 'SWITCH_OFF', 'DIDNT_RECEIVE_DEAD', 'SWITCH_OFF_DEAD'],
    rawBody:
      'Greetings from SOLARITHM. Tried reaching you regarding your upcoming commercial/industrial solar rooftop engineering requirements. Sharing our contact details here—feel free to drop a message or call back at your convenience.',
  },
  {
    id: 'TEMPLATE_D_FUTURE',
    code: 'Template D',
    name: 'Template D (Future Requirement Reminder)',
    recommendedForStatuses: ['FUTURE_REQUIREMENT'],
    rawBody:
      'Hello [Company Name], following up on our discussion last month regarding your scheduled solar project rollout. Let us know when we can align on design documentation and structural analysis.',
  },
];

/**
 * Selects the default contextual template ID based on the lead's current disposition status.
 */
export function getRecommendedWhatsAppTemplateId(status: LeadStatus): WhatsAppTemplateId {
  if (status === 'PROPOSAL_SHARED') return 'TEMPLATE_B_PROPOSAL';
  if (
    status === 'DIDNT_RECEIVE' ||
    status === 'SWITCH_OFF' ||
    status === 'DIDNT_RECEIVE_DEAD' ||
    status === 'SWITCH_OFF_DEAD'
  ) {
    return 'TEMPLATE_C_RETRY';
  }
  if (status === 'FUTURE_REQUIREMENT') return 'TEMPLATE_D_FUTURE';
  return 'TEMPLATE_A_INTRO';
}

/**
 * Compiles a WhatsApp template by substituting placeholders:
 * - `[Company Name]` -> `lead.companyName`
 * - `[Email]` -> `lead.email || 'your registered email'`
 * - `[Portfolio Link]` -> `portfolioLink` (defaults to `https://solarithmdesign.com/portfolio`)
 */
export function compileWhatsAppTemplate(
  templateIdOrBody: WhatsAppTemplateId | string,
  lead: Pick<LeadRecord, 'companyName' | 'email'>,
  portfolioLink: string = DEFAULT_SOLARITHM_PORTFOLIO_LINK
): string {
  const matchedTemplate = WHATSAPP_TEMPLATES.find((t) => t.id === templateIdOrBody);
  const templateBody = matchedTemplate ? matchedTemplate.rawBody : templateIdOrBody;

  const companyName = lead.companyName?.trim() || 'Valued Partner';
  const emailFallback = lead.email?.trim() ? lead.email.trim() : 'your registered email';
  const resolvedPortfolio = portfolioLink?.trim() || DEFAULT_SOLARITHM_PORTFOLIO_LINK;

  return templateBody
    .replace(/\[Company Name\]/g, companyName)
    .replace(/\[Email\]/g, emailFallback)
    .replace(/\[Portfolio Link\]/g, resolvedPortfolio);
}

/**
 * Standardized Deep-Link Generation:
 * Uses the cleaned 10-digit phone number prefixed with Indian country code:
 * `https://wa.me/91${lead.phoneNumber}?text=${encodeURIComponent(compiledMessage)}`
 */
export function buildWhatsAppDeepLink(phoneNumber: string, compiledMessage: string): string {
  const digits = String(phoneNumber || '').replace(/\D/g, '').slice(-10);
  const encodedText = encodeURIComponent(compiledMessage);
  return `https://wa.me/91${digits}?text=${encodedText}`;
}
