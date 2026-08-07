const WINDOW_MS = 60 * 60 * 1000;
const THRESHOLD = 3;

interface RateLimitHit {
  timestamp: number;
}

const hitHistory = (globalThis as any).__suspiciousActivity ?? new Map<string, RateLimitHit[]>();
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
}

export function isSuspicious(ip: string): boolean {
  if (!ip) return false;
  const hits = hitHistory.get(ip) || [];
  const now = Date.now();
  const recent = hits.filter(h => now - h.timestamp < WINDOW_MS);
  return recent.length >= THRESHOLD;
}

export function shouldRequireCaptcha(ip: string): boolean {
  if (!process.env.TURNSTILE_SECRET_KEY && !process.env.TURNSTILE_SECRET) return false;
  return isSuspicious(ip);
}
