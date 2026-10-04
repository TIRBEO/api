import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '../proxy';

/**
 * The profile service calls `/api/internal/profile` server-to-server with a
 * shared `x-internal-token`, not a browser session. If the global gate ever
 * demands a cookie again, every profile read and write in the settings app
 * 401s before the handler can check that token — which is exactly how this
 * broke once already.
 */
function call(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return proxy(new NextRequest(`https://api.tirbeo.com${path}`, { method, headers }));
}

describe('proxy session gate', () => {
  it('lets an internal service call through without a session', async () => {
    const res = await call('/api/internal/profile', {
      'x-internal-token': 'the-shared-service-secret',
      'x-user-id': 'a-user-id',
    });

    // The handler is the authority on the token; the gate must not be.
    expect(res.status).not.toBe(401);
  });

  it('lets an internal write through as well as a read', async () => {
    const res = await call(
      '/api/internal/profile',
      { 'x-internal-token': 'the-shared-service-secret', 'x-user-id': 'a-user-id', 'content-type': 'application/json' },
      'PATCH',
    );

    expect(res.status).not.toBe(401);
  });

  it('still demands a credential for a browser route', async () => {
    expect((await call('/api/users/me')).status).toBe(401);
    expect((await call('/api/profile')).status).toBe(401);
  });

  it('does not excuse a route that merely starts with the same word', async () => {
    expect((await call('/api/internalish/profile')).status).toBe(401);
  });
});
