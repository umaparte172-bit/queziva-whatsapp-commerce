import { describe, expect, it } from 'vitest';
import { allocateProportionally, calculateTotals } from '../src/domain/pricing.js';
import { formatINR } from '../src/lib/money.js';

describe('calculateTotals', () => {
  it("matches the client's example: ₹647 + ₹59 shipping = ₹706 (GST-inclusive prices)", () => {
    const result = calculateTotals({
      lines: [
        { unitPricePaise: 29900, quantity: 1, gstRateBps: 300 },
        { unitPricePaise: 34800, quantity: 1, gstRateBps: 300 },
      ],
      shippingPaise: 5900,
      pricesIncludeGst: true,
    });
    expect(result.subtotalPaise).toBe(64700);
    expect(result.totalPaise).toBe(70600);
    // GST is contained in the price (shown for invoicing only), rounded per line:
    // 29900 × 3/103 ≈ 871, 34800 × 3/103 ≈ 1014
    expect(result.taxPaise).toBe(871 + 1014);
  });

  it('adds GST on top when prices exclude it', () => {
    const result = calculateTotals({
      lines: [{ unitPricePaise: 100000, quantity: 2, gstRateBps: 300 }],
      shippingPaise: 5900,
      pricesIncludeGst: false,
    });
    expect(result.subtotalPaise).toBe(200000);
    expect(result.taxPaise).toBe(6000);
    expect(result.totalPaise).toBe(200000 + 6000 + 5900);
  });

  it('applies GST to the discounted value', () => {
    const result = calculateTotals({
      lines: [{ unitPricePaise: 100000, quantity: 1, gstRateBps: 300 }],
      discountPaise: 10000,
      pricesIncludeGst: false,
    });
    expect(result.taxPaise).toBe(2700);
    expect(result.totalPaise).toBe(100000 - 10000 + 2700);
  });

  it('spreads the discount across lines so shares add up exactly', () => {
    const result = calculateTotals({
      lines: [
        { unitPricePaise: 33333, quantity: 1, gstRateBps: 300 },
        { unitPricePaise: 33333, quantity: 1, gstRateBps: 300 },
        { unitPricePaise: 33334, quantity: 1, gstRateBps: 300 },
      ],
      discountPaise: 1000,
      pricesIncludeGst: true,
    });
    expect(result.lines.reduce((s, l) => s + l.discountPaise, 0)).toBe(1000);
  });

  it('ignores zero-quantity lines in the subtotal', () => {
    const result = calculateTotals({
      lines: [
        { unitPricePaise: 29900, quantity: 0, gstRateBps: 300 },
        { unitPricePaise: 19900, quantity: 1, gstRateBps: 300 },
      ],
      pricesIncludeGst: true,
    });
    expect(result.subtotalPaise).toBe(19900);
  });

  it('rejects a discount larger than the subtotal', () => {
    expect(() =>
      calculateTotals({ lines: [{ unitPricePaise: 1000, quantity: 1, gstRateBps: 0 }], discountPaise: 1001, pricesIncludeGst: true }),
    ).toThrow(/cannot exceed/);
  });

  it('rejects fractional or negative amounts', () => {
    expect(() =>
      calculateTotals({ lines: [{ unitPricePaise: 10.5, quantity: 1, gstRateBps: 0 }], pricesIncludeGst: true }),
    ).toThrow();
    expect(() =>
      calculateTotals({ lines: [{ unitPricePaise: 1000, quantity: -1, gstRateBps: 0 }], pricesIncludeGst: true }),
    ).toThrow();
  });
});

describe('allocateProportionally', () => {
  it('returns exact integer parts', () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('formatINR', () => {
  it('formats paise for customer messages', () => {
    expect(formatINR(70600)).toBe('₹706');
    expect(formatINR(123450)).toBe('₹1,234.50');
    expect(formatINR(1234500000)).toBe('₹1,23,45,000');
  });
});
