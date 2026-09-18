import { NextRequest } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { subscribeCdnEvents } from '@/features/media/cdnRealtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// SSE holds the connection open by design.
export const maxDuration = 3600;

/**
 * GET /api/cdn/events — Server-Sent Events stream of company CDN changes.
 *
 * Every mutation (upload, folder, rename, star, trash, restore, delete,
 * share, redeem) is pushed here the moment it happens — the app never waits
 * for a poll. Auth via the usual session cookie; the stream multiplexes all
 * company file events, and the client filters what it renders.
 *
 * NOTE: deliberately uses getSession() (not requireSession()) — no NextResponse
 * dependency (immune to the bundler ReferenceError class) and no per-connect
 * IP-blocklist DB hop, so stream (re)connects stay instant even when the
 * auth DB is slow.
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream already closed
        }
      };

      // Initial hello so the client knows the stream is live.
      send({ type: 'hello', at: Date.now(), userId: session.userId });

      unsubscribe = subscribeCdnEvents((event) => send(event));

      // Heartbeat keeps proxies from idling the connection out.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // closed
        }
      }, 25_000);

      // Clean up when the client disconnects.
      request.signal.addEventListener('abort', () => {
        if (unsubscribe) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // No buffering anywhere between the API and the browser.
      'X-Accel-Buffering': 'no',
    },
  });
}
