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

/** App domain (e.g. "tirbeo.app") */
export function getAppDomain(): string {
  return process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
}

/** API base URL */
export function getApiBaseUrl(): string {
  if (isLocalEnv()) return 'http://localhost:3000';
  return process.env.NEXT_PUBLIC_API_URL || `https://api.${getAppDomain()}`;
}

/** Accounts app base URL (e.g. http://localhost:3002 in dev, https://accounts.tirbeo.app in prod). */
export function getAccountsBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3002';
  return `https://accounts.${appDomain}`;
}

/** Dashboard app base URL (e.g. http://localhost:3005 in dev, https://dashboard.tirbeo.app in prod). */
export function getDashboardBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3005';
  return `https://dashboard.${appDomain}`;
}

/** Admin app base URL (e.g. http://localhost:4000 in dev, https://admin.tirbeo.app in prod). */
export function getAdminBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:4000';
  return `https://admin.${appDomain}`;
}

/** Forms app base URL */
export function getFormsBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3004';
  return `https://forms.${appDomain}`;
}

/** Support app base URL (same domain as dashboard) */
export function getSupportBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3005';
  return `https://support.${appDomain}`;
}

/** CDN app base URL */
export function getCdnBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:4400';
  return `https://cdn.${appDomain}`;
}

/** WebSocket server URL */
export function getWsUrl(): string {
  if (isLocalEnv()) return 'ws://localhost:3001';
  return `wss://ws.${getAppDomain()}`;
}

/** WebSocket server full path */
export function getWsEndpoint(): string {
  return `${getWsUrl()}/ws`;
}

/** CORS allowed origins for the WS server */
export function getAllowedOrigins(): string[] {
  const appDomain = getAppDomain();
  if (isLocalEnv()) {
    return [
      'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002',
      'http://localhost:3003', 'http://localhost:3004', 'http://localhost:3005',
      'http://localhost:4000', 'http://localhost:4400',
    ];
  }
  return [
    `https://${appDomain}`,
    `https://accounts.${appDomain}`,
    `https://dashboard.${appDomain}`,
    `https://admin.${appDomain}`,
    `https://forms.${appDomain}`,
    `https://support.${appDomain}`,
    `https://cdn.${appDomain}`,
    `https://docs.${appDomain}`,
  ];
}
