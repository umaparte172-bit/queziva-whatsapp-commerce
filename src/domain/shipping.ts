import type { CourierOption } from '../integrations/shiprocket/types.js';
import { formatINR } from '../lib/money.js';

export interface PackageItem {
  quantity: number;
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

export interface PackageSize {
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

/**
 * One parcel for the whole order: the footprint of the largest item, with every piece's
 * height stacked, plus packaging weight. Good enough for jewellery boxes; couriers bill on
 * max(actual, volumetric) weight anyway.
 */
export function buildPackage(items: PackageItem[], packagingGrams: number): PackageSize {
  const units = items.filter((i) => i.quantity > 0);
  if (units.length === 0) throw new RangeError('Cannot build a package without items');
  return {
    weightGrams: units.reduce((g, i) => g + i.weightGrams * i.quantity, 0) + packagingGrams,
    lengthCm: Math.max(...units.map((i) => i.lengthCm)),
    breadthCm: Math.max(...units.map((i) => i.breadthCm)),
    heightCm: Math.round(units.reduce((h, i) => h + i.heightCm * i.quantity, 0) * 10) / 10,
  };
}

export type CourierStrategy = 'cheapest' | 'fastest' | 'recommended';

/** Picks a courier. Ties are broken by the other criterion, then by rating. */
export function chooseCourier(options: CourierOption[], strategy: CourierStrategy): CourierOption | undefined {
  if (options.length === 0) return undefined;
  const etd = (o: CourierOption) => o.etdDays ?? Number.POSITIVE_INFINITY;
  const rating = (o: CourierOption) => o.rating ?? 0;

  if (strategy === 'recommended') {
    const pick = options.find((o) => o.recommended);
    if (pick) return pick;
  }
  const sorted = [...options].sort((a, b) =>
    strategy === 'fastest'
      ? etd(a) - etd(b) || a.ratePaise - b.ratePaise || rating(b) - rating(a)
      : a.ratePaise - b.ratePaise || etd(a) - etd(b) || rating(b) - rating(a),
  );
  return sorted[0];
}

export interface ShippingRules {
  /** Free shipping when goods value ≥ this (paise). 0 = off. */
  freeAbovePaise: number;
  /** Fixed customer charge instead of the courier rate */
  flatRatePaise?: number;
  roundToRupee: boolean;
}

/** What the customer pays for shipping, and why. */
export function customerShippingCharge(
  courierRatePaise: number,
  goodsValuePaise: number,
  rules: ShippingRules,
): { chargePaise: number; note: string | null } {
  if (rules.freeAbovePaise > 0 && goodsValuePaise >= rules.freeAbovePaise) {
    return { chargePaise: 0, note: `Free shipping on orders of ${formatINR(rules.freeAbovePaise)} or more` };
  }
  if (rules.flatRatePaise !== undefined) {
    return { chargePaise: rules.flatRatePaise, note: 'Flat shipping rate' };
  }
  const chargePaise = rules.roundToRupee ? Math.ceil(courierRatePaise / 100) * 100 : courierRatePaise;
  return { chargePaise, note: null };
}
