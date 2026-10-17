const WINDOW_MS = 60 * 60 * 1000;
const THRESHOLD = 3;

interface RateLimitHit {
  timestamp: number;
}

const hitHistory: Map<string, RateLimitHit[]> = (globalThis as any).__suspiciousActivity ?? new Map<string, RateLimitHit[]>();
(globalThis as any).__suspiciousActivity = hitHistory;

export function recordRateLimitHit(ip: string): void {
  if (!ip) return;
  const now = Date.now();
  if (hitHistory.size > 5000) {
    for (const [k, hits] of hitHistory) {
      if (hits.filter(h => now - h.timestamp < WINDOW_MS).length === 0) hitHistory.delete(k);
    }
  }
  const hits = hitHistory.get(ip) || [];
  const recent = hits.filter(h => now - h.timestamp < WINDOW_MS);
  recent.push({ timestamp: now });
  hitHistory.set(ip, recent);
  // Mirror the hit into the durable hourly window (best-effort). Dynamic import
  // keeps this module free of a static Prisma dependency — middleware imports
  // isSuspicious synchronously and must not pull Prisma into its bundle. A
  // missing table throws and is swallowed; the in-process Map is unaffected.
  void import('@/features/auth/db-windows')
    .then((m) => m.consumeWindow(`suspicious:${ip}`, Number.MAX_SAFE_INTEGER, WINDOW_MS))
    .catch(() => {});
}

export function isSuspicious(ip: string): boolean {
  if (!ip) return false;
  const hits = hitHistory.get(ip) || [];
  const now = Date.now();
  const recent = hits.filter(h => now - h.timestamp < WINDOW_MS);
  return recent.length >= THRESHOLD;
}

/**
 * Suspicion check that also consults the durable window when this process's
 * memory is cold (fresh instance / after a restart), so an IP that tripped the
 * limit elsewhere still requires a captcha here. Node-only callers (risk.ts)
 * use this; the edge middleware keeps the synchronous in-memory isSuspicious.
 */
export async function isSuspiciousAsync(ip: string): Promise<boolean> {
  if (!ip) return false;
  if (isSuspicious(ip)) return true;
  try {
    const { peekWindow } = await import('@/features/auth/db-windows');
    const w = await peekWindow(`suspicious:${ip}`, WINDOW_MS);
    return w.count >= THRESHOLD;
  } catch {
    return false;
  }
}

export function clearRateLimitHits(ip: string): void {
  if (!ip) return;
  hitHistory.delete(ip);
  void import('@/features/auth/db-windows')
    .then((m) => m.resetWindow(`suspicious:${ip}`))
    .catch(() => {});
}

export function shouldRequireCaptcha(ip: string): boolean {
  if (!process.env.TURNSTILE_SECRET_KEY && !process.env.TURNSTILE_SECRET) return false;
  return isSuspicious(ip);
}
