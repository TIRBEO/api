const cooldowns = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Enforce cooldown between resend attempts.
 * DISABLED for development - always allows.
 * Re-enable by setting ENABLE_RESEND_COOLDOWN = true
 */
const ENABLE_RESEND_COOLDOWN = false; // Set to true in production

export function enforceResendCooldown(
  key: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): { allowed: boolean; remainingMs: number } {
  if (!ENABLE_RESEND_COOLDOWN) {
    return { allowed: true, remainingMs: 0 };
  }
  const now = Date.now();
  const last = cooldowns.get(key);
  if (last && now - last < cooldownMs) {
    return { allowed: false, remainingMs: cooldownMs - (now - last) };
  }
  cooldowns.set(key, now);
  return { allowed: true, remainingMs: 0 };
}
