import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SOLARITHM_PORTFOLIO_LINK,
  WHATSAPP_TEMPLATES,
  buildWhatsAppDeepLink,
  compileWhatsAppTemplate,
  getRecommendedWhatsAppTemplateId,
} from '@/config/whatsappTemplates';
import {
  hasRecentWhatsAppTouchpoint,
  recordWhatsAppDispatchPure,
} from './whatsappLogger';
import { LeadRecord } from './types';

function createMockLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: 'lead-wa-1',
    companyName: 'Arvind Polycot Spinning Mills Pvt Ltd',
    companyNameNormalized: 'arvind polycot spinning mills pvt ltd',
    phoneNumber: '9825011223',
    formattedPhone: '+91 98250 11223',
    altNumber: '9426088991',
    email: 'utilities@arvindpolycot.in',
    state: 'Gujarat',
    city: 'Ahmedabad',
    status: 'FRESH',
    assignedBatchId: 'BATCH_2026_10_28_01',
    assignedRepEmail: 'sales@solarithmdesign.com',
    assignedRepName: 'Priya Nair',
    callAttempts: 1,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: '2026-10-28T05:00:00.000Z',
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-28T05:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 13 Task 1 & 2: WhatsApp Deep-Link & Outreach Template Library (config/whatsappTemplates.ts)', () => {
  it('generates standardized wa.me/91 deep-link with URL-encoded message', () => {
    const lead = createMockLead({ phoneNumber: '9825011223' });
    const compiled = compileWhatsAppTemplate('TEMPLATE_A_INTRO', lead);
    const link = buildWhatsAppDeepLink(lead.phoneNumber, compiled);

    assert.ok(link.startsWith('https://wa.me/919825011223?text='));
    assert.ok(decodeURIComponent(link.split('?text=')[1]).includes(lead.companyName));
    assert.ok(
      decodeURIComponent(link.split('?text=')[1]).includes(DEFAULT_SOLARITHM_PORTFOLIO_LINK)
    );
  });

  it('substitutes [Company Name], [Email], and falls back to "your registered email" when email is missing', () => {
    assert.equal(WHATSAPP_TEMPLATES.length, 4);

    const leadWithEmail = createMockLead({
      companyName: 'Morbi Vitrified Ceramics LLP',
      email: 'director@morbivitrified.com',
    });
    const compiledB = compileWhatsAppTemplate('TEMPLATE_B_PROPOSAL', leadWithEmail);
    assert.ok(compiledB.includes('Hi Morbi Vitrified Ceramics LLP,'));
    assert.ok(compiledB.includes('(director@morbivitrified.com)'));

    const leadWithoutEmail = createMockLead({
      companyName: 'Shree Cement Works',
      email: undefined,
    });
    const compiledBFallback = compileWhatsAppTemplate('TEMPLATE_B_PROPOSAL', leadWithoutEmail);
    assert.ok(compiledBFallback.includes('Hi Shree Cement Works,'));
    assert.ok(compiledBFallback.includes('(your registered email)'));

    // Template C & D verification
    const compiledC = compileWhatsAppTemplate('TEMPLATE_C_RETRY', leadWithoutEmail);
    assert.ok(compiledC.includes('Greetings from SOLARITHM. Tried reaching you'));

    const compiledD = compileWhatsAppTemplate('TEMPLATE_D_FUTURE', leadWithEmail);
    assert.ok(compiledD.includes('Hello Morbi Vitrified Ceramics LLP, following up on our discussion'));

    // Contextual template recommendation
    assert.equal(getRecommendedWhatsAppTemplateId('FRESH'), 'TEMPLATE_A_INTRO');
    assert.equal(getRecommendedWhatsAppTemplateId('PROPOSAL_SHARED'), 'TEMPLATE_B_PROPOSAL');
    assert.equal(getRecommendedWhatsAppTemplateId('DIDNT_RECEIVE'), 'TEMPLATE_C_RETRY');
    assert.equal(getRecommendedWhatsAppTemplateId('FUTURE_REQUIREMENT'), 'TEMPLATE_D_FUTURE');
  });
});

describe('Phase 13 Task 3: Outreach Audit & 7-Day Activity Stamp (lib/whatsappLogger.ts)', () => {
  it('records WHATSAPP_DISPATCHED audit entry with templateName, dispatchedByEmail, and dispatchedAt', () => {
    const lead = createMockLead();
    const dispatchedAt = '2026-10-29T10:00:00.000Z';
    const compiled = compileWhatsAppTemplate('TEMPLATE_A_INTRO', lead);

    const result = recordWhatsAppDispatchPure({
      lead,
      rep: {
        email: 'sales@solarithmdesign.com',
        name: 'Priya Nair',
        role: 'sales',
      },
      templateName: 'Template A (Introductory Brochure / Fresh Call)',
      compiledMessage: compiled,
      dispatchedAt,
    });

    assert.equal(result.subcollectionEntry.actionType, 'WHATSAPP_DISPATCHED');
    assert.equal(
      result.subcollectionEntry.templateName,
      'Template A (Introductory Brochure / Fresh Call)'
    );
    assert.equal(result.subcollectionEntry.dispatchedByEmail, 'sales@solarithmdesign.com');
    assert.equal(result.subcollectionEntry.dispatchedAt, dispatchedAt);

    assert.equal(result.auditLogRecord.actionType, 'WHATSAPP_DISPATCHED');
    assert.equal(result.updatedLead.lastWhatsAppSentAt, dispatchedAt);
  });

  it('evaluates hasRecentWhatsAppTouchpoint accurately for a 7-day window', () => {
    const now = new Date('2026-10-29T12:00:00.000Z');

    // Sent 3 days ago -> true
    assert.equal(
      hasRecentWhatsAppTouchpoint({ lastWhatsAppSentAt: '2026-10-26T12:00:00.000Z' }, now),
      true
    );

    // Sent 9 days ago -> false
    assert.equal(
      hasRecentWhatsAppTouchpoint({ lastWhatsAppSentAt: '2026-10-20T11:59:00.000Z' }, now),
      false
    );

    // Never sent -> false
    assert.equal(hasRecentWhatsAppTouchpoint({ lastWhatsAppSentAt: null }, now), false);
  });
});
