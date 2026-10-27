/* Whose address is this request?

   Everything that limits, blocks or records a caller keys off this answer, so a
   value the caller can type is a value the caller can escape. `x-forwarded-for`
   is exactly that: a browser may send any list of addresses it likes, and an
   edge that *appends* to the header rather than replacing it leaves the forged
   entry first in line. Reading `[0]` therefore meant one fresh fake address per
   request reset every IP-keyed control — the 5/minute on the sign-in routes, the
   30/minute edge budget, the `global:ip` send windows, the suspicious-address
   captcha, and the attribution on the security log.

   So the header named *by the edge itself* comes first: Cloudflare rewrites
   `cf-connecting-ip` to the TCP peer and drops an inbound one, and our own proxy
   layers set `x-real-ip` the same way. Only when neither is present — a dev
   server reached on a bare address, a tunnel, a test — does the request fall
   back to the chain the client supplied, which is the best remaining guess and
   comes with the address it was taken from in the name. */

type HeaderLike = { get(name: string): string | null };

/** The address the caller arrived from, or `null` when the hop named none. */
export function clientIp(headers: HeaderLike): string | null {
  const fromEdge =
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-real-ip')?.trim();
  if (fromEdge) return fromEdge;

  const chain = headers.get('x-forwarded-for') || headers.get('x-vercel-forwarded-for') || '';
  return chain.split(',')[0]?.trim() || null;
}

/** The same answer for a caller that needs a string to key a bucket with. In
    production an edge always names the visitor, so reaching for this placeholder
    means the hop genuinely did not: the nameless callers then share one budget,
    which is the fail-closed direction for a limiter and is exactly what a request
    with no identifiable source deserves. */
export function clientIpOrUnknown(headers: HeaderLike): string {
  return clientIp(headers) || 'unknown';
}
