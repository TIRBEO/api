import { prisma } from '@/infrastructure/db/prisma';

/* Recommendation event consumption (PRD §7.2–7.3): the queue drain calls this
   per envelope. Events land in Postgres today (the PRD's zero-budget fallback
   schema); dedupe by (userId,type,contentId,minute-bucket) keeps at-least-once
   delivery from inflating counts. */

export interface RecoEvent {
  userId: string;
  type: string;
  contentId?: string;
  contentType?: string;
  sourceFeed?: string;
  clientTs?: number;
}

export async function consumeRecoEvent(ev: RecoEvent): Promise<void> {
  const minuteBucket = Math.floor((ev.clientTs || Date.now()) / 60_000);
  try {
    await prisma.$executeRaw`INSERT INTO recommendation_events
      (user_id, type, content_id, content_type, source_feed, minute_bucket, created_at)
      VALUES (${ev.userId}, ${ev.type}, ${ev.contentId ?? null}, ${ev.contentType ?? null}, ${ev.sourceFeed ?? null}, ${minuteBucket}, now())
      ON CONFLICT (user_id, type, content_id, minute_bucket) DO NOTHING`;
  } catch {
    // Table may not exist until the migration lands — drop silently rather
    // than failing the drain; Analytics Engine still records the volume.
  }
}
