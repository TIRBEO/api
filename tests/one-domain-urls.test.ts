import { describe, it, expect, afterEach } from 'vitest';
import { getApiBaseUrl, getAppDomain } from '@/config/app-urls';

/* One domain: production URLs derived without NEXT_PUBLIC_API_URL point at the
   app origin itself — api.tirbeo.com is only a redirect for old links. */

const env = process.env as Record<string, string | undefined>;
const saved = {
  nodeEnv: process.env.NODE_ENV,
  apiUrl: process.env.NEXT_PUBLIC_API_URL,
  appDomain: process.env.NEXT_PUBLIC_APP_DOMAIN,
};

afterEach(() => {
  env.NODE_ENV = saved.nodeEnv;
  if (saved.apiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = saved.apiUrl;
  if (saved.appDomain === undefined) delete process.env.NEXT_PUBLIC_APP_DOMAIN;
  else process.env.NEXT_PUBLIC_APP_DOMAIN = saved.appDomain;
});

describe('one-domain API base', () => {
  it('production derives https://tirbeo.com with no explicit env', () => {
    env.NODE_ENV = 'production';
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_APP_DOMAIN;
    expect(getAppDomain()).toBe('tirbeo.com');
    expect(getApiBaseUrl()).toBe('https://tirbeo.com');
  });

  it('honours an explicit override and strips its trailing slash', () => {
    env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/';
    expect(getApiBaseUrl()).toBe('https://api.example.com');
  });

  it('drops loopback overrides in production (stale .env.local safety)', () => {
    env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3000';
    expect(getApiBaseUrl()).toBe('https://tirbeo.com');
  });

  it('development still points at the local API server', () => {
    env.NODE_ENV = 'development';
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBaseUrl()).toBe('http://localhost:3000');
  });
});
