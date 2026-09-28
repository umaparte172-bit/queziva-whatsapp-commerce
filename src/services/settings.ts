import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

/**
 * Settings the team can change from the dashboard (stored in the Setting table).
 * Unknown or missing values fall back to the defaults below.
 */

export const MILESTONES = ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPT_FAILED', 'DELIVERED'] as const;
export type Milestone = (typeof MILESTONES)[number];

export const settingsSchema = z.object({
  /** Which shipment updates are sent to the customer on WhatsApp */
  notify: z.object({
    SHIPPED: z.boolean(),
    IN_TRANSIT: z.boolean(),
    OUT_FOR_DELIVERY: z.boolean(),
    DELIVERY_ATTEMPT_FAILED: z.boolean(),
    DELIVERED: z.boolean(),
  }),
  feedback: z.object({
    enabled: z.boolean(),
    /** Hours after delivery before asking for feedback */
    delayHours: z.number().min(1).max(24 * 30),
  }),
  /** Without the @ */
  instagramHandle: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9._]{0,30}$/, 'Instagram handles use letters, numbers, dots and underscores')),
  /** Optional link for reviews (Google, website…) */
  reviewUrl: z.string().trim().url().startsWith('https://', 'The review link must start with https://').or(z.literal('')),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  // Keep it to the updates customers care about – "in transit" can fire many times a day.
  notify: { SHIPPED: true, IN_TRANSIT: false, OUT_FOR_DELIVERY: true, DELIVERY_ATTEMPT_FAILED: true, DELIVERED: true },
  feedback: { enabled: true, delayHours: 48 },
  instagramHandle: 'queziva',
  reviewUrl: '',
};

const KEY = 'app';

export async function getSettings(): Promise<Settings> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Partial<Settings>;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...(stored.notify ?? {}) },
    feedback: { ...DEFAULT_SETTINGS.feedback, ...(stored.feedback ?? {}) },
  };
  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Keep every valid stored value; only an invalid field falls back to its default.
  const field = <K extends keyof Settings>(key: K): Settings[K] => {
    const one = settingsSchema.shape[key].safeParse(merged[key]);
    return one.success ? (one.data as Settings[K]) : DEFAULT_SETTINGS[key];
  };
  return { notify: field('notify'), feedback: field('feedback'), instagramHandle: field('instagramHandle'), reviewUrl: field('reviewUrl') };
}

export async function updateSettings(input: unknown): Promise<Settings> {
  const current = await getSettings();
  const partial = input as Partial<Settings>;
  const next = settingsSchema.parse({
    ...current,
    ...partial,
    notify: { ...current.notify, ...(partial?.notify ?? {}) },
    feedback: { ...current.feedback, ...(partial?.feedback ?? {}) },
  });
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

export function instagramUrl(handle: string): string {
  return `https://instagram.com/${handle}`;
}
