// Dev/prod-aware platform URL helpers.
//
// These run server-side (in the API), so NODE_ENV is the reliable dev
// discriminator — NEXT_PUBLIC_* env vars are NOT guaranteed to be set in the
// API's own environment, and deriving from them alone produced broken URLs
// like `https://accounts.localhost/...` in local development.

export function isLocalEnv(): boolean {
  // Production is never "local", even when a stale env var (copied from
  // .env.local into the deployment) still names localhost — that used to
  // rewrite every prod redirect to a loopback URL.
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NODE_ENV === 'development') return true;
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || '';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  return appDomain.includes('localhost') || apiUrl.includes('localhost');
}

/**
 * Returns a URL/domain env value only when it is safe to honour. In
 * production, values pointing at loopback are dropped (empty string) so
 * callers fall back to the canonical tirbeo.com URLs instead of shipping
 * localhost links in emails and redirects.
 */
export function prodSafeEnvUrl(value: string | undefined | null): string {
  if (!value) return '';
  if (process.env.NODE_ENV !== 'production') return value;
  return value.includes('localhost') || value.includes('127.0.0.1') ? '' : value;
}

/** App domain (e.g. "tirbeo.com") */
export function getAppDomain(): string {
  return prodSafeEnvUrl(process.env.NEXT_PUBLIC_APP_DOMAIN) || 'tirbeo.com';
}

/** API base URL */
export function getApiBaseUrl(): string {
  if (isLocalEnv()) return 'http://localhost:3000';
  return prodSafeEnvUrl(process.env.NEXT_PUBLIC_API_URL) || `https://api.${getAppDomain()}`;
}

/** Accounts app base URL (e.g. http://localhost:3002 in dev, https://accounts.tirbeo.com in prod). */
export function getAccountsBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3002';
  return `https://accounts.${appDomain}`;
}

/** Profile app base URL — the user-facing dashboard (formerly dashboard.tirbeo.com,
 *  now myprofile.tirbeo.com; http://localhost:3005 in dev). */
export function getDashboardBaseUrl(): string {
  const appDomain = getAppDomain();
  if (isLocalEnv()) return 'http://localhost:3005';
  return `https://myprofile.${appDomain}`;
}

/**
 * Profile service base URL — `apps/myprofile`, which owns the settings screens
 * and now serves the profile API itself.
 *
 * Falls back to the dashboard address on purpose: the settings app took over
 * the dashboard's port in development and its root domain in production, and
 * `apps/dashboard` is gone. Set MYPROFILE_URL once it is deployed under its own
 * name rather than relying on that coincidence — the two are only the same
 * address today by history, not by design.
 */
export function getMyprofileBaseUrl(): string {
  const explicit = prodSafeEnvUrl(process.env.MYPROFILE_URL) || prodSafeEnvUrl(process.env.NEXT_PUBLIC_MYPROFILE_URL) || '';
  if (explicit) return explicit.replace(/\/+$/, '');
  return getDashboardBaseUrl();
}

/** Admin app base URL (e.g. http://localhost:4000 in dev, https://admin.tirbeo.com in prod). */
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

/** Support app base URL — support lives INSIDE the dashboard at /support/tickets. */
export function getSupportBaseUrl(): string {
  return getDashboardBaseUrl();
}

/** Full URL to a support ticket inside the dashboard. */
export function getSupportTicketUrl(ticketId: string): string {
  return `${getDashboardBaseUrl()}/support/tickets/${ticketId}`;
}

/** Full URL to a form's detail page in the forms app. */
export function getFormViewUrl(formId: string): string {
  return `${getFormsBaseUrl()}/forms/${formId}`;
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
      'http://localhost:3006',
      'http://localhost:4000', 'http://localhost:4400',
    ];
  }
  return [
    `https://${appDomain}`,
    `https://accounts.${appDomain}`,
    `https://myprofile.${appDomain}`,
    // Retiring domain: still valid until dashboard.tirbeo.com stops resolving.
    `https://dashboard.${appDomain}`,
    `https://admin.${appDomain}`,
    `https://forms.${appDomain}`,
    `https://support.${appDomain}`,
    `https://cdn.${appDomain}`,
    `https://docs.${appDomain}`,
  ];
}

// ─── Shared host allow-list (CORS + post-auth redirects) ───
//
// Defaults are exactly what the platform always allowed: the tirbeo.com domain
// (plus every subdomain), the api host, and localhost in non-production. Extra
// hosts are opt-in through CORS_ALLOWED_HOSTS / ALLOWED_REDIRECT_HOSTS — a
// comma-separated list where an entry is either an exact hostname
// ("app.example.com") or a domain that also covers its subdomains
// ("example.com" ⇒ example.com + *.example.com). This is what makes the app
// work when deployed to a preview / alternate domain without touching the
// source, while keeping production locked to tirbeo.com by default.
function extraAllowedHostEntries(): string[] {
  const raw = [
    process.env.CORS_ALLOWED_HOSTS,
    process.env.ALLOWED_REDIRECT_HOSTS,
    process.env.NEXT_PUBLIC_ALLOWED_HOSTS,
  ]
    .filter(Boolean)
    .join(',');
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns true when `hostname` may be used as a CORS origin and/or a trusted
 * post-auth redirect target. Never matches on protocol/credentials — callers
 * validate those separately.
 */
export function isHostAllowed(hostname: string): boolean {
  const host = (hostname || '').toLowerCase();
  if (!host) return false;

  const appDomain = getAppDomain().toLowerCase();
  if (host === appDomain || host.endsWith(`.${appDomain}`)) return true;
  if (host === `api.${appDomain}`) return true;

  // localhost / 127.0.0.1 are trusted only outside production.
  const nonProd = process.env.NODE_ENV !== 'production';
  if (nonProd && (host === 'localhost' || host === '127.0.0.1')) return true;

  for (const entry of extraAllowedHostEntries()) {
    if (host === entry || host.endsWith(`.${entry.replace(/^\./, '')}`)) return true;
  }
  return false;
}

