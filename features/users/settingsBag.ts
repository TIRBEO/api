/* ═══════════════════════════════════════════════════════════════════
   Bounds for the generic settings bag (`preferences.misc.settings`).

   NOT a whitelist: every key a client already stores keeps being stored —
   dropping one would silently delete somebody's saved state, because the bag
   holds migrated per-device choices that exist nowhere else. What is bounded is
   the SHAPE: key length, value kind, per-value size, and the size of the merged
   bag, so one write cannot turn a settings row into an unbounded blob and a
   hostile key cannot poison the objects the bag is spread into on every read.

   Pure and dependency-free so the rules can be tested without a database.
   ═══════════════════════════════════════════════════════════════════ */

export const SETTINGS_LIMITS = {
  keyBytes: 128,
  valueBytes: 8 * 1024,
  /** The merged bag as JSON. Comfortably above any real settings set, far
      below a jsonb column being used as a filing cabinet. */
  totalBytes: 128 * 1024,
  depth: 6,
} as const;

/** Keys that would pollute every object the bag is later spread into —
    `settings[key] = value` on `__proto__` is how a JSON bag becomes an RCE
    foothold downstream. Refused, not ignored: no honest client sends these,
    so a silent drop would hide the one request worth hearing about. */
export const FORBIDDEN_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A reserved key anywhere inside a submitted value — the bag is spread into
    live objects on every read, so `{"a":{"__proto__":…}}` is the same hazard as
    a top-level one. Checked separately from the shape test so it can be
    REFUSED rather than quietly dropped. */
export function containsForbiddenSettingsKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth >= SETTINGS_LIMITS.depth + 2) return false;
  if (Array.isArray(value)) return value.some((v) => containsForbiddenSettingsKey(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([k, v]) =>
    FORBIDDEN_SETTINGS_KEYS.has(k) || containsForbiddenSettingsKey(v, depth + 1));
}

/** Can this value be stored and read back as the same thing? JSON primitives,
    plain objects and arrays only — functions, symbols, NaN/Infinity, class
    instances and over-deep nesting are not, and would vanish or change shape
    on the read. */
export function isStorableSettingsValue(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value as number);
  if (t !== 'object') return false; // functions, symbols, undefined — not JSON
  if (depth >= SETTINGS_LIMITS.depth) return false;
  if (Array.isArray(value)) return (value as unknown[]).every((v) => isStorableSettingsValue(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([k, v]) => !FORBIDDEN_SETTINGS_KEYS.has(k) && isStorableSettingsValue(v, depth + 1));
}

/** Serialized size of the merged bag. `null` when it cannot be serialized at
    all — a caller must refuse rather than store something that cannot come
    back. */
export function settingsBagBytes(bag: unknown): number | null {
  try {
    const s = JSON.stringify(bag);
    return typeof s === 'string' ? s.length : null;
  } catch {
    return null;
  }
}
