/**
 * Email Brain — User-facing email preferences handler.
 *
 * GET  /emails/preferences → registry events + user's per-event frequency
 * POST /emails/preferences → upsert frequency for one event
 *
 * Mandatory (security) events are not settable — the UI shows them as
 * "Required" and the API rejects changes (defense in depth: the decision
 * engine ignores preferences for mandatory events anyway).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireSession } from '@/features/auth/http-guards';
import { EMAIL_EVENTS } from '@/features/email-brain/registry';

const OK = (data: unknown, status = 200) => NextResponse.json(data, { status });

const VALID_FREQUENCIES = ['immediate', 'daily', 'weekly', 'monthly', 'never'];

export async function emailPreferencesHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const userId = session.userId;

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const eventKey = (body as any)?.eventKey;
    const frequency = (body as any)?.frequency;

    if (!eventKey || !VALID_FREQUENCIES.includes(frequency)) {
      return OK({ error: 'eventKey and a valid frequency are required' }, 400);
    }
    const def = EMAIL_EVENTS.find((e) => e.eventKey === eventKey);
    if (!def) return OK({ error: 'Unknown event' }, 404);
    if (def.mandatory) {
      return OK({ error: 'This communication is required and cannot be changed' }, 403);
    }

    await prisma.email_preferences.upsert({
      where: { userId_eventKey: { userId, eventKey } },
      create: { userId, eventKey, frequency },
      update: { frequency },
    });
    return OK({ ok: true, eventKey, frequency });
  }

  // GET — full preference surface for the dashboard.
  const overrides = await prisma.email_preferences.findMany({ where: { userId } });
  const overrideMap = new Map(overrides.map((o) => [o.eventKey, o.frequency]));

  return OK({
    preferences: EMAIL_EVENTS.filter((e) => !e.mandatory).map((e) => ({
      eventKey: e.eventKey,
      category: e.category,
      description: e.description,
      delivery: e.delivery,
      frequency: overrideMap.get(e.eventKey) || 'default',
    })),
    mandatory: EMAIL_EVENTS.filter((e) => e.mandatory).map((e) => ({
      eventKey: e.eventKey,
      category: e.category,
      description: e.description,
    })),
  });
}
