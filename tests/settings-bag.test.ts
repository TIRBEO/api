/**
 * Settings bag bounds (features/users/settingsBag).
 *
 * The bag is the account's own migrated state — theme picks, per-device choices
 * brought over from localStorage — so the guard must bound it WITHOUT becoming a
 * whitelist: an unknown key keeps being stored, and only three things are
 * refused: prototype-polluting names, values JSON cannot carry back, and a bag
 * that has grown past its size.
 */
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_SETTINGS_KEYS,
  SETTINGS_LIMITS,
  containsForbiddenSettingsKey,
  isStorableSettingsValue,
  settingsBagBytes } from '@/features/users/settingsBag';

describe('isStorableSettingsValue', () => {
  it('accepts the shapes a settings screen actually writes', () => {
    const accepted: unknown[] = [
      'dark', 3, 3.5, true, false, null,
      ['a', 'b'], { a: 1, b: { c: [1, 2] } }, [], {},
      // a migrated per-device key, exactly as the client sends it
      'tirbeo:docs',
    ];
    for (const v of accepted) expect(isStorableSettingsValue(v), JSON.stringify(v)).toBe(true);
  });

  it('ignores values that cannot survive a write and a read', () => {
    const refused: unknown[] = [
      undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('x'),
      // over-deep nesting
      JSON.parse('[' + '['.repeat(20) + ']'.repeat(20) + ']'),
    ];
    for (const v of refused) expect(isStorableSettingsValue(v), String(v)).toBe(false);
  });

  it('refuses a reserved key nested inside an otherwise valid value', () => {
    expect(isStorableSettingsValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
    expect(isStorableSettingsValue({ ok: 1, nested: { constructor: 'x' } })).toBe(false);
  });
});

describe('containsForbiddenSettingsKey', () => {
  it('finds the three names at any depth', () => {
    // JSON.parse, not an object literal: `{ __proto__: x }` in source sets the
    // prototype instead of creating an own key, which is not what a request
    // body ever is.
    expect(containsForbiddenSettingsKey(JSON.parse('{"a":{"b":[{"__proto__":"x"}]}}'))).toBe(true);
    expect(containsForbiddenSettingsKey(JSON.parse('{"prototype":1}'))).toBe(true);
    expect(containsForbiddenSettingsKey({ a: 1, b: { c: 'fine' } })).toBe(false);
  });

  it('lists the names it guards, so a client can be checked against it', () => {
    expect([...FORBIDDEN_SETTINGS_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });
});

describe('settingsBagBytes', () => {
  it('measures the merged bag against the ceiling', () => {
    expect(settingsBagBytes({ theme: 'dark' })).toBeLessThan(64);
    const huge: Record<string, string> = {};
    for (let i = 0; i < 200; i++) huge[`tirbeo:key${i}`] = 'x'.repeat(1000);
    expect(settingsBagBytes(huge)).toBeGreaterThan(SETTINGS_LIMITS.totalBytes);
  });

  it('reports null for something that cannot be serialized at all', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(settingsBagBytes(cyclic)).toBeNull();
  });

  it('keeps every key a client already has while measuring', () => {
    // The ceiling is a size limit, not a name filter: a bag of unfamiliar keys
    // is still storable as long as it fits.
    const migrated = { 'tirbeo:docs': { a: 1 }, 'tirbeo:sound': true, unknownFromAnotherClient: 'x' };
    expect(settingsBagBytes(migrated)).toBeLessThan(SETTINGS_LIMITS.totalBytes);
    expect(Object.keys(migrated)).toHaveLength(3);
  });
});
