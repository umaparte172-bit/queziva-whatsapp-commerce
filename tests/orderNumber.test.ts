import { describe, expect, it } from 'vitest';
import { dateStamp, formatOrderNumber } from '../src/domain/orderNumber.js';

describe('order numbers', () => {
  it('formats as prefix + YYMMDD + 3-digit sequence', () => {
    expect(formatOrderNumber('QZ', '260928', 1)).toBe('QZ260928001');
    expect(formatOrderNumber('QZ', '260928', 42)).toBe('QZ260928042');
    expect(formatOrderNumber('QZ', '260928', 1234)).toBe('QZ2609281234');
  });

  it('uses the Indian date, not UTC', () => {
    // 27 Sep 2026 19:00 UTC is already 28 Sep 00:30 in India
    const lateEveningUtc = new Date('2026-09-27T19:00:00Z');
    expect(dateStamp(lateEveningUtc, 'Asia/Kolkata')).toBe('260928');
    expect(dateStamp(lateEveningUtc, 'UTC')).toBe('260927');
  });

  it('rejects invalid sequences', () => {
    expect(() => formatOrderNumber('QZ', '260928', 0)).toThrow();
  });
});
