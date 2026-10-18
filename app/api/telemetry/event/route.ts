import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { checkRateLimit } from '@/features/auth/rate-limit';
import { analyticsConsentAllowed, isAnalyticsCategoryEvent, stripClientConsentFields } from '@/features/preferences/dataUsage';
import { getClientIp, getUserAgent, humanizeEventType } from '@/features/security/security';

export const runtime = 'nodejs';

// Control characters (C0/C1 + DEL) never belong in a telemetry label.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const METADATA_MAX_BYTES = 4 * 1024;

interface TelemetryBody {
  eventId?: unknown;
  kind?: unknown;
  detail?: unknown;
  metadata?: unknown;
}

/**
 * Public client-telemetry ingest — POST /api/telemetry/event.
 *
 * Browser-side events (pre-account signup friction, widget errors, etc.) land
 * in activity_events with a queryable id, so the same admin event list shows
 * what the server AND the client saw. Anonymous when no session cookie is
 * present; attributed to the signed-in user when there is one.
 *
 * Deliberately forgiving: bad-but-parseable payloads are dropped field by
 * field rather than rejected, and ANY internal failure answers 200 { ok: false }
 * — telemetry must never leak internals or break the client that sent it.
 *
 * Analytics/cookie-dependent event categories are gated on the ACCOUNT's
 * stored `analyticsCookies` consent (features/preferences/dataUsage.ts) — never
 * on anything the request claims. Operational events and accounts that never
 * answered are unaffected.
 */
export async function POST(request: NextRequest) {
  try {
    // ── Rate limit per client IP ──
    const ip = getClientIp(request);
    const rateOk = await checkRateLimit(`telemetry:${ip}`, false);
    if (!rateOk) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    // ── Validate manually (same checks the codebase's zod schemas enforce,
    //    but errors here would punish a fire-and-forget beacon) ──
    let body: TelemetryBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    if (!eventId || eventId.length > 64) {
      return NextResponse.json({ error: 'eventId required (1-64 chars)' }, { status: 400 });
    }

    const rawKind = typeof body.kind === 'string' ? body.kind.replace(CONTROL_CHARS, '').trim() : '';
    if (!rawKind || rawKind.length > 80) {
      return NextResponse.json({ error: 'kind required (1-80 chars)' }, { status: 400 });
    }

    const detail =
      typeof body.detail === 'string'
        ? body.detail.replace(CONTROL_CHARS, '').slice(0, 500) || null
        : null;

    // metadata must be a plain JSON object and fit 4KB; oversized or
    // non-object values are dropped rather than rejected.
    let metadata: Record<string, unknown> = {};
    if (
      body.metadata &&
      typeof body.metadata === 'object' &&
      !Array.isArray(body.metadata)
    ) {
      try {
        const serialized = JSON.stringify(body.metadata);
        if (serialized && serialized.length <= METADATA_MAX_BYTES) {
          metadata = JSON.parse(serialized) as Record<string, unknown>;
        }
      } catch {
        /* unserializable → drop */
      }
    }
    // The consent answers are the account's, read from the account below. A
    // client posting its own `consent` field would be writing a fake answer
    // into the ledger admins read, so those keys never get stored.
    metadata = stripClientConsentFields(metadata);

    // ── Attribute to the signed-in user when a session cookie is present ──
    // Same resolution path as every authenticated API route (getSession reads
    // the cookie JWT, falls back to a Bearer token). Null when anonymous.
    let userId: string | null = null;
    try {
      const session = await getSession(request);
      userId = session?.userId ?? null;
    } catch {
      userId = null;
    }

    // ── Consent gate (server-side, authoritative) ──
    // Analytics/cookie-dependent categories are dropped for accounts that
    // turned analytics cookies OFF. Anonymous events and accounts that never
    // answered keep flowing — an absent consent is not a refusal, and a
    // classifier or DB problem must not silently kill production telemetry.
    if (isAnalyticsCategoryEvent(rawKind) && !(await analyticsConsentAllowed(userId))) {
      return NextResponse.json({ ok: true, id: null, stored: false, reason: 'consent' });
    }

    const row = await prisma.activityEvent.create({
      data: {
        userId,
        kind: rawKind,
        title: humanizeEventType(rawKind),
        detail,
        severity: 'info',
        ipAddress: ip,
        userAgent: getUserAgent(request),
        metadata: {
          ...metadata,
          clientEventId: eventId,
          source: 'client',
        },
      },
      select: { id: true },
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    // Never fail the client, never leak the cause.
    console.error('[TELEMETRY] ingest failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false });
  }
}
