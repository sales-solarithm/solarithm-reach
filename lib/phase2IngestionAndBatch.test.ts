import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCompanyName,
  sanitizeIndianPhone,
  sanitizePhoneNumber,
} from './phoneSanitizer';
import {
  checkSingleLeadDuplicateInFirestore,
  checkSingleLeadDuplicatePure,
  computeOperationalDatesForStatus,
  mergeDuplicateLeadRecord,
  runPreFlightIngestionCheck,
} from './leadStore';
import { EXCEL_TEMPLATE_HEADERS } from '../components/leads/ExcelUploadModal';
import {
  buildEmployeeMatchPool,
  buildLeadRecordFromSanitizedRowPure,
  computePreFlightBreakdownPure,
  matchSalesPersonToEmployeePure,
  normalizeImportedStatus,
  parseHistoricalCallingDate,
} from './historicalImportParser';
import {
  computeCooldownUntil,
  fisherYatesShuffle,
  generateStratifiedBatch,
  isLeadOnCooldown,
} from './batchGenerator';
import { sanitizeFirestorePayload } from './firestoreSanitizer';
import { LeadRecord, RawSheetRow } from './types';

function makeLead(id: string, overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id,
    companyName: `Solar Prospect ${id}`,
    companyNameNormalized: `solar prospect ${id}`.toLowerCase(),
    phoneNumber: '9429360746',
    formattedPhone: '+91 94293 60746',
    altNumber: null,
    state: 'Gujarat',
    city: 'Ahmedabad',
    email: 'contact@solarprospect.in',
    status: 'FRESH',
    assignedBatchId: null,
    assignedRepEmail: null,
    assignedRepName: null,
    callAttempts: 0,
    didntReceiveCount: 0,
    switchOffCount: 0,
    lastCalledDate: null,
    cooldownUntil: null,
    nextFollowUpDate: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    notes: 'Original field note',
    ...overrides,
  };
}

