// Dev/prod-aware platform URL helpers.
//
// These run server-side (in the API), so NODE_ENV is the reliable dev
// discriminator — NEXT_PUBLIC_* env vars are NOT guaranteed to be set in the
// API's own environment, and deriving from them alone produced broken URLs
// like `https://accounts.localhost/...` in local development.

export function isLocalEnv(): boolean {
  if (process.env.NODE_ENV === 'development') return true;
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || '';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  return appDomain.includes('localhost') || apiUrl.includes('localhost');
}

/** Accounts app base URL (e.g. http://localhost:3002 in dev, https://accounts.tirbeo.app in prod). */
export function getAccountsBaseUrl(): string {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  if (isLocalEnv()) return 'http://localhost:3002';
  return `https://accounts.${appDomain}`;
}

/** Dashboard app base URL (e.g. http://localhost:3005 in dev, https://dashboard.tirbeo.app in prod). */
export function getDashboardBaseUrl(): string {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  if (isLocalEnv()) return 'http://localhost:3005';
  return `https://dashboard.${appDomain}`;
}

/** Admin app base URL (e.g. http://localhost:4000 in dev, https://admin.tirbeo.app in prod). */
export function getAdminBaseUrl(): string {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  if (isLocalEnv()) return 'http://localhost:4000';
  return `https://admin.${appDomain}`;
}
