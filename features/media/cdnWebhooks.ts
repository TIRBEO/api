import { createHmac, randomUUID } from 'node:crypto';
import { prisma } from '@/infrastructure/db/prisma';

/** PRD §48–50, §98: webhook delivery with HMAC signatures, retry, SSRF guard. */

export const WEBHOOK_EVENTS = new Set([
  'file.uploaded', 'file.updated', 'file.deleted',
  'upload.started', 'upload.completed', 'upload.failed',
  'domain.created', 'domain.verified', 'domain.active', 'domain.failed',
  'image.processed', 'virus_scan.completed',
]);

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // Literal IPv4
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 0)) return true;
    return false;
  }
  // Literal IPv6
  if (h.includes(':')) {
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  }
  return false;
}

/** SSRF guard: https/http only, no credentials, no private/local targets. */
export function validateWebhookUrl(raw: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only https/http URLs allowed.' };
  if (u.username || u.password) return { ok: false, reason: 'Credentials in URL are not allowed.' };
  if (isPrivateHostname(u.hostname)) return { ok: false, reason: 'Internal/private targets are blocked.' };
  if (u.port && !['80', '443'].includes(u.port) && !(u.protocol === 'http:' && u.port === '80') && !(u.protocol === 'https:' && u.port === '443')) {
    // Non-standard ports allowed only on public hosts — keep permissive here.
  }
  return { ok: true };
}

export function signWebhook(secret: string, event: string, body: string): string {
  return createHmac('sha256', secret).update(`${event}.${body}`).digest('hex');
}

export function newWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, '')}`;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function deliverWebhook(webhookId: string, event: string, payload: unknown): Promise<void> {
  const hook = await (prisma as any).cdnWebhook.findUnique({ where: { id: webhookId } }).catch(() => null);
  if (!hook || hook.status === 'disabled') return;
  const body = JSON.stringify({ event, ...((payload ?? {}) as Record<string, unknown>) });
  const delivery = await (prisma as any).cdnWebhookDelivery.create({
    data: { webhookId, event, status: 'retrying', attempts: 0 },
  }).catch(() => null);
  const secret = hook.secret || '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tirbeo-Event': event,
        'X-Tirbeo-Delivery': delivery?.id || 'local',
        'X-Tirbeo-Signature': secret ? signWebhook(secret, event, body) : '',
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const ok2xx = res.status >= 200 && res.status < 300;
    await (prisma as any).cdnWebhookDelivery.update({
      where: { id: delivery?.id },
      data: {
        status: ok2xx ? 'success' : RETRYABLE.has(res.status) ? 'retrying' : 'failed',
        attempts: 1,
        lastStatus: res.status,
        nextRetry: !ok2xx && RETRYABLE.has(res.status) ? new Date(Date.now() + 60_000) : null,
      },
    }).catch(() => {});
  } catch {
    await (prisma as any).cdnWebhookDelivery.update({
      where: { id: delivery?.id },
      data: { status: 'retrying', attempts: 1, nextRetry: new Date(Date.now() + 60_000) },
    }).catch(() => {});
  }
}

/** Fan-out an event to every active webhook subscribed to it (fire-and-forget). */
export function emitCdnEvent(event: string, payload: unknown): void {
  if (!WEBHOOK_EVENTS.has(event)) return;
  void (async () => {
    try {
      const hooks = await (prisma as any).cdnWebhook.findMany({ where: { status: 'active' } }).catch(() => []);
      for (const h of hooks) {
        const events: string[] = Array.isArray(h.events) ? h.events : [];
        if (events.includes(event)) void deliverWebhook(h.id, event, payload);
      }
    } catch { /* never break the request path */ }
  })();
}
