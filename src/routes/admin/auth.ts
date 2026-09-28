import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { env, sessionSecret } from '../../config/env.js';
import { parseCookies, signSession, verifyPassword, verifySession } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { ah } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { simulatorEnabled } from '../../services/simulator.js';

export const SESSION_COOKIE = 'qz_admin';

/** A valid scrypt hash of a random password, used to spend equal time on unknown emails. */
const DUMMY_HASH = `scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(64, 7).toString('base64')}`;

declare global {
  namespace Express {
    interface Request {
      admin?: { id: string; email: string; name: string };
    }
  }
}

// ── Login throttling (per IP, in memory) ─────────────────────
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string) {
  // Keep the map bounded: drop expired entries now and then.
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.resetAt < Date.now()) failures.delete(k);
  const entry = failures.get(key);
  if (!entry || entry.resetAt < Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count++;
}

export function resetLoginThrottle() {
  failures.clear();
}

// ── Cookie helpers ───────────────────────────────────────────
const secureCookies = env.APP_BASE_URL.startsWith('https://');

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secureCookies ? ['Secure'] : []),
  ].join('; ');
}

/** Rejects requests without a valid session for an active admin. */
export const requireAdmin: RequestHandler = ah(async (req, _res, next) => {
  const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], sessionSecret);
  const admin = session
    ? await prisma.adminUser.findUnique({ where: { id: session.sub }, select: { id: true, email: true, name: true, active: true } })
    : null;
  if (!admin?.active) throw new AppError('Please sign in', 401, 'UNAUTHENTICATED');
  req.admin = { id: admin.id, email: admin.email, name: admin.name };
  next();
});

const loginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

export const authRouter = Router();

authRouter.post(
  '/auth/login',
  ah(async (req, res) => {
    const key = req.ip ?? 'unknown';
    if (tooManyAttempts(key)) {
      throw new AppError('Too many failed sign-in attempts. Try again in 15 minutes.', 429, 'RATE_LIMITED');
    }
    const { email, password } = loginBody.parse(req.body);
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    // Unknown emails still pay the password-hash cost, so response time does not reveal which exist.
    const ok = admin?.active ? await verifyPassword(password, admin.passwordHash) : (await verifyPassword(password, DUMMY_HASH), false);

    if (!admin || !ok) {
      recordFailure(key);
      logger.warn({ email, ip: key }, 'failed admin sign-in');
      throw new AppError('Email or password is incorrect', 401, 'INVALID_CREDENTIALS');
    }

    failures.delete(key);
    const maxAge = Math.round(env.ADMIN_SESSION_HOURS * 3600);
    const token = signSession({ sub: admin.id, exp: Math.floor(Date.now() / 1000) + maxAge }, sessionSecret);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

    res.setHeader('Set-Cookie', sessionCookie(token, maxAge));
    res.json({ admin: { id: admin.id, email: admin.email, name: admin.name } });
  }),
);

authRouter.post('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.json({ ok: true });
});

authRouter.get('/auth/me', requireAdmin, (req, res) => {
  res.json({ admin: req.admin, simulator: simulatorEnabled() });
});
