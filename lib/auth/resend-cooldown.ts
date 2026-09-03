const cooldowns = new Map<string, number>();
const attempts = new Map<string, { count: number; windowStart: number }>();
const DEFAULT_COOLDOWN_MS = 30_000; // 30s between resends
const MAX_ATTEMPTS_PER_WINDOW = 5; // max 5 sends per window
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minute window

/**
 * Enforce cooldown between resend attempts.
 * Now ENABLED — prevents spam.
 */
const ENABLE_RESEND_COOLDOWN = true;

export function enforceResendCooldown(
  key: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): { allowed: boolean; remainingMs: number } {
  if (!ENABLE_RESEND_COOLDOWN) {
    return { allowed: true, remainingMs: 0 };
  }

  const now = Date.now();

  // Check cooldown (60s between sends)
  const last = cooldowns.get(key);
  if (last && now - last < cooldownMs) {
    return { allowed: false, remainingMs: cooldownMs - (now - last) };
  }

  // Check max attempts per window (5 per 15min)
  const entry = attempts.get(key);
  if (entry && now - entry.windowStart < ATTEMPT_WINDOW_MS) {
    if (entry.count >= MAX_ATTEMPTS_PER_WINDOW) {
      const remainingMs = ATTEMPT_WINDOW_MS - (now - entry.windowStart);
      return { allowed: false, remainingMs };
    }
    entry.count++;
  } else {
    attempts.set(key, { count: 1, windowStart: now });
  }

  cooldowns.set(key, now);
  return { allowed: true, remainingMs: 0 };
}

/**
 * Get remaining attempts for a key (for display on frontend).
 */
export function getRemainingAttempts(key: string): { remaining: number; resetsInMs: number } {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.windowStart >= ATTEMPT_WINDOW_MS) {
    return { remaining: MAX_ATTEMPTS_PER_WINDOW, resetsInMs: 0 };
  }
  return {
    remaining: Math.max(0, MAX_ATTEMPTS_PER_WINDOW - entry.count),
    resetsInMs: ATTEMPT_WINDOW_MS - (Date.now() - entry.windowStart),
  };
}
