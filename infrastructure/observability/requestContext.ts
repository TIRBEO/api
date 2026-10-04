import { AsyncLocalStorage } from 'node:async_hooks';
import { originFromRequest, type ChangeOrigin } from '@/shared/changeOrigin';

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

export function withRequestOrigin<T>(headers: HeaderLike, run: () => Promise<T>): Promise<T> {
  return store.run(originFromRequest(headers), run);
}

/** The origin of the request we are inside, or null for a write with no request. */
export function currentRequestOrigin(): ChangeOrigin | null {
  return store.getStore() ?? null;
}
