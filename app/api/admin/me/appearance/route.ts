import { NextRequest } from 'next/server';
import { getAppearance, patchAppearance } from '@/features/admin/preferences';

/* /api/admin/me/appearance — the operator's own view of the console.
 *
 *   GET   → { appearance: { theme, density, pageSize } }
 *   PATCH → the same, with whatever was sent merged over it.
 *
 * Not behind a permission key: it reads and writes one row of the person asking,
 * and an operator who cannot open a screen does not need a screen that changes
 * how a screen they cannot see is laid out.
 *
 * The CSRF double-submit the shared guard requires is still enforced — this is a
 * write from a cookie-authed context like every other one, and "it only changes
 * somebody's font size" is how a form gets left open to a cross-site POST. */

export async function GET(request: NextRequest) {
  return getAppearance(request);
}

export async function PATCH(request: NextRequest) {
  return patchAppearance(request);
}
