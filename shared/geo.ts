/**
 * Honest sign-in location.
 *
 * A security email that names the WRONG city is worse than one that admits it
 * does not know — it teaches the user to distrust the alert. So this never
 * invents a place from an IP: it only reports what the edge already put on the
 * request. When the app runs behind Vercel (see vercel.json) the edge forwards
 * real GeoIP results as `x-vercel-ip-*` headers; behind Cloudflare it forwards
 * `cf-ipcountry`. In local dev neither is present, and we return 'Unknown' and
 * let the IP speak for itself.
 */

type HeaderLike = { get(name: string): string | null };

// ISO 3166-1 alpha-2 codes that mean "the provider does not actually know".
// cf-ipcountry uses XX for unknown and T1 for anonymiser/Tor egress; Vercel
// sometimes forwards an empty or literal-undefined city.
const UNKNOWN_COUNTRY = new Set(['', 'XX', 'T1', 'A1', 'ZZ']);

/** An edge-supplied country code, normalised, or null when the edge was not
    confident about it. */
export function cleanCountryCode(raw: string | null): string | null {
  const code = (raw || '').trim().toUpperCase();
  return !code || UNKNOWN_COUNTRY.has(code) ? null : code;
}

/** Country code the edge is confident about, or null. Vercel wins when set. */
function isoCountryCode(headers: HeaderLike): string | null {
  return cleanCountryCode(headers.get('x-vercel-ip-country')) ?? cleanCountryCode(headers.get('cf-ipcountry'));
}

/** An edge-supplied city name, un-URL-encoded and junk-filtered. */
export function cleanCityName(raw: string | null): string | null {
  if (!raw) return null;
  let city = raw;
  try {
    city = decodeURIComponent(raw);
  } catch {
    city = raw;
  }
  city = city.trim();
  if (!city || city.toLowerCase() === 'undefined' || city.toLowerCase() === 'null') return null;
  return city;
}

/** URL-encoded city from the Vercel edge, or null if absent / junk. */
function cityName(headers: HeaderLike): string | null {
  return cleanCityName(headers.get('x-vercel-ip-city'));
}

/**
 * Map an ISO country code to an English name via Intl (Node ships full ICU:
 * 'NP' -> 'Nepal'). Falls back to the raw code if Intl is trimmed down, so we
 * still show real data rather than nothing — never a made-up name.
 */
export function countryDisplayName(code: string | null): string | null {
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return name || code;
  } catch {
    return code;
  }
}

/**
 * What the two edge facts add up to: 'Kathmandu, Nepal', one of the two, or
 * null when neither is real. Split out because a request that arrived through
 * another service has to hand the facts over one at a time — the headers on
 * that hop belong to the service, not to the browser.
 */
export function placeFromParts(city: string | null, countryCode: string | null): string | null {
  const country = countryDisplayName(countryCode);
  if (city && country) return `${city}, ${country}`;
  return country ?? city;
}

/**
 * The place the edge said this request came from, or null when it said
 * nothing. For a record that should stay empty rather than store the word
 * "Unknown" as if it were a city.
 */
export function resolveLoginPlace(headers: HeaderLike): string | null {
  return placeFromParts(cityName(headers), isoCountryCode(headers));
}

/** Coordinates only when the numbers are actually numbers, and actually a
    point on Earth. A map pinned at (0,0) — what an empty header parses to —
    would put every unknown address in the Atlantic. */
export function coordsFromParts(lat: string | null, lng: string | null): [number, number] | null {
  const north = numberOrNull(lat);
  const east = numberOrNull(lng);
  if (north === null || east === null) return null;
  if (north < -90 || north > 90 || east < -180 || east > 180) return null;
  return [north, east];
}

function numberOrNull(raw: string | null): number | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The coordinates the edge resolved this address to, or null. Vercel sends a
 * latitude and longitude beside the city; Cloudflare sends a country and
 * nothing else, so behind it there is no pin to draw — only words.
 */
export function resolveLoginCoords(headers: HeaderLike): [number, number] | null {
  return coordsFromParts(headers.get('x-vercel-ip-latitude'), headers.get('x-vercel-ip-longitude'));
}

/**
 * Human-readable location for a security email. Always returns a non-empty
 * string; 'Unknown' is the honest default when the edge gave us nothing real.
 */
export function resolveLoginLocation(headers: HeaderLike): string {
  return resolveLoginPlace(headers) ?? 'Unknown';
}
