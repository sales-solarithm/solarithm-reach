export interface SanitizedPhoneResult {
  isValid: boolean;
  raw: string;
  cleaned: string;
  formatted: string;
  error?: string;
}

/**
 * Universal Indian Phone Normalizer for dirty Excel exports, floats, scientific notation,
 * and regional prefixes (91, 091, 0, 0091).
 */
export function sanitizeIndianPhone(input: unknown): SanitizedPhoneResult {
  const rawString = input === null || input === undefined ? '' : String(input);
  const trimmed = rawString.trim();

  if (!trimmed) {
    return {
      isValid: false,
      raw: rawString,
      cleaned: '',
      formatted: '',
      error: 'Phone number is empty',
    };
  }

  let normalized = trimmed;

  // Handle Excel scientific notation (e.g., "9.82501E+09" or "9.825011223E+09")
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(normalized)) {
    const parsedNum = Number(normalized);
    if (!Number.isNaN(parsedNum) && Number.isFinite(parsedNum)) {
      normalized = Math.round(parsedNum).toFixed(0);
    }
  }

  // Strip trailing .0 or .00 from Excel float exports (e.g. "9825011223.0")
  normalized = normalized.replace(/\.0+$/, '');

  // Strip all non-digit characters (\D)
  let digits = normalized.replace(/\D/g, '');

  if (!digits) {
    return {
      isValid: false,
      raw: rawString,
      cleaned: '',
      formatted: '',
      error: 'Contains no numeric digits',
    };
  }

  // Prefix Stripping Logic based on exact digit count
  if (digits.length === 14 && digits.startsWith('0091')) {
    digits = digits.slice(4);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Validation: strictly 10 digits and starts with 6, 7, 8, or 9
  if (digits.length !== 10) {
    return {
      isValid: false,
      raw: rawString,
      cleaned: digits,
      formatted: '',
      error: `Expected 10 digits after prefix stripping, got ${digits.length}`,
    };
  }

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return {
      isValid: false,
      raw: rawString,
      cleaned: digits,
      formatted: '',
      error: `Invalid starting digit "${digits[0]}" (must start with 6, 7, 8, or 9)`,
    };
  }

  const formatted = `+91 ${digits.slice(0, 5)} ${digits.slice(5, 10)}`;

  return {
    isValid: true,
    raw: rawString,
    cleaned: digits,
    formatted,
  };
}

export const sanitizePhoneNumber = sanitizeIndianPhone;

export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