describe('Phase 2: Ingestion Engine, Phone Normalization, Duplicate Resolution & Batch Shuffler', () => {
  it('Task 1: sanitizePhoneNumber normalizes strings, numbers, Excel floats (.0), scientific notation, and regional prefixes (91, 091, 0, 0091)', () => {
    // 1. Clean 10-digit
    const clean = sanitizePhoneNumber('9429360746');
    assert.equal(clean.isValid, true);
    assert.equal(clean.cleaned, '9429360746');
    assert.equal(clean.formatted, '+91 94293 60746');

    // 2. Number & Excel float notation
    const numInput = sanitizePhoneNumber(9825011223);
    assert.equal(numInput.isValid, true);
    assert.equal(numInput.cleaned, '9825011223');
    assert.equal(numInput.formatted, '+91 98250 11223');

    const floatInput = sanitizePhoneNumber('9825011223.0');
    assert.equal(floatInput.isValid, true);
    assert.equal(floatInput.cleaned, '9825011223');
    assert.equal(floatInput.formatted, '+91 98250 11223');

    const sciInput = sanitizePhoneNumber('9.82501E+09');
    assert.equal(sciInput.isValid, true);
    assert.equal(sciInput.cleaned, '9825010000');
    assert.equal(sciInput.formatted, '+91 98250 10000');

    // 3. Regional prefix stripping: 12-digit 91, 13-digit 091, 11-digit 0, 14-digit 0091
    assert.equal(sanitizeIndianPhone('919429360746').cleaned, '9429360746');
    assert.equal(sanitizeIndianPhone('0919429360746').cleaned, '9429360746');
    assert.equal(sanitizeIndianPhone('09429360746').cleaned, '9429360746');
    assert.equal(sanitizeIndianPhone('00919429360746').cleaned, '9429360746');

    // 4. Rejects invalid lengths and invalid starting digits (<6)
    const invalidStart = sanitizePhoneNumber('5429360746');
    assert.equal(invalidStart.isValid, false);
    assert.ok(invalidStart.error);

    const invalidLen = sanitizePhoneNumber('94293607');
    assert.equal(invalidLen.isValid, false);
    assert.ok(invalidLen.error);
  });

  it('Task 2: Excel template 10 headers, pre-flight duplicate check, and Overwrite vs Skip conflict resolution', async () => {
    assert.deepEqual(EXCEL_TEMPLATE_HEADERS, [
      'Company Name',
      'Phone Number',
      'Date of Calling',
      'State',
      'City',
      'Email',
      'Alternative Number',
      'Status',
      'Sales Person',
      'Remarks',
    ]);

    const existingLeads: LeadRecord[] = [
      makeLead('existing-1', {
        companyName: 'Test Fixture Spinning Mills Pvt Ltd',
        companyNameNormalized: normalizeCompanyName('Test Fixture Spinning Mills Pvt Ltd'),
        phoneNumber: '9776655443',
        formattedPhone: '+91 97766 55443',
        altNumber: '9665544332',
        status: 'INTERESTED',
        assignedRepEmail: 'sales@solarithmdesign.com',
        assignedRepName: 'Priya Nair',
        callAttempts: 4,
        notes: 'High priority 1.2 MWp captive rooftop lead',
      }),
    ];

    const incomingSheetRows: RawSheetRow[] = [
      // Row 2: Valid fresh lead (unique 10-digit number not in live Firestore seed)
      {
        rowNumber: 2,
        companyName: 'Surya Kiran Unique Solar Textiles Pvt Ltd',
        phoneNumberRaw: '0919112233445',
        state: 'Gujarat',
        city: 'Surat',
        email: 'solar@suryakiran.in',
      },
      // Row 3: Duplicate matching existing primary phone
      {
        rowNumber: 3,
        companyName: 'Test Fixture Spinning Mills Pvt Ltd',
        phoneNumberRaw: '9776655443.0',
        state: 'Gujarat',
        city: 'Ahmedabad GIDC',
        email: 'updated-email@arvindpolycot.in',
        altNumberRaw: '09988776655',
      },
      // Row 4: Duplicate matching existing altNumber
      {
        rowNumber: 4,
        companyName: 'Test Fixture Sister Unit',
        phoneNumberRaw: '9665544332',
        state: 'Gujarat',
        city: 'Vadodara',
      },
      // Row 5: Malformed row (missing company name)
      {
        rowNumber: 5,
        companyName: '   ',
        phoneNumberRaw: '9825099112',
      },
    ];

    const audit = await runPreFlightIngestionCheck(incomingSheetRows, existingLeads);
    assert.equal(audit.validFreshLeads.length, 1);
    assert.equal(audit.validFreshLeads[0].phoneNumber, '9112233445');
    assert.equal(audit.duplicatesDetected.length, 2);
    assert.equal(audit.malformedRows.length, 1);

    // Verify Overwrite Duplicates strictly preserves status, rep assignment, callAttempts, and historical notes when incoming Status is blank/FRESH
    const conflict = audit.duplicatesDetected[0];
    const merged = mergeDuplicateLeadRecord(
      conflict.existingLead,
      conflict.incoming,
      '2026-10-31T12:00:00.000Z'
    );

    assert.equal(merged.status, 'INTERESTED');
    assert.equal(merged.assignedRepEmail, 'sales@solarithmdesign.com');
    assert.equal(merged.assignedRepName, 'Priya Nair');
    assert.equal(merged.callAttempts, 4);
    assert.equal(merged.notes, 'High priority 1.2 MWp captive rooftop lead');
    // Updated meta fields from incoming sheet
    assert.equal(merged.city, 'Ahmedabad GIDC');
    assert.equal(merged.email, 'updated-email@arvindpolycot.in');
    assert.equal(merged.altNumber, '9988776655');

    // Verify Single Lead duplicate check (Pure & Firestore blur wrapper)
    const singleDup = await checkSingleLeadDuplicateInFirestore(
      {
        companyName: 'New Name',
        cleanedPrimaryPhone: '9776655443',
        formattedPrimaryPhone: '+91 97766 55443',
      },
      existingLeads
    );
    assert.ok(singleDup);
    assert.equal(singleDup.matchType, 'PRIMARY_PHONE');
    assert.equal(singleDup.lead.id, 'existing-1');

    const companyDup = checkSingleLeadDuplicatePure(
      {
        companyName: '  TEST FIXTURE SPINNING MILLS PVT LTD ',
        cleanedPrimaryPhone: '9123456789',
      },
      existingLeads
    );
    assert.ok(companyDup);
    assert.equal(companyDup.matchType, 'COMPANY_NAME');
  });

  it('Task 2B: Historical Lead Imports support Fuzzy Status Normalization, Sales Person Employee Matching, State Machine Rules & Pre-Flight Breakdown', async () => {
    // 1. Fuzzy Status Normalization
    assert.equal(normalizeImportedStatus(''), 'FRESH');
    assert.equal(normalizeImportedStatus('   '), 'FRESH');
    assert.equal(normalizeImportedStatus('fresh'), 'FRESH');
    assert.equal(normalizeImportedStatus('New'), 'FRESH');

    assert.equal(normalizeImportedStatus('Proposal Shared'), 'PROPOSAL_SHARED');
    assert.equal(normalizeImportedStatus('proposal'), 'PROPOSAL_SHARED');
    assert.equal(normalizeImportedStatus('quotation sent'), 'PROPOSAL_SHARED');
    assert.equal(normalizeImportedStatus('quote shared'), 'PROPOSAL_SHARED');

    assert.equal(normalizeImportedStatus('Didnt Receive'), 'DIDNT_RECEIVE');
    assert.equal(normalizeImportedStatus("didn't receive"), 'DIDNT_RECEIVE');
    assert.equal(normalizeImportedStatus('no answer'), 'DIDNT_RECEIVE');
    assert.equal(normalizeImportedStatus('not answered'), 'DIDNT_RECEIVE');
    assert.equal(normalizeImportedStatus('NR'), 'DIDNT_RECEIVE');
    assert.equal(normalizeImportedStatus('ringing'), 'DIDNT_RECEIVE');

    assert.equal(normalizeImportedStatus('Interested'), 'INTERESTED');
    assert.equal(normalizeImportedStatus('hot'), 'INTERESTED');
    assert.equal(normalizeImportedStatus('qualified'), 'INTERESTED');

    assert.equal(normalizeImportedStatus('Future Requirement'), 'FUTURE_REQUIREMENT');
    assert.equal(normalizeImportedStatus('future'), 'FUTURE_REQUIREMENT');
    assert.equal(normalizeImportedStatus('call later'), 'FUTURE_REQUIREMENT');
    assert.equal(normalizeImportedStatus('after 1 month'), 'FUTURE_REQUIREMENT');

    assert.equal(normalizeImportedStatus('Not Interested'), 'NOT_INTERESTED');
    assert.equal(normalizeImportedStatus('ni'), 'NOT_INTERESTED');
    assert.equal(normalizeImportedStatus('rejected'), 'NOT_INTERESTED');

    assert.equal(normalizeImportedStatus('Switch Off'), 'SWITCH_OFF');
    assert.equal(normalizeImportedStatus('switched off'), 'SWITCH_OFF');
    assert.equal(normalizeImportedStatus('switchoff'), 'SWITCH_OFF');
    assert.equal(normalizeImportedStatus('SO'), 'SWITCH_OFF');

    assert.equal(normalizeImportedStatus('Not a Solar Company'), 'NOT_A_SOLAR_COMPANY');
    assert.equal(normalizeImportedStatus('non solar'), 'NOT_A_SOLAR_COMPANY');
    assert.equal(normalizeImportedStatus('wrong industry'), 'NOT_A_SOLAR_COMPANY');

    assert.equal(normalizeImportedStatus('closed'), 'CLOSED_WON');
    assert.equal(normalizeImportedStatus('Closed Won'), 'CLOSED_WON');
    assert.equal(normalizeImportedStatus('won'), 'CLOSED_WON');

    assert.equal(normalizeImportedStatus('lost'), 'LEAD_LOST');
    assert.equal(normalizeImportedStatus('Lead Lost'), 'LEAD_LOST');

    // 2. Sales Person Name / Email Matching against /employees
    const pool = buildEmployeeMatchPool([]);
    const matchHastiFirst = matchSalesPersonToEmployeePure('Hasti', pool);
    assert.ok(matchHastiFirst);
    assert.equal(matchHastiFirst.email, 'hastisavani.07@solarithmdesign.com');
    assert.equal(matchHastiFirst.name, 'Savani Hasti Vijaybhai');

    const matchSavaniHasti = matchSalesPersonToEmployeePure('Savani Hasti', pool);
    assert.ok(matchSavaniHasti);
    assert.equal(matchSavaniHasti.email, 'hastisavani.07@solarithmdesign.com');

    const matchKrina = matchSalesPersonToEmployeePure('Krina', pool);
    assert.ok(matchKrina);
    assert.equal(matchKrina.email, 'krinadhami.10@solarithmdesign.com');

    const matchKrinal = matchSalesPersonToEmployeePure('Krinal', pool);
    assert.ok(matchKrinal);
    assert.equal(matchKrinal.email, 'krinalbodra.02@solarithmdesign.com');

    const matchEmail = matchSalesPersonToEmployeePure(
      'DEEPDAVARA.23@SOLARITHMDESIGN.COM',
      pool
    );
    assert.ok(matchEmail);
    assert.equal(matchEmail.name, 'Davara Deep Arvindbhai');

    // 3. Date of Calling parsing (DD-MM-YYYY, YYYY-MM-DD, Excel serial number, blank fallback)
    assert.equal(
      parseHistoricalCallingDate('15-10-2026', 'PROPOSAL_SHARED', '2026-11-01T08:00:00.000Z'),
      '2026-10-15T10:00:00.000Z'
    );
    assert.equal(
      parseHistoricalCallingDate('2026-10-20', 'INTERESTED', '2026-11-01T08:00:00.000Z'),
      '2026-10-20T10:00:00.000Z'
    );
    assert.equal(
      parseHistoricalCallingDate('', 'PROPOSAL_SHARED', '2026-11-01T08:00:00.000Z'),
      '2026-11-01T08:00:00.000Z'
    );
    assert.equal(
      parseHistoricalCallingDate('', 'FRESH', '2026-11-01T08:00:00.000Z'),
      null
    );

    // 4. Historical State Machine & Follow-Up Date Calculation via runPreFlightIngestionCheck + buildLeadRecordFromSanitizedRowPure
    const uploader = {
      email: 'jayshah.03@solarithmdesign.com',
      name: 'Jay Bharatbhai Shah',
    };

    const historicalSheet: RawSheetRow[] = [
      // Row 2: Untouched Fresh Lead
      {
        rowNumber: 2,
        companyName: 'Fresh Solar EPC One',
        phoneNumberRaw: '9811122233',
        statusRaw: '',
      },
      // Row 3: DIDNT_RECEIVE -> enters retry pool as FRESH with didntReceiveCount=1, callAttempts=1, cooldownUntil = +48h
      {
        rowNumber: 3,
        companyName: 'Retry Solar EPC Two',
        phoneNumberRaw: '9811122234',
        dateOfCalling: '20-10-2026',
        statusRaw: 'No Answer',
        salesPersonRaw: 'Hasti',
        remarksRaw: 'Ringing twice, no response',
      },
      // Row 4: PROPOSAL_SHARED with Sales Person "Hasti" -> nextFollowUpDate = lastCalledDate + 2 days
      {
        rowNumber: 4,
        companyName: 'Proposal Solar EPC Three',
        phoneNumberRaw: '9811122235',
        dateOfCalling: '2026-10-20',
        statusRaw: 'Quotation Sent',
        salesPersonRaw: 'Savani Hasti',
        remarksRaw: 'Sent 500kW quotation on WhatsApp',
      },
      // Row 5: FUTURE_REQUIREMENT with blank Sales Person -> assigns to uploader + flags repFallbackWarning, nextFollowUpDate = +30 days
      {
        rowNumber: 5,
        companyName: 'Future Solar EPC Four',
        phoneNumberRaw: '9811122236',
        dateOfCalling: '2026-10-10',
        statusRaw: 'After 1 month',
        salesPersonRaw: '',
        remarksRaw: 'Call back in November after Diwali',
      },
      // Row 6: INTERESTED -> surfaces in Owner Closing Queue, retains originating Sales Rep
      {
        rowNumber: 6,
        companyName: 'Hot Solar EPC Five',
        phoneNumberRaw: '9811122237',
        dateOfCalling: '2026-10-25',
        statusRaw: 'Qualified',
        salesPersonRaw: 'Krina',
        remarksRaw: 'Ready to finalize 1MW EPC contract',
      },
      // Row 7: SWITCH_OFF -> status = FRESH, switchOffCount = 1, callAttempts = 1
      {
        rowNumber: 7,
        companyName: 'Switched Off Solar Six',
        phoneNumberRaw: '9811122238',
        dateOfCalling: '2026-10-25',
        statusRaw: 'Switched Off',
      },
      // Row 8: NOT_INTERESTED -> archived status
      {
        rowNumber: 8,
        companyName: 'Rejected Solar Seven',
        phoneNumberRaw: '9811122239',
        dateOfCalling: '2026-10-25',
        statusRaw: 'Rejected',
        salesPersonRaw: 'Hasti',
        remarksRaw: 'Already installed rooftop solar',
      },
    ];

    const audit = await runPreFlightIngestionCheck(historicalSheet, [], {
      employees: pool,
      uploaderUser: uploader,
      nowIso: '2026-11-01T08:00:00.000Z',
    });

    assert.equal(audit.validFreshLeads.length, 7);

    const breakdown = computePreFlightBreakdownPure({
      validFreshLeads: audit.validFreshLeads,
      duplicatesCount: audit.duplicatesDetected.length,
      malformedCount: audit.malformedRows.length,
    });

    assert.equal(breakdown.freshUntouchedCount, 1);
    assert.equal(breakdown.historicalCalledCount, 6);
    assert.equal(breakdown.historicalBreakdown.DIDNT_RECEIVE, 1);
    assert.equal(breakdown.historicalBreakdown.PROPOSAL_SHARED, 1);
    assert.equal(breakdown.historicalBreakdown.FUTURE_REQUIREMENT, 1);
    assert.equal(breakdown.historicalBreakdown.INTERESTED, 1);
    assert.equal(breakdown.historicalBreakdown.SWITCH_OFF, 1);
    assert.equal(breakdown.historicalBreakdown.NOT_INTERESTED, 1);
    assert.equal(breakdown.repFallbackWarningsCount, 1);

    const builtLeads = audit.validFreshLeads.map((item, idx) =>
      buildLeadRecordFromSanitizedRowPure(item, {
        id: `hist-${idx}`,
        importBatchId: 'IMP_HIST_TEST',
        nowIso: '2026-11-01T08:00:00.000Z',
        employees: pool,
        uploaderUser: uploader,
      })
    );

    // Check Row 2 (FRESH)
    assert.equal(builtLeads[0].status, 'FRESH');
    assert.equal(builtLeads[0].callAttempts, 0);
    assert.equal(builtLeads[0].assignedRepEmail, null);
    assert.equal(builtLeads[0].assignedBatchId, null);

    // Check Row 3 (DIDNT_RECEIVE -> status: FRESH, didntReceiveCount: 1, cooldownUntil: +48h)
    assert.equal(builtLeads[1].status, 'FRESH');
    assert.equal(builtLeads[1].didntReceiveCount, 1);
    assert.equal(builtLeads[1].callAttempts, 1);
    assert.equal(builtLeads[1].assignedRepEmail, null);
    assert.equal(builtLeads[1].cooldownUntil, '2026-10-22T10:00:00.000Z');
    assert.equal(builtLeads[1].remarks, 'Ringing twice, no response');
    assert.equal(builtLeads[1].remarksAuthor, 'Savani Hasti Vijaybhai');

    // Check Row 4 (PROPOSAL_SHARED -> nextFollowUpDate: +2 days, rep: Savani Hasti Vijaybhai)
    assert.equal(builtLeads[2].status, 'PROPOSAL_SHARED');
    assert.equal(builtLeads[2].callAttempts, 1);
    assert.equal(builtLeads[2].assignedRepEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(builtLeads[2].assignedRepName, 'Savani Hasti Vijaybhai');
    assert.equal(builtLeads[2].nextFollowUpDate, '2026-10-22T10:00:00.000Z');
    assert.ok(builtLeads[2].notes?.includes('Sent 500kW quotation on WhatsApp'));

    // Check Row 5 (FUTURE_REQUIREMENT with blank Sales Person -> assigned to uploader, nextFollowUpDate: +30 days)
    assert.equal(builtLeads[3].status, 'FUTURE_REQUIREMENT');
    assert.equal(builtLeads[3].callAttempts, 1);
    assert.equal(builtLeads[3].assignedRepEmail, 'jayshah.03@solarithmdesign.com');
    assert.equal(builtLeads[3].assignedRepName, 'Jay Bharatbhai Shah');
    assert.equal(builtLeads[3].nextFollowUpDate, '2026-11-09T10:00:00.000Z');

    // Check Row 6 (INTERESTED -> Owner Closing Queue, retains originating rep Krina)
    assert.equal(builtLeads[4].status, 'INTERESTED');
    assert.equal(builtLeads[4].callAttempts, 1);
    assert.equal(builtLeads[4].assignedRepEmail, 'krinadhami.10@solarithmdesign.com');
    assert.equal(builtLeads[4].assignedRepName, 'Dhami Krina Rajeshbhai');

    // Check Row 7 (SWITCH_OFF -> status: FRESH, switchOffCount: 1)
    assert.equal(builtLeads[5].status, 'FRESH');
    assert.equal(builtLeads[5].switchOffCount, 1);
    assert.equal(builtLeads[5].callAttempts, 1);
    assert.equal(builtLeads[5].assignedRepEmail, null);

    // Check Row 8 (NOT_INTERESTED -> archived)
    assert.equal(builtLeads[6].status, 'NOT_INTERESTED');
    assert.equal(builtLeads[6].callAttempts, 1);

    // 5. Verify Overwriting an existing FRESH lead with an updated historical status sheet
    const existingFreshLead = builtLeads[0];
    const updatedStatusRow = audit.validFreshLeads[2]; // PROPOSAL_SHARED row
    const overwrittenLead = mergeDuplicateLeadRecord(
      existingFreshLead,
      updatedStatusRow,
      '2026-11-01T09:00:00.000Z',
      { employees: pool, uploaderUser: uploader }
    );
    assert.equal(overwrittenLead.status, 'PROPOSAL_SHARED');
    assert.equal(overwrittenLead.assignedRepEmail, 'hastisavani.07@solarithmdesign.com');
    assert.equal(overwrittenLead.nextFollowUpDate, '2026-10-22T10:00:00.000Z');
  });

  it('Task 3: computeOperationalDatesForStatus calculates +48h cooldown for DIDNT_RECEIVE, +2d for PROPOSAL_SHARED, and +30d for FUTURE_REQUIREMENT', () => {
    const baseIso = '2026-10-10T10:00:00.000Z';

    const didntReceiveDates = computeOperationalDatesForStatus('DIDNT_RECEIVE', baseIso);
    assert.equal(didntReceiveDates.cooldownUntil, '2026-10-12T10:00:00.000Z');
    assert.equal(didntReceiveDates.nextFollowUpDate, null);

    const proposalDates = computeOperationalDatesForStatus('PROPOSAL_SHARED', baseIso);
    assert.equal(proposalDates.cooldownUntil, null);
    assert.equal(proposalDates.nextFollowUpDate, '2026-10-12T10:00:00.000Z');

    const futureDates = computeOperationalDatesForStatus('FUTURE_REQUIREMENT', baseIso);
    assert.equal(futureDates.cooldownUntil, null);
    assert.equal(futureDates.nextFollowUpDate, '2026-11-09T10:00:00.000Z');

    const sanitized = sanitizeFirestorePayload({
      id: 'lead-1',
      state: undefined,
      callAttempts: Number.NaN,
    });
    assert.equal('state' in sanitized, false);
    assert.equal(sanitized.callAttempts, null);
  });

  it('Task 4: generateStratifiedBatch enforces status == FRESH and assignedBatchId == null, excludes active 48h cooldowns, allocates 75/25 (2,250 / 750), backfills shortfalls, and runs Fisher-Yates shuffle', () => {
    const now = new Date('2026-10-27T12:00:00.000Z');
    const pool: LeadRecord[] = [];

    // 2,400 untouched FRESH leads (Bucket A)
    for (let i = 0; i < 2400; i++) {
      pool.push(makeLead(`A-${i}`, { callAttempts: 0, didntReceiveCount: 0, assignedBatchId: null }));
    }

    // 900 retry FRESH leads with expired cooldown (Bucket B)
    for (let i = 0; i < 900; i++) {
      pool.push(
        makeLead(`B-${i}`, {
          callAttempts: 2,
          didntReceiveCount: 2,
          cooldownUntil: '2026-10-26T10:00:00.000Z', // expired
          assignedBatchId: null,
        })
      );
    }

    // 150 leads already assigned to a batch (must be excluded by assignedBatchId == null check)
    for (let i = 0; i < 150; i++) {
      pool.push(
        makeLead(`ASSIGNED-${i}`, {
          callAttempts: 0,
          assignedBatchId: 'BATCH_2026_10_27_01',
        })
      );
    }

    // 100 leads on active 48-hour cooldown (must be excluded)
    for (let i = 0; i < 100; i++) {
      pool.push(
        makeLead(`COOLDOWN-${i}`, {
          callAttempts: 1,
          didntReceiveCount: 1,
          cooldownUntil: computeCooldownUntil('2026-10-27T08:00:00.000Z', 48),
          assignedBatchId: null,
        })
      );
    }

    let seed = 1337;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const batch = generateStratifiedBatch(pool, 3000, now, rng);
    assert.equal(batch.batchLeads.length, 3000);
    assert.equal(batch.bucketACount, 2250);
    assert.equal(batch.bucketBCount, 750);
    assert.equal(batch.excludedOnCooldownCount, 100);
    assert.equal(
      batch.batchLeads.some((l) => l.id.startsWith('ASSIGNED-')),
      false,
      'Leads with non-null assignedBatchId must be excluded'
    );
    assert.equal(
      batch.batchLeads.some((l) => isLeadOnCooldown(l, now)),
      false,
      'Leads on active 48h cooldown must be excluded'
    );

    // Verify mutual backfill when Bucket B has fewer than 750 leads (e.g., only 250 Bucket B leads + 2,900 Bucket A leads)
    const shortfallPool: LeadRecord[] = [];
    for (let i = 0; i < 2900; i++) {
      shortfallPool.push(makeLead(`A2-${i}`, { callAttempts: 0 }));
    }
    for (let i = 0; i < 250; i++) {
      shortfallPool.push(
        makeLead(`B2-${i}`, {
          callAttempts: 1,
          didntReceiveCount: 1,
          cooldownUntil: '2026-10-25T00:00:00.000Z',
        })
      );
    }
    const backfilledBatch = generateStratifiedBatch(shortfallPool, 3000, now, rng);
    assert.equal(backfilledBatch.batchLeads.length, 3000);
    assert.equal(backfilledBatch.bucketBCount, 250);
    assert.equal(backfilledBatch.bucketACount, 2750);

    // Verify Fisher-Yates shuffle mutates in place
    const sampleArr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffledRef = fisherYatesShuffle(sampleArr, rng);
    assert.equal(shuffledRef, sampleArr);
    assert.equal(sampleArr.length, 10);
  });
});
