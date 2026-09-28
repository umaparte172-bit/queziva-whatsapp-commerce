import { ValidationError } from '../lib/errors.js';
import { assertPaise } from '../lib/money.js';

export interface PricingLine {
  unitPricePaise: number;
  quantity: number;
  gstRateBps: number;
}

export interface PricingInput {
  lines: PricingLine[];
  discountPaise?: number;
  shippingPaise?: number;
  /** true when unit prices already include GST (tax is then informational, not added) */
  pricesIncludeGst: boolean;
}

export interface PricedLine extends PricingLine {
  lineTotalPaise: number;
  /** share of the order discount allocated to this line */
  discountPaise: number;
  taxPaise: number;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  /** GST on the discounted goods value. Added to the total only when prices exclude GST. */
  taxPaise: number;
  totalPaise: number;
  pricesIncludeGst: boolean;
}

/**
 * Calculates order totals.
 *
 * total = subtotal − discount + shipping (+ tax when prices exclude GST)
 *
 * The order-level discount is spread across lines in proportion to their value
 * (largest-remainder rounding, so the shares always add up exactly), and GST is
 * computed per line on the discounted value so mixed GST rates stay correct.
 * Shipping is passed through as quoted.
 */
export function calculateTotals(input: PricingInput): PricingResult {
  const discountPaise = input.discountPaise ?? 0;
  const shippingPaise = input.shippingPaise ?? 0;
  assertPaise(discountPaise, 'discount');
  assertPaise(shippingPaise, 'shipping');

  for (const line of input.lines) {
    assertPaise(line.unitPricePaise, 'unit price');
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new ValidationError(`Quantity must be a non-negative integer, got ${line.quantity}`);
    }
    if (!Number.isInteger(line.gstRateBps) || line.gstRateBps < 0) {
      throw new ValidationError(`GST rate must be a non-negative integer (basis points), got ${line.gstRateBps}`);
    }
  }

  const lineTotals = input.lines.map((l) => l.unitPricePaise * l.quantity);
  const subtotalPaise = lineTotals.reduce((a, b) => a + b, 0);

  if (discountPaise > subtotalPaise) {
    throw new ValidationError(`Discount (${discountPaise}) cannot exceed the product subtotal (${subtotalPaise})`);
  }

  const discounts = allocateProportionally(discountPaise, lineTotals);

  const lines: PricedLine[] = input.lines.map((line, i) => {
    const lineTotalPaise = lineTotals[i]!;
    const lineDiscount = discounts[i]!;
    const taxable = lineTotalPaise - lineDiscount;
    const taxPaise = input.pricesIncludeGst
      ? Math.round((taxable * line.gstRateBps) / (10_000 + line.gstRateBps))
      : Math.round((taxable * line.gstRateBps) / 10_000);
    return { ...line, lineTotalPaise, discountPaise: lineDiscount, taxPaise };
  });

  const taxPaise = lines.reduce((sum, l) => sum + l.taxPaise, 0);
  const totalPaise =
    subtotalPaise - discountPaise + shippingPaise + (input.pricesIncludeGst ? 0 : taxPaise);

  return {
    lines,
    subtotalPaise,
    discountPaise,
    shippingPaise,
    taxPaise,
    totalPaise,
    pricesIncludeGst: input.pricesIncludeGst,
  };
}

/** Splits `amount` across `weights` proportionally; the parts are integers that sum exactly to `amount`. */
export function allocateProportionally(amount: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (amount === 0 || totalWeight === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (amount * w) / totalWeight);
  const parts = exact.map(Math.floor);
  let remainder = amount - parts.reduce((a, b) => a + b, 0);

  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of byFraction) {
    if (remainder === 0) break;
    parts[index]! += 1;
    remainder -= 1;
  }
  return parts;
}
