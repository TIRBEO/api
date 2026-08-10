const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

export async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;

  try {
    const formData = new FormData();
    formData.append('secret', TURNSTILE_SECRET);
    formData.append('response', token);
    if (ip) formData.append('remoteip', ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const data: any = await res.json();
    return data.success === true;
  } catch (err: any) {
    console.error('[TURNSTILE] Verification error:', err?.message);
    return false;
  }
}

export function getTurnstileSiteKey(): string {
  return TURNSTILE_SITE_KEY;
}

export function isTurnstileConfigured(): boolean {
  return !!TURNSTILE_SECRET;
}
