import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of `payload`. */
export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time check of a hex HMAC-SHA256 signature.
 * Used for Razorpay (X-Razorpay-Signature) and Meta (X-Hub-Signature-256, after stripping "sha256=").
 * Always verify against the raw request body – re-serialised JSON will not match.
 */
export function verifyHmacSha256(secret: string, payload: string | Buffer, signatureHex: string): boolean {
  if (!secret || !signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const expected = Buffer.from(hmacSha256Hex(secret, payload), 'hex');
  const received = Buffer.from(signatureHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Constant-time string comparison for shared-secret tokens (e.g. Shiprocket's x-api-key). */
export function safeEqual(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
