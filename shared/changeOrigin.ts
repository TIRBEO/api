import { clientIp } from '@/shared/client-ip';
import {
  cleanCityName,
  cleanCountryCode,
  coordsFromParts,
  placeFromParts,
} from '@/shared/geo';

type HeaderLike = { get(name: string): string | null };

/**
 * Where a request arrived from, in the columns the change ledger has for it.
 *
 * `null` on all four is a legitimate answer and is stored as one: a row with no
 * place on it says the record does not know where the change happened. Nothing
 * here guesses a city from an address, because a history page that invents one
 * teaches the owner to distrust every other line on it.
 *
 * Its own module because it is pure — the request context and the ledger writer
 * both need it, and neither should pull the other in.
 */
export type ChangeOrigin = {
  ip: string | null;
  userAgent: string | null;
  location: string | null;
  /** Latitude and longitude, when the edge resolved them — what the map on a
      change's own page is pinned from. */
  coords: [number, number] | null;
};

export const NO_ORIGIN: ChangeOrigin = { ip: null, userAgent: null, location: null, coords: null };

/**
 * The address the hop itself was taken from.
 *
 * Cloudflare names the visitor in `cf-connecting-ip`, plain proxies in
 * `x-real-ip`, and both are rewritten by the edge rather than passed through —
 * so `clientIp` asks them first and only then falls back to the
 * `x-forwarded-for` chain, which is the caller's own claim. A tunnel that
 * attaches none of them (a dev server reached on a bare address) leaves this
 * null — and null is kept: an unknown address is recorded as unknown, never as
 * whatever machine happened to relay the call.
 */
export function hopClientIp(headers: HeaderLike): string | null {
  return clientIp(headers);
}

/** The browser's own request: the edge headers and the client's UA are all here. */
export function originFromRequest(headers: HeaderLike): ChangeOrigin {
  const country =
    cleanCountryCode(headers.get('x-vercel-ip-country')) ?? cleanCountryCode(headers.get('cf-ipcountry'));
  return {
    ip: hopClientIp(headers),
    userAgent: headers.get('user-agent') || null,
    location: placeFromParts(cleanCityName(headers.get('x-vercel-ip-city')), country),
    coords: coordsFromParts(headers.get('x-vercel-ip-latitude'), headers.get('x-vercel-ip-longitude')),
  };
}

/**
 * A request that reached us through another of our own services. The headers on
 * that hop belong to that service, so the browser's facts travel as the
 * `x-origin-*` set the profile service attaches — the local hop's own values
 * would record the datacentre, not the owner's phone.
 *
 * There is deliberately no fallback to the hop's `x-forwarded-for`: on a relayed
 * call that header names the relay machine (its own edge rewrote it), which is
 * exactly the lie this function exists to avoid. A relay that could not learn
 * the visitor's address records no address.
 */
export function originFromInternalHeaders(headers: HeaderLike): ChangeOrigin {
  return {
    ip: headers.get('x-origin-ip')?.trim() || null,
    userAgent: headers.get('x-origin-user-agent') || null,
    location: placeFromParts(
      cleanCityName(headers.get('x-origin-city')),
      cleanCountryCode(headers.get('x-origin-country')),
    ),
    coords: coordsFromParts(headers.get('x-origin-lat'), headers.get('x-origin-lng')),
  };
}
