import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getRedis } from '@/features/auth/redis';
import { tirbeoEmailFor } from '@/features/identity/tirbeo';

/**
 * Device-scoped account memory powering the multi-account switcher.
 *
 * A random, httpOnly `__device` cookie identifies the browser/device. Every
 * account that authenticates on this device is remembered (Redis hash,
 * 90-day TTL) so the user can switch between them without re-entering
 * credentials — the same trust model as Google's account switcher (the
 * device cookie is unguessable and only readable server-side).
 */

export const DEVICE_COOKIE_NAME = '__device';
const DEVICE_COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.com';

const IS_PROD = process.env.NODE_ENV !== 'development';

const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function getDeviceCookieDomain(request?: NextRequest): string | undefined {
  const host = request?.headers?.get('host') || '';
  const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  if (isLocalhost) return 'localhost';
  if (IS_PROD) return DEVICE_COOKIE_DOMAIN;
  return 'localhost';
}

function getDeviceCookieOptions(request?: NextRequest) {
  return {
    httpOnly: true,
    secure: IS_PROD && !getDeviceCookieDomain(request)?.includes('localhost'),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
    domain: getDeviceCookieDomain(request),
  };
}

const DEVICE_ID_RE = /^[a-f0-9]{64}$/;

/** Max remembered accounts per device — evict oldest beyond this (Google caps too). */
const MAX_ACCOUNTS_PER_DEVICE = 8;

// Accounts the user explicitly removed on this device stay out of the switcher
// for a while even if they make authenticated requests from another tab
// (which would otherwise lazily re-remember them).
const recentlyRemoved = new Set<string>();

function markRemoved(deviceId: string, userId: string) {
  const key = `${deviceId}:${userId}`;
  recentlyRemoved.add(key);
  setTimeout(() => recentlyRemoved.delete(key), 10 * 60 * 1000).unref?.();
}

/** True if the user explicitly removed this account on this device recently. */
export function wasRecentlyRemoved(deviceId: string, userId: string): boolean {
  return recentlyRemoved.has(`${deviceId}:${userId}`);
}

export function getDeviceId(request: NextRequest): string | null {
  const value = request.cookies.get(DEVICE_COOKIE_NAME)?.value;
  if (value && DEVICE_ID_RE.test(value)) return value;
  return null;
}

export function setDeviceCookie(response: NextResponse, request?: NextRequest): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  response.cookies.set(DEVICE_COOKIE_NAME, deviceId, getDeviceCookieOptions(request));
  return deviceId;
}

/** Return the existing device id, or mint + set a fresh cookie and return it. */
export function ensureDeviceId(request: NextRequest, response: NextResponse): string {
  return getDeviceId(request) || setDeviceCookie(response, request);
}

const DEVICE_ACCOUNTS_TTL_S = 60 * 60 * 24 * 90; // 90 days
const deviceAccountsKey = (deviceId: string) => `device:${deviceId}:accounts`;

/**
 * Remember that `userId` signed in on `deviceId`. Fire-and-forget safe
 * (swallows errors) — the switcher just won't show the account if it fails.
 */
export async function rememberDeviceAccount(deviceId: string, userId: string): Promise<void> {
  if (!deviceId || !userId) return;
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = deviceAccountsKey(deviceId);
    await redis.hset(key, userId, String(Date.now()));
    // Cap the list so a device doesn't accumulate unbounded history.
    const all: Record<string, string> = await redis.hgetall(key);
    const entries = Object.entries(all).sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [uid] of entries.slice(MAX_ACCOUNTS_PER_DEVICE)) {
      await redis.hdel(key, uid);
    }
    await redis.expire(key, DEVICE_ACCOUNTS_TTL_S);
  } catch {}
}

export interface DeviceAccountInfo {
  id: string;
  name: string | null;
  email: string;
  photoUrl: string | null;
  isBlocked: boolean;
  lastUsedAt: Date | null;
}

export async function listDeviceAccounts(request: NextRequest): Promise<DeviceAccountInfo[]> {
  const deviceId = getDeviceId(request);
  if (!deviceId) return [];
  try {
    const redis = getRedis();
    if (!redis) return [];
    const all: Record<string, string> = await redis.hgetall(deviceAccountsKey(deviceId)) || {};
    const userIds = Object.keys(all);
    if (userIds.length === 0) return [];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true, username: true, status: true,
        profile: { select: { name: true, photoUrl: true } },
        emails: { where: { kind: 'primary' }, select: { address: true }, take: 1 },
      },
    });
    return users
      .map((u) => ({
        id: u.id,
        name: u.profile?.name ?? null,
        email: u.username ? tirbeoEmailFor(u.username) : (u.emails[0]?.address ?? u.id),
        photoUrl: u.profile?.photoUrl ?? null,
        isBlocked: u.status === 'suspended' || u.status === 'deleted',
        lastUsedAt: all[u.id] ? new Date(Number(all[u.id])) : null,
      }))
      .sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));
  } catch {
    return [];
  }
}

export async function removeDeviceAccount(request: NextRequest, userId: string): Promise<void> {
  const deviceId = getDeviceId(request);
  if (!deviceId) return;
  try {
    const redis = getRedis();
    if (redis) await redis.hdel(deviceAccountsKey(deviceId), userId);
    markRemoved(deviceId, userId);
  } catch {}
}

/** True when this device has previously signed into `userId`. */
export async function isKnownDeviceAccount(request: NextRequest, userId: string): Promise<boolean> {
  const deviceId = getDeviceId(request);
  if (!deviceId) return false;
  try {
    const redis = getRedis();
    if (!redis) return false;
    return !!(await redis.hget(deviceAccountsKey(deviceId), userId));
  } catch {
    return false;
  }
}
