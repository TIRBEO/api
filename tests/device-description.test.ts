import { describe, expect, it } from "vitest";

/* Every security alert and sign-in notice quotes these words, and the whole
   point of the pair is that neither may invent a fact the request never carried.
   An admin mail reading `Device: Browser on Unknown OS` is worse than a mail
   with no device line: it looks like evidence. */

import { describeDevice, deviceDetail } from "@/features/notifications/notifications";

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  // A client that says nothing about itself — curl, a health probe, a stripped UA.
  bare: 'node-fetch/1.0',
};

describe('what a user-agent identifies', () => {
  it('names the browser and the system it runs on', () => {
    expect(deviceDetail(UA.chromeWindows)).toBe('Chrome on Windows');
    expect(deviceDetail(UA.firefoxLinux)).toBe('Firefox on Linux');
    expect(deviceDetail(UA.edgeWindows)).toBe('Edge on Windows');
  });

  it('reads a phone as the phone it is', () => {
    expect(deviceDetail(UA.safariIphone)).toBe('Safari on iOS');
    expect(deviceDetail(UA.pixel)).toBe('Chrome on Android');
  });

  /* The order matters: Chrome, Edge and Safari all say "Safari" in their
     vendor token, so the engine string cannot be what decides the name. */
  it('does not call a Chromium browser Safari', () => {
    expect(deviceDetail(UA.chromeWindows)).not.toContain('Safari');
    expect(deviceDetail(UA.edgeWindows)).not.toContain('Safari');
  });

  it('says nothing when the request said nothing', () => {
    expect(deviceDetail(UA.bare)).toBeNull();
    expect(deviceDetail('')).toBeNull();
    expect(deviceDetail(null)).toBeNull();
    expect(deviceDetail(undefined)).toBeNull();
  });

  it('still has a phrase for a sentence that has to be finished', () => {
    expect(describeDevice(UA.chromeWindows)).toBe('Chrome on Windows');
    expect(describeDevice(UA.bare)).toBe('an unrecognized device');
  });
});
