/* E2E journey test: signup → verify-email → login-otp → password login → session.
 *
 * The API's human gates (email OTP delivery + CAPTCHA) are passed by seeding the
 * exact rows the handlers read (prisma.otp / prisma.signupOtp / captchaChallenge)
 * with a known code hashed via the API's own HMAC(OTP_PEPPER) — everything else
 * goes through the REAL HTTP handlers on the running API.
 */
const { createHmac, randomBytes, randomInt } = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

dotenv.config({ path: path.join(__dirname, '.env.local') });

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
// Isolate each test run in its own rate-limit bucket (as a distinct client IP).
const RUN_IP = `${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 200) + 10}`;
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------- DB client (same adapter wiring that works from this machine) ---- */
function makePrisma() {
  const base = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  const sep = base.includes('?') ? '&' : '?';
  const cs = base + sep + 'uselibpqcompat=true&sslmode=require';
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: cs }) });
}

function hashOtpCode(code) {
  return createHmac('sha256', process.env.OTP_PEPPER).update(code).digest('hex');
}

function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return '';
  const m = setCookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : '';
}

/* The proxy enforces a Redis-backed auth rate limit (5 req / 60s window).
 * On 429 we wait for the next window and retry once — the journey itself
 * must pass without tripping limits. */
async function apiWithRetry(route, opts, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    const r = await api(route, opts);
    if (r.status !== 429 || attempt >= maxRetries) return r;
    const waitMs = 60000 - (Date.now() % 60000) + 1500;
    console.log(`  …rate limited, waiting ${Math.round(waitMs / 1000)}s for next window…`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/* ---------- HTTP helper ----------------------------------------------------- */
async function api(route, { method = 'POST', body, cookie, csrf } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'tirbeo-e2e/1.0',
    'X-Forwarded-For': RUN_IP,
  };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + '/api/' + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const setCookie = (res.headers.get('set-cookie') || '')
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
  return { status: res.status, json, text, setCookie };
}

/* ---------- captcha seeding (only used if the API demands it) --------------- */
async function seedSolvedCaptcha(prisma) {
  const row = await prisma.captchaChallenge.create({
    data: {
      sessionId: 'anonymous', // matches the API when no __captcha_session cookie is present
      difficulty: 'easy',
      challengeType: 'math',
      question: '1+1',
      answerHash: 'dummy',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      solved: true,
      solvedAt: new Date(),
    },
  });
  return row.id;
}

/* ---------- payloads -------------------------------------------------------- */
const EMAIL = `e2e-${Date.now()}@tirbeo.dev`;
const PASSWORD = 'E2e!' + randomBytes(12).toString('base64url').slice(0, 14);
const SIGNUP_BODY = {
  email: EMAIL,
  password: PASSWORD,
  firstName: 'E2E',
  lastName: 'Tester',
  username: `e2e${Date.now().toString().slice(-6)}`,
  dob: '1995-04-12',
  gender: 'Prefer not to say',
  occupation: 'Software Engineer',
  companyName: 'Tirbeo QA',
  policyAccepted: true,
  adminDataAccess: false,
  signatureDataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  signatureName: 'E2E Tester',
  fingerprint: `e2e-${randomInt(100000, 999999)}`,
};

async function main() {
  console.log(`\n═══ TIRBEO E2E JOURNEY ═══`);
  console.log(`Target: ${BASE}/api`);
  console.log(`Email:  ${EMAIL}\n`);

  const prisma = makePrisma();
  await prisma.$connect();

  let signupRes = null; // function-scope so the cleanup block can reach it
  let loginCookie = '';
  let csrfToken = '';

  try {
    /* 1 ── pre-check: email-exists ------------------------------------------ */
    {
      const r = await api('auth/email-exists', { body: { email: EMAIL } });
      step(
        '1. auth/email-exists (pre)',
        r.status === 200 && r.json.exists === false,
        `status=${r.status} exists=${r.json?.exists}`
      );
    }

    /* 2 ── signup (with captcha fallback) ------------------------------------ */
    {
      let captchaRayId;
      for (let attempt = 0; attempt < 2; attempt++) {
        signupRes = await apiWithRetry('auth/signup', { body: { ...SIGNUP_BODY, captchaRayId } });
        if (signupRes.status === 403 && /captcha/i.test(signupRes.text) && !captchaRayId) {
          console.log('  …captcha demanded by API, seeding solved challenge…');
          captchaRayId = await seedSolvedCaptcha(prisma);
          continue;
        }
        break;
      }
      step(
        '2. auth/signup (201 + session cookie)',
        signupRes.status === 201 && !!signupRes.setCookie.includes('__session'),
        `status=${signupRes.status} ${signupRes.text.slice(0, 120)}`
      );
      csrfToken = extractCookie(signupRes.setCookie, '__csrf');
    }

    /* 3 ── verify email (seed OTP, then real handler) ------------------------ */
    {
      const verifyCode = String(randomInt(100000, 1000000));
      await prisma.otp.create({
        data: {
          userId: signupRes.json.id,
          type: 'email',
          otpHash: hashOtpCode(verifyCode),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      const r = await api('auth/verify-email', { body: { email: EMAIL, code: verifyCode } });
      const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { emailVerified: true } });
      step(
        '3. auth/verify-email ({email, code}) → verified',
        r.status === 200 && user?.emailVerified === true,
        `status=${r.status} emailVerified=${user?.emailVerified}`
      );
    }

    /* 4 ── login via email OTP (new login page flow) ------------------------- */
    {
      const req = await apiWithRetry('auth/login-otp/request', { body: { email: EMAIL } });
      step(
        '4a. auth/login-otp/request',
        req.status === 200,
        `status=${req.status} ${req.text.slice(0, 80)}`
      );

      const otpCode = String(randomInt(100000, 1000000));
      await prisma.signupOtp.create({
        data: {
          email: EMAIL,
          otpHash: hashOtpCode(otpCode),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      const r = await api('auth/login-otp/verify', { body: { email: EMAIL, otpCode } });
      loginCookie = r.setCookie;
      if (r.setCookie) csrfToken = extractCookie(r.setCookie, '__csrf') || csrfToken;
      step(
        '4b. auth/login-otp/verify → session',
        r.status === 200 && !!r.json?.token && r.setCookie.includes('__session'),
        `status=${r.status} token=${!!r.json?.token} cookie=${r.setCookie.includes('__session')}`
      );
    }

    /* 5 ── password login (auth/login, captcha fallback) --------------------- */
    let loginRes;
    {
      let captchaRayId;
      for (let attempt = 0; attempt < 2; attempt++) {
        loginRes = await apiWithRetry('auth/login', { body: { email: EMAIL, password: PASSWORD, captchaRayId } });
        if (loginRes.status === 403 && /captcha/i.test(loginRes.text) && !captchaRayId) {
          console.log('  …captcha demanded by API, seeding solved challenge…');
          captchaRayId = await seedSolvedCaptcha(prisma);
          continue;
        }
        break;
      }
      const ok =
        (loginRes.status === 200 && loginRes.setCookie.includes('__session')) ||
        (loginRes.json?.needs2FA === true);
      step(
        '5. auth/login (password) → session / 2FA challenge',
        ok,
        `status=${loginRes.status} needs2FA=${loginRes.json?.needs2FA} cookie=${loginRes.setCookie.includes('__session')}`
      );
      if (loginRes.setCookie) {
        loginCookie = loginRes.setCookie;
        csrfToken = extractCookie(loginRes.setCookie, '__csrf') || csrfToken;
      }
    }

    /* 6 ── session check with the cookie -------------------------------------- */
    {
      const r = await api('auth/session', { method: 'GET', cookie: loginCookie });
      step(
        '6. auth/session (cookie) → user',
        r.status === 200 && !!r.json?.user && r.json.user.email === EMAIL,
        `status=${r.status} email=${r.json?.user?.email}`
      );
    }

    /* 7 ── refresh token round-trip (POST → requires X-CSRF-Token) ------------- */
    {
      const r = await api('auth/refresh', { method: 'POST', cookie: loginCookie, csrf: csrfToken });
      step(
        '7. auth/refresh (cookie + CSRF)',
        r.status === 200 && (!!r.json?.token || !!r.json?.user || r.setCookie.includes('__session')),
        `status=${r.status} ${(r.text || '').slice(0, 80)}`
      );
    }
  } catch (err) {
    console.error('\n[E2E FATAL]', err);
    step('journey completed', false, 'fatal error — see stack above');
  } finally {
    /* cleanup: remove test user + seeded rows */
    try {
      await prisma.signupOtp.deleteMany({ where: { email: EMAIL } });
      await prisma.otp.deleteMany({ where: { userId: signupRes?.json?.id } });
      await prisma.session.deleteMany({ where: { userId: signupRes?.json?.id } });
      await prisma.captchaChallenge.deleteMany({ where: { sessionId: 'anonymous', answerHash: 'dummy' } });
      if (signupRes?.json?.id) await prisma.user.delete({ where: { id: signupRes.json.id } });
      console.log('  🧹 cleanup: test user + OTP/session rows removed');
    } catch (e) {
      console.log('  🧹 cleanup partial:', e.message);
    }
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ RESULT: ${passed}/${results.length} steps passed ═══\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
