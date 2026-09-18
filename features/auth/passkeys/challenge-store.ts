// Shared in-memory challenge store for WebAuthn passkey flows.
// Short-lived (60s TTL), pruned on each access.

const challenges = new Map<string, { challenge: string; expiresAt: number }>();

export function storeChallenge(userId: string, challenge: string, ttlMs = 60000) {
  challenges.set(userId, { challenge, expiresAt: Date.now() + ttlMs });
  pruneExpired();
}

export function getAndConsumeChallenge(userId: string): string | null {
  const stored = challenges.get(userId);
  if (!stored || stored.expiresAt < Date.now()) {
    challenges.delete(userId);
    return null;
  }
  challenges.delete(userId);
  return stored.challenge;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, val] of challenges) {
    if (val.expiresAt < now) challenges.delete(key);
  }
}
