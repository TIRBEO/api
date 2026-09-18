import { createHmac, timingSafeEqual } from 'node:crypto';

// ═══ Signed URL helpers — private file delivery (PRD §17–18, §63) ═══
// Signatures are bound to the FILE ID (not the path) so a signed URL keeps
// working across moves/renames — the delivery endpoint resolves the path to
// an id first, then verifies id:expires. Signing uses only the fileId and
// expiry (no userId) because private delivery is unauthenticated.

const SIG_SECRET = () => process.env.CDN_SIGNING_SECRET || process.env.SESSION_SECRET || 'tirbeo-dev-signing-secret';

/** Constant-time signature check. Accepts the full sig or a truncated one. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}

/** Compute the HMAC signature for a file delivery URL. */
export function signCdnUrl(fileId: string, expiresAtMs: number): string {
  return createHmac('sha256', SIG_SECRET())
    .update(`${fileId}:${Math.floor(expiresAtMs)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Verify `expires` + `sig` query params against a file id, in constant time.
 * Returns true only for a matching, unexpired signature.
 */
export function verifyCdnSignature(fileId: string, expires: string | null, sig: string | null): boolean {
  if (!expires || !sig) return false;
  const expiresMs = Number(expires);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return false;
  const expected = signCdnUrl(fileId, expiresMs);
  return sig.length === expected.length && safeEqual(sig, expected);
}

/** Build the query string suffix for a signed URL from a file's public path. */
export function buildSignedUrlParams(fileId: string, expiresAtMs: number, opts?: { download?: boolean; filename?: string }): URLSearchParams {
  const params = new URLSearchParams({
    expires: String(Math.floor(expiresAtMs)),
    sig: signCdnUrl(fileId, expiresAtMs),
  });
  if (opts?.download) {
    params.set('download', '1');
    if (opts.filename) params.set('filename', opts.filename);
  }
  return params;
}