/**
 * Email Brain — Queue Worker.
 *
 * Drains `email_jobs` (status=queued, available_at<=now), resolves the ACTIVE
 * content version for the event, renders HTML/text through the Tirbeo renderer,
 * and hands off to the existing delivery layer (`sendEmail`). Retries transient
 * failures with backoff; dead-letters after max attempts. Docs:
 * docs/email-brain/01-architecture.md §3
 */
import { prisma } from '@/infrastructure/db/prisma';
import { sendEmail } from '@/features/email/email';
import { getEventDef } from '@/features/email-brain/registry';
import { renderEmail } from '@/features/email-brain/render';
import { takeSecureVars } from '@/features/email-brain/secureVars';
import type { EmailContent } from '@/features/email-brain/ai';

const BATCH = 20;

/**
 * Send-time resolvers for security-sensitive values. Jobs never store tokens,
 * OTP codes, or security URLs. Events that use the secure store put a `secureRef`
 * (from putSecureVars) in the payload; the resolver consumes it at send time.
 * Custom per-event resolvers can be added below as more flows adopt the path.
 */
async function resolveSecureRefVars(payload: Record<string, unknown>): Promise<Record<string, string>> {
  const ref = typeof payload.secureRef === 'string' ? payload.secureRef : null;
  if (!ref) return {};
  const vars = await takeSecureVars(ref);
  return vars || {};
}

const VAR_RESOLVERS: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, string>>> = {
  'auth.password_reset': resolveSecureRefVars,
  'auth.signup': resolveSecureRefVars,
  'auth.email_verification': resolveSecureRefVars,
  'auth.account_recovery': resolveSecureRefVars,
};

/**
 * Plain-text fallback when no active definition exists for an event.
 * Security events get purpose-built fallbacks so secure values (OTP code,
 * reset URL) always render — a reset email without its link is a broken flow.
 */
function fallbackContent(eventKey: string, vars: Record<string, string>): EmailContent {
  const def = getEventDef(eventKey);

  if (eventKey === 'auth.password_reset') {
    if (vars.resetUrl) {
      return {
        subject: 'Reset your Tirbeo password',
        blocks: [
          { type: 'paragraph', text: 'Hi {{user.name}}, we received a request to reset your password.' },
          { type: 'paragraph', text: 'This link is valid for 15 minutes and can be used once.' },
          { type: 'button', label: 'Reset password', url: '{{resetUrl}}' },
          { type: 'alert', tone: 'warning', text: 'If you did not request this, you can safely ignore this email — your password will not change.' },
        ],
      };
    }
    if (vars['reset.code']) {
      return {
        subject: 'Your Tirbeo reset code',
        blocks: [
          { type: 'paragraph', text: 'Hi {{user.name}}, use this code to reset your password:' },
          { type: 'heading', text: '{{reset.code}}' },
          { type: 'paragraph', text: 'The code expires in 15 minutes.' },
          { type: 'alert', tone: 'warning', text: 'If you did not request this, you can safely ignore this email — your password will not change.' },
        ],
      };
    }
  }

  return {
    subject: def?.description || 'Tirbeo notification',
    blocks: [
      { type: 'paragraph', text: 'You have a new update in your Tirbeo account.' },
      { type: 'button', label: 'Open Tirbeo', url: '{{dashboardUrl}}' },
    ],
  };
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (w, k: string) => vars[k] ?? w);
}

/** Provider-agnostic transient error classification for retry policy. */
function isTransientError(msg: string): boolean {
  return /rate.?limit|timeout|ECONNRESET|ETIMEDOUT|fetch failed|5\d\d|temporar/i.test(msg);
}

export async function processEmailJobs(limit = BATCH): Promise<{ processed: number; sent: number; failed: number }> {
  const jobs = await prisma.email_jobs.findMany({
    where: { status: 'queued', availableAt: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }, { availableAt: 'asc' }],
    take: limit,
  });
  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    // Atomic claim: only one worker flips queued→processing.
    const claimed = await prisma.email_jobs.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    try {
      // 1. Send-time variables FIRST: payload vars + registered resolvers.
      //    Secure refs (OTP codes, reset URLs) are consumed here so content
      //    selection can depend on which secure values are present.
      let vars: Record<string, string> = { ...((job.payload as Record<string, string>) || {}) };
      const resolver = VAR_RESOLVERS[job.eventKey];
      if (resolver) {
        const resolved = await resolver((job.payload as Record<string, unknown>) || {});
        // Fail closed: events that depend on secure refs must not send with
        // expired/consumed/missing values (broken reset links).
        if (!resolved || Object.keys(resolved).length === 0) {
          throw new Error('secure vars missing or expired — refusing to send');
        }
        vars = { ...vars, ...resolved };
      }
      vars.dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app';

      // 2. Resolve ACTIVE content version (per-user language can hook in here).
      const def = await prisma.email_definitions.findFirst({
        where: { eventKey: job.eventKey, status: 'active' },
        orderBy: { updatedAt: 'desc' },
      });
      let content: EmailContent;
      let versionId: string | null = null;

      const version = def?.activeVersionId
        ? await prisma.email_versions.findUnique({ where: { id: def.activeVersionId } })
        : null;

      if (version) {
        content = { subject: version.subject, blocks: version.blocks as EmailContent['blocks'] };
        versionId = version.id;
      } else {
        content = fallbackContent(job.eventKey, vars);
      }

      const finalSubject = interpolate(content.subject, vars);
      const { html } = renderEmail(content, vars, {
        footerNote: job.category === 'security' ? 'Security notification' : undefined,
      });

      const result = await sendEmail(job.toEmail, finalSubject, html, {
        templateName: `brain:${job.eventKey}`,
        metadata: { jobId: job.id, eventKey: job.eventKey, versionId },
      });

      if (!result.success) throw new Error(result.error || 'Send failed');

      await prisma.$transaction([
        prisma.email_jobs.update({
          where: { id: job.id },
          data: { status: 'sent', processedAt: new Date() },
        }),
        prisma.email_deliveries.create({
          data: {
            jobId: job.id,
            userId: job.userId,
            toEmail: job.toEmail,
            eventKey: job.eventKey,
            category: job.category,
            subject: finalSubject,
            status: 'sent',
            provider: 'resend',
            messageId: result.messageId ?? null,
            contentVersionId: versionId,
          },
        }),
      ]);
      sent++;
    } catch (e: any) {
      const message = String(e?.message || e);
      const attempts = job.attempts + 1; // claim already incremented attempts
      const dead = attempts >= job.maxAttempts || !isTransientError(message);
      if (dead) {
        await prisma.email_jobs.update({
          where: { id: job.id },
          data: { status: 'dead', lastError: message.slice(0, 500), processedAt: new Date() },
        });
      } else {
        // Exponential backoff: 1min, 2min, 4min… capped at 15min.
        const backoffMs = Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000);
        await prisma.email_jobs.update({
          where: { id: job.id },
          data: {
            status: 'queued',
            lastError: message.slice(0, 500),
            availableAt: new Date(Date.now() + backoffMs),
          },
        });
      }
      failed++;
    }
  }
  return { processed: jobs.length, sent, failed };
}
