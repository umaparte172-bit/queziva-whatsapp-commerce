/** YYMMDD for the given instant in the business time zone (IST by default). */
export function dateStamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * QZ260928001 = prefix + YYMMDD + daily sequence (3 digits, grows to 4+ past 999).
 */
export function formatOrderNumber(prefix: string, stamp: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive integer, got ${sequence}`);
  }
  return `${prefix}${stamp}${String(sequence).padStart(3, '0')}`;
}
