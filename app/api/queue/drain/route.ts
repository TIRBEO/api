import { NextRequest, NextResponse } from 'next/server';
import { verifyEnvelope } from '@/shared/queue-envelope';

/* POST /api/queue/drain — the Cloudflare Queue consumer (apps/jobs) delivers
   signed envelopes here, one message per request. Dispatch:
     job    → runSingleJobIfDue (job_runs gate keeps repeats cheap)
     mail   → sendTemplateEmail with the original template/options
     notify → deliverQueuedNotification (re-reads the row; WS/push/email fan-out)
   At-least-once delivery: handlers are idempotent by construction. Auth is the
   envelope HMAC itself (5-minute window), so no bearer secret travels. */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // The worker may batch up to 10 messages in one POST (Queues batching).
  const envelopes: unknown[] = Array.isArray(body?.batch) ? body.batch : [body];

  const results: Array<{ kind: string; action: string; ok: boolean; note?: string }> = [];
  for (const raw of envelopes) {
    const env = await verifyEnvelope(raw as any);
    if (!env) {
      results.push({ kind: '?', action: '?', ok: false, note: 'bad-signature' });
      continue;
    }
    try {
      if (env.kind === 'job') {
        const { runSingleJobIfDue } = await import('@/jobs/job-gate');
        const r = await runSingleJobIfDue(env.action as any);
        results.push({ kind: env.kind, action: env.action, ok: true, note: r.ran ? 'ran' : 'not-due' });
      } else if (env.kind === 'mail') {
        const p = env.payload as { to?: string; templateName?: string; variables?: Record<string, string>; options?: Record<string, unknown> };
        if (!p?.to || !p?.templateName) throw new Error('mail payload incomplete');
        const { sendTemplateEmail } = await import('@/features/email/email');
        await sendTemplateEmail(p.to, p.templateName, p.variables ?? {}, p.options as any);
        results.push({ kind: env.kind, action: env.action, ok: true });
      } else if (env.kind === 'notify') {
        const p = env.payload as { notificationId?: string };
        if (!p?.notificationId) throw new Error('notify payload incomplete');
        const { deliverQueuedNotification } = await import('@/features/notifications/queue-delivery');
        await deliverQueuedNotification(p.notificationId);
        results.push({ kind: env.kind, action: env.action, ok: true });
      } else if (env.kind === 'reco') {
        const p = env.payload as any;
        if (!p?.userId) throw new Error('reco payload incomplete');
        const { consumeRecoEvent } = await import('@/features/recommendations/consume');
        await consumeRecoEvent(p);
        results.push({ kind: env.kind, action: env.action, ok: true });
      } else if (env.kind === 'email') {
        const p = env.payload as { to?: string; subject?: string; html?: string; options?: Record<string, unknown> };
        if (!p?.to || !p?.subject) throw new Error('email payload incomplete');
        const { sendEmail } = await import('@/features/email/email');
        await sendEmail(p.to, p.subject, p.html ?? '', (p.options ?? {}) as any);
        results.push({ kind: env.kind, action: env.action, ok: true });
      } else {
        results.push({ kind: env.kind, action: env.action, ok: false, note: 'unknown-kind' });
      }
    } catch (err: any) {
      console.error(`[QUEUE] ${env.kind}:${env.action} failed:`, err?.message || err);
      results.push({ kind: env.kind, action: env.action, ok: false, note: 'handler-error' });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({ ok: failed === 0, results }, { status: failed ? 207 : 200 });
}
