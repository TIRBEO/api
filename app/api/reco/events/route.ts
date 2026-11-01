import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/features/auth/http-guards';
import { enqueueWork } from '@/shared/queue-client';

/* POST /api/reco/events — browser-side recommendation signals (PRD §7.2),
   session-bound and queued, never written inline: impressions arrive in bursts
   and the recommendations consumer decides what is a meaningful signal. */

export const runtime = 'nodejs';

const eventSchema = z.object({
  type: z.enum([
    'post.impression', 'post.opened', 'post.liked', 'post.shared', 'post.saved', 'post.hidden',
    'reel.impression', 'reel.started', 'reel.completed', 'reel.skipped', 'reel.liked',
    'user.followed', 'user.unfollowed', 'community.joined', 'community.left',
    'recommendation.not_interested', 'recommendation.feedback',
  ]),
  contentId: z.string().max(120).optional(),
  contentType: z.enum(['post', 'reel', 'story', 'user', 'community']).optional(),
  sourceFeed: z.string().max(40).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(50) });

export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = batchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid batch' }, { status: 400 });

  let queued = 0;
  for (const ev of parsed.data.events) {
    const ok = await enqueueWork('reco', ev.type, { userId: session.userId, ...ev, clientTs: Date.now() });
    if (ok) queued++;
  }
  // Queues off/unreachable → still accept silently: losing analytics must
  // never fail the user's screen.
  return NextResponse.json({ accepted: parsed.data.events.length, queued });
}
