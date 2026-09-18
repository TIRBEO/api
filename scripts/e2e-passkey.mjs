/**
 * E2E passkey verification (real API :3000, real DB, real WebAuthn).
 *
 * Uses Playwright Chromium with a CDP virtual authenticator — the ceremonies
 * are genuine (CTAP2 create/get through Chrome's WebAuthn stack); only the
 * physical touch is simulated.
 *
 * Flow: dashboard security page "Add passkey" → passkey stored in DB →
 * same page navigates to admin :4000/login → "Sign in with passkey" →
 * redirected to /admin with a live session → admin API answers 200.
 *
 * Prereqs: API on :3000, dashboard dev on :3005, admin dev on :4000,
 * seeded user (scripts/seed-e2e-passkey-user.ts).
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const API = 'http://localhost:3000';
const DASHBOARD = 'http://localhost:3005';
const ADMIN = 'http://localhost:4000';
const EMAIL = 'e2e-passkey-test@tirbeo.test';

const step = (msg) => console.log(`▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Attach ONE virtual authenticator to this page's session — it backs both
  // ceremonies (register on the dashboard, assert on the admin origin).
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  step('Virtual authenticator attached (ctap2, internal, user-verified)');

  /* ── 1. Establish a dashboard session (real API session, issued via the
        app's own createSession — the same trust path the email-OTP
        challenge flow completes with; the password path would demand an
        email OTP this environment can't receive) ── */
  step(`Issuing a real session for ${EMAIL}`);
  const session = JSON.parse(execFileSync(
    'npx',
    ['tsx', '--env-file=.env.local', 'scripts/issue-e2e-session.ts'],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(l => l.startsWith('{'))[0]);
  if (!session.token) { fail('session issuance failed'); throw new Error('abort'); }
  ok('real session issued (access + refresh tokens)');

  // Mirror what the accounts/dashboard apps do after login: store the bearer
  // and set the session + CSRF cookies on the API origin.
  await page.goto(`${DASHBOARD}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('auth_token', t), session.token);
  await page.evaluate(({ api, token, refresh }) => {
    document.cookie = `__session=${token}; Path=/; Domain=localhost; SameSite=Lax`;
    document.cookie = `__refresh=${refresh}; Path=/; Domain=localhost; SameSite=Lax`;
    void api; void token;
  }, { api: API, token: session.token, refresh: session.refreshToken });
  ok('dashboard context authenticated (bearer + cookies)');

  /* ── 2. Register the passkey through the real security page ── */
  step(`Opening ${DASHBOARD}/account/security and registering a passkey`);
  await page.goto(`${DASHBOARD}/account/security`, { waitUntil: 'domcontentloaded' });

  const addBtn = page.getByRole('button', { name: /add passkey/i });
  await addBtn.waitFor({ state: 'visible', timeout: 30000 });
  ok('PasskeyManager rendered with "Add passkey"');

  await addBtn.click();
  // The ceremony is handled by the virtual authenticator; wait for the
  // success toast the PasskeyManager fires after the API verifies it.
  await page.waitForFunction(
    () => document.body.innerText.includes('Passkey added'),
    null, { timeout: 30000 },
  );
  ok('registration ceremony completed — API verified and stored the credential');

  // Cross-check the credential exists via the API
  const listRes = await page.evaluate(async (api) => {
    const token = localStorage.getItem('auth_token');
    const r = await fetch(`${api}/api/auth/passkeys`, { credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, API);
  const count = listRes.body?.passkeys?.length ?? 0;
  if (listRes.status !== 200 || count < 1) {
    fail(`GET /api/auth/passkeys → ${listRes.status}, passkeys: ${count}`);
    throw new Error('abort');
  }
  ok(`DB check: ${count} passkey registered (device: ${listRes.body.passkeys[0].deviceName || 'unnamed'})`);

  /* ── 3. Log in through the admin passkey button (assertion ceremony) ── */
  step(`Navigating to ${ADMIN}/login and signing in with the passkey`);
  await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });

  await page.getByLabel('Email').waitFor({ state: 'visible', timeout: 20000 });
  await page.getByLabel('Email').fill(EMAIL);

  await page.getByRole('button', { name: /sign in with passkey/i }).click();
  await page.waitForURL('**/admin', { timeout: 30000 });
  ok('assertion ceremony verified — redirected to /admin');

  await page.waitForSelector('.dashboard-sidebar', { timeout: 20000 });
  const shellOk = await page.evaluate(() => !!document.querySelector('.dashboard-content'));
  if (!shellOk) { fail('admin shell did not render'); throw new Error('abort'); }
  ok('admin shell rendered with an authenticated session');

  const adminToken = await page.evaluate(() => localStorage.getItem('auth_token'));
  const usersRes = await page.evaluate(async ({ api, token }) => {
    const r = await fetch(`${api}/api/admin/users?limit=5`, { credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, ok: r.ok };
  }, { api: API, token: adminToken });
  if (usersRes.status !== 200) {
    fail(`admin API check failed: /api/admin/users → ${usersRes.status}`);
    throw new Error('abort');
  }
  ok(`session proven against the API: GET /api/admin/users → 200`);

  /* ── 4. Virtual authenticator really holds the credential ── */
  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  ok(`virtual authenticator holds ${creds.credentials.length} credential(s)`);

  console.log(process.exitCode ? '\n❌ E2E FAILED' : '\n✅ E2E PASS: register → DB → login → session all verified');
} catch (err) {
  console.error(`\n❌ E2E FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
