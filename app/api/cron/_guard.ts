import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Cron guard — fails closed.
 * - On Vercel, the platform sets x-vercel-cron: 1 and enforces access itself.
 * - Otherwise the caller MUST present `Authorization: Bearer ${CRON_SECRET}`.
 * - Missing CRON_SECRET => deny (never allow-all). Compare is constant-time.
 */
export function isCronAuthorized(req: NextRequest): boolean {
  const vercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
  if (vercel && req.headers.get('x-vercel-cron') === '1') return true;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const authHeader = req.headers.get('authorization') || '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function cronUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}