import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { hmacSha256Hex, verifyHmacSha256 } from './signature.js';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hash format: scrypt$N$r$p$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new RangeError('Password must be at least 8 characters');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;
  try {
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false; // malformed parameters in the stored hash
  }
}

export interface SessionPayload {
  /** AdminUser id */
  sub: string;
  /** expiry, epoch seconds */
  exp: number;
}

/** `<base64url payload>.<hex HMAC>` */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacSha256Hex(secret, body)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature || !verifyHmacSha256(secret, body, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return cookies;
}
