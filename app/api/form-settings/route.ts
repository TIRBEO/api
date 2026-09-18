import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { getSessionFromRequest } from '@/features/auth/session';

/**
 * /api/form-settings — per-user default form settings for the forms app.
 *
 * The User model has no dedicated settings column; these defaults live in the
 * existing `notificationPreferences` JSON (formSettings key) to avoid a new
 * table for low-frequency configuration data. Values are validated and a
 * whitelist of known keys is applied so arbitrary JSON cannot be persisted.
 */

const STRING_KEYS = [
  'defaultVisibility', 'defaultPrimaryColor', 'defaultBackgroundColor',
  'defaultSurfaceColor', 'defaultTextColor', 'defaultMutedTextColor',
  'defaultBorderColor', 'defaultHeadingFont', 'defaultBodyFont',
  'defaultBorderRadius', 'defaultPadding', 'defaultMaxWidth',
  'defaultButtonStyle', 'defaultSubmitButtonText',
] as const;

const BOOL_KEYS = ['defaultButtonFullWidth', 'defaultShowProgressBar', 'defaultAllowMultiple'] as const;

const VALID_KEYS = new Set<string>([...STRING_KEYS, ...BOOL_KEYS]);

function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of STRING_KEYS) {
    if (typeof input[k] === 'string') out[k] = (input[k] as string).slice(0, 200);
  }
  for (const k of BOOL_KEYS) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  return out;
}

function mergeIntoPrefs(prefs: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = (prefs && typeof prefs === 'object' ? { ...(prefs as Record<string, unknown>) } : {});
  base.formSettings = patch;
  return base as Prisma.InputJsonValue;
}

// GET /api/form-settings — current user's defaults (or {})
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { notificationPreferences: true },
    });
    const prefs = user?.notificationPreferences;
    const settings = prefs && typeof prefs === 'object' && !Array.isArray(prefs)
      ? (prefs as Record<string, unknown>).formSettings ?? {}
      : {};
    return NextResponse.json(settings);
  } catch (error: any) {
    console.error('[FORM-SETTINGS] GET error:', error?.message);
    return NextResponse.json({ error: 'Failed to load form settings' }, { status: 500 });
  }
}

// PATCH /api/form-settings — update a subset of defaults
export async function PATCH(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
    }
    const patch = sanitize(body as Record<string, unknown>);
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid settings keys provided' }, { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { notificationPreferences: true },
    });
    const updated = mergeIntoPrefs(user?.notificationPreferences, patch);
    await prisma.user.update({
      where: { id: session.userId },
      data: { notificationPreferences: updated },
    });
    return NextResponse.json({ ok: true, ...patch });
  } catch (error: any) {
    console.error('[FORM-SETTINGS] PATCH error:', error?.message);
    return NextResponse.json({ error: 'Failed to save form settings' }, { status: 500 });
  }
}
