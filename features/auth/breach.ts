const HIBP_PREFIX_ENDPOINT = 'https://api.pwnedpasswords.com/range/';

export interface BreachResult {
  breached: boolean;
  count: number;
}

function sha1Hex(data: string): string {
  const nodeCrypto = require('crypto');
  return nodeCrypto.createHash('sha1').update(data).digest('hex').toUpperCase();
}

export async function checkPasswordBreach(password: string): Promise<BreachResult> {
  if (!password) return { breached: false, count: 0 };
  const hash = sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  try {
    const res = await fetch(`${HIBP_PREFIX_ENDPOINT}${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Network failure is non-blocking — don't fail password validation on HIBP outage.
      return { breached: false, count: 0 };
    }
    const body = await res.text();
    const suffixes = body
      .split('\r\n')
      .map((line) => line.split(':')[0])
      .filter(Boolean);

    const idx = suffixes.indexOf(suffix);
    if (idx === -1) return { breached: false, count: 0 };

    const matchLine = body.split('\r\n')[idx];
    const count = parseInt(matchLine.split(':')[1] || '0', 10);
    return { breached: true, count: Number.isNaN(count) ? 1 : count };
  } catch {
    return { breached: false, count: 0 };
  }
}
