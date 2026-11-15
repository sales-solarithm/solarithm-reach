import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeIndianPhone, normalizeCompanyName } from './phoneSanitizer';

test('sanitizeIndianPhone handles clean 10-digit numbers starting with 6, 7, 8, 9', () => {
  const res = sanitizeIndianPhone('9429360746');
  assert.equal(res.isValid, true);
  assert.equal(res.cleaned, '9429360746');
  assert.equal(res.formatted, '+91 94293 60746');
});

test('sanitizeIndianPhone handles Excel float .0 and scientific notation', () => {
  const floatRes = sanitizeIndianPhone('9825011223.0');
  assert.equal(floatRes.isValid, true);
  assert.equal(floatRes.cleaned, '9825011223');
  assert.equal(floatRes.formatted, '+91 98250 11223');

  const sciRes = sanitizeIndianPhone('9.82501E+09');
  assert.equal(sciRes.isValid, true);
  assert.equal(sciRes.cleaned, '9825010000');
  assert.equal(sciRes.formatted, '+91 98250 10000');
});

test('sanitizeIndianPhone strips 91 (12 digits), 091 (13 digits), 0 (11 digits), and 0091 (14 digits)', () => {
  const p91 = sanitizeIndianPhone('919429360746');
  assert.equal(p91.isValid, true);
  assert.equal(p91.cleaned, '9429360746');

  const p091 = sanitizeIndianPhone('0919429360746');
  assert.equal(p091.isValid, true);
  assert.equal(p091.cleaned, '9429360746');

  const p0 = sanitizeIndianPhone('09429360746');
  assert.equal(p0.isValid, true);
  assert.equal(p0.cleaned, '9429360746');

  const p0091 = sanitizeIndianPhone('00919429360746');
  assert.equal(p0091.isValid, true);
  assert.equal(p0091.cleaned, '9429360746');
});

test('sanitizeIndianPhone strips punctuation and whitespace while preserving prefix stripping', () => {
  const res = sanitizeIndianPhone(' +91 (94293) - 60746 ');
  assert.equal(res.isValid, true);
  assert.equal(res.cleaned, '9429360746');
  assert.equal(res.formatted, '+91 94293 60746');
});

test('sanitizeIndianPhone rejects invalid lengths and numbers starting with 1-5', () => {
  const shortRes = sanitizeIndianPhone('98250112');
  assert.equal(shortRes.isValid, false);
  assert.ok(shortRes.error);

  const badStartRes = sanitizeIndianPhone('5429360746');
  assert.equal(badStartRes.isValid, false);
  assert.ok(badStartRes.error);
});

test('normalizeCompanyName trims, lowercases, and collapses multiple spaces', () => {
  assert.equal(
    normalizeCompanyName('  Surya   Kiran  Solar   EPC Pvt Ltd '),
    'surya kiran solar epc pvt ltd'
  );
});
