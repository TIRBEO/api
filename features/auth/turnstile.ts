/**
 * Cloudflare Turnstile verification.
 *
 * ── Env is read per call, not at module load ───────────────────────────────
 * The previous version captured `process.env` in top-level constants. On
 * serverless that snapshot is taken when the function is cold-started, so a
 * key added to the host after a deploy stayed invisible until the next cold
 * start — and on a long-lived instance it was invisible forever. Reading per
 * call makes the config request-time correct.
 *
 * `TURNSTILE_SITE_KEY` (non-public) is preferred over the `NEXT_PUBLIC_`
 * variant: the public name is inlined into client bundles at build time, so it
 * can be stale or empty even when the running secret is correct.
 *
 * ── Enforcing requires BOTH keys ───────────────────────────────────────────
 * Verifying with no way for a client to obtain a site key hard-locks
 * authentication: every login comes back 403 and nobody can sign in.
 * `isTurnstileConfigured()` therefore requires the site key too, and logs loudly
 * when it is half-configured.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Never let a slow Cloudflare endpoint stall an auth request. */
const VERIFY_TIMEOUT_MS = 5_000;

function secret(): string {
  return process.env.TURNSTILE_SECRET_KEY || '';
}

/** Public site key to hand to the browser. Empty string when unavailable. */
export function getTurnstileSiteKey(): string {
  return process.env.TURNSTILE_SITE_KEY || process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';
}

const warned = new Set<string>();

/** Log a misconfiguration once per process instead of once per request. */
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.error(`[TURNSTILE] ${msg}`);
}

export async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secretKey = secret();

  // Nothing configured: allow, so local dev / preview builds work. In
  // production this is surfaced as a loud error rather than a silent bypass.
  if (!secretKey) {
    if (process.env.NODE_ENV === 'production') {
      warnOnce('Server secret not configured — CAPTCHA cannot be enforced.');
      return false;
    }
    return true;
  }

  // Secret but no site key → clients can never produce a token. Fail open so a
  // half-configured deploy degrades to "no captcha" instead of locking everyone
  // out of the API.
  if (!getTurnstileSiteKey()) {
    warnOnce(
      'TURNSTILE_SITE_KEY is missing — CAPTCHA enforcement is OFF. ' +
        'Set it, otherwise clients cannot obtain a site key and login/signup 403 forever.',
    );
    return true;
  }

  if (!token) return false;

  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (ip && ip !== 'unknown') formData.append('remoteip', ip);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });

    const data = (await res.json()) as {
      success?: boolean;
      'error-codes'?: string[];
      hostname?: string;
    };
    if (data.success !== true) {
      // Surface WHY — an un-whitelisted domain (`invalid-domain`) and a
      // double-submitted token (`timeout-or-duplicate`) need very different
      // fixes, and "captcha failed" tells you neither.
      console.error(
        `[TURNSTILE] rejected token: ${data['error-codes']?.join(', ') || 'no reason given'}` +
          (data.hostname ? ` (hostname: ${data.hostname})` : ''),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error('[TURNSTILE] Verification error:', (err as Error)?.message);
    return false;
  }
}

/**
 * Whether the captcha gate should run at all. Requires BOTH keys so the gate
 * never rejects a request no client could satisfy.
 */
export function isTurnstileConfigured(): boolean {
  return Boolean(secret()) && Boolean(getTurnstileSiteKey());
}
