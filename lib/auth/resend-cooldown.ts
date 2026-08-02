const cooldowns = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 60_000;

export function enforceResendCooldown(
  key: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): { allowed: boolean; remainingMs: number } {
  const now = Date.now();
  const last = cooldowns.get(key);
  if (last && now - last < cooldownMs) {
    return { allowed: false, remainingMs: cooldownMs - (now - last) };
  }
  cooldowns.set(key, now);
  return { allowed: true, remainingMs: 0 };
}
