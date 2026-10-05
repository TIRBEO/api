import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import {
  originFromInternalHeaders,
  originFromRequest,
  type ChangeOrigin,
} from '@/shared/changeOrigin';

type HeaderLike = { get(name: string): string | null };

/**
 * The request a write happened inside of.
 *
 * Every change row wants the machine, address and place it came from, and the
 * route that writes it is often three calls deep from the handler that holds the
 * request. Passing `request` down through each of those calls is fifty signatures
 * of noise, and the fifty-first writer quietly forgets — which is how a history
 * page ends up with rows that say a field changed and nothing else.
 *
 * So the origin is put on the async chain once, at the door, and picked up where
 * a row is written. A writer that names its own origin wins over this; a write
 * from a background job, where there is no request at all, gets nothing rather
 * than the address of whatever process happened to run first.
 */
const store = new AsyncLocalStorage<ChangeOrigin>();

/**
 * Whose facts a request may carry inside it.
 *
 * A browser's own request already holds its address and edge-resolved place —
 * the edge put them there. A request that reached us through another
 * first-party service cannot: Vercel overwrites `x-vercel-*` on every hop, so
 * the relay attaches the browser's facts as the `x-origin-*` set beside the
 * shared service token. Anyone can send `x-origin-*`; only a caller holding
 * the token gets believed.
 */
function trustedInternalCaller(headers: HeaderLike): boolean {
  const expected = process.env.INTERNAL_API_SECRET || '';
  const supplied = headers.get('x-internal-token') || '';
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function withRequestOrigin<T>(headers: HeaderLike, run: () => Promise<T>): Promise<T> {
  return store.run(
    trustedInternalCaller(headers) ? originFromInternalHeaders(headers) : originFromRequest(headers),
    run,
  );
}

/** The origin of the request we are inside, or null for a write with no request. */
export function currentRequestOrigin(): ChangeOrigin | null {
  return store.getStore() ?? null;
}
