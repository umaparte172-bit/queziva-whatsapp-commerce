/** Money helpers. All amounts are integer paise. */

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** ₹1,234.50 / ₹706 – whole rupees drop the decimals, as customers expect. */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  const fraction = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: fraction, maximumFractionDigits: fraction })}`;
}

export function assertPaise(value: number, label = 'amount'): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of paise, got ${value}`);
  }
}
