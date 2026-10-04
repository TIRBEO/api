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

/** The client address, not any proxy behind it in the chain. */
export function firstForwardedFor(headers: HeaderLike): string | null {
  return (headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
}

/** The browser's own request: the edge headers and the client's UA are all here. */
export function originFromRequest(headers: HeaderLike): ChangeOrigin {
  const country =
    cleanCountryCode(headers.get('x-vercel-ip-country')) ?? cleanCountryCode(headers.get('cf-ipcountry'));
  return {
    ip: firstForwardedFor(headers),
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
 */
export function originFromInternalHeaders(headers: HeaderLike): ChangeOrigin {
  return {
    ip: headers.get('x-origin-ip') || firstForwardedFor(headers),
    userAgent: headers.get('x-origin-user-agent') || null,
    location: placeFromParts(
      cleanCityName(headers.get('x-origin-city')),
      cleanCountryCode(headers.get('x-origin-country')),
    ),
    coords: coordsFromParts(headers.get('x-origin-lat'), headers.get('x-origin-lng')),
  };
}
