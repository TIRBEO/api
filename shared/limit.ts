/** How many rows a caller asked for, kept inside the range the server will serve.
 *
 *  `Math.min(parseInt(raw), MAX)` on its own is only half a bound: a negative
 *  number walks backwards through the table instead of forwards, and a
 *  non-numeric one reaches Prisma as NaN, which throws a 500 at a screen that
 *  only wanted a list. Both are a query parameter away, so the floor, the
 *  ceiling and the "that is not a number" answer live in one place. */
export function clampLimit(
  raw: string | null | undefined,
  { fallback, max, min = 1 }: { fallback: number; max: number; min?: number },
): number {
  const asked = Math.floor(Number(raw));
  if (!Number.isFinite(asked)) return fallback;
  return Math.min(Math.max(asked, min), max);
}

/** How far into the list the caller asked to start. Never negative, and a value
    that is not a number means "from the beginning" rather than an error. */
export function clampOffset(raw: string | null | undefined): number {
  const asked = Math.floor(Number(raw));
  return Number.isFinite(asked) && asked > 0 ? asked : 0;
}
