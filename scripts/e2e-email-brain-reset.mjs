#!/usr/bin/env node
/**
 * E2E — Email Brain password-reset → decision engine → queue.
 *
 * Requests a password reset through the REAL API (POST /api/auth/password-reset/request),
 * then asserts against the REAL database:
 *   1. exactly ONE email_jobs row for this request (dedup + single route),
 *   2. the payload contains NO secret material (no OTP, no token/URL),
 *   3. the job is a security event routed immediate/queued (not suppressed),
 *   4. the job references the secure-ref mechanism.
 *
 * Secrets go to the Redis secure store (emailbrain:sv:*) and are consumed by the
 * queue worker — they must never appear in any DB row.
 *
 * Prereqs: API running on :3000 (npm run dev), REDIS_URL + DATABASE_URL in .env.local.
 * Run: npx tsx --env-file=.env.local scripts/e2e-email-brain-reset.mjs
 * (standalone node script; tsx is only needed if you import TS helpers — this file
 * uses plain pg/ioredis so `node --env-file=.env.local scripts/e2e-email-brain-reset.mjs` works)
 */
import { Pool } from 'pg';
import Redis from 'ioredis';

// ALWAYS target the local dev API — never a production URL (NEXT_PUBLIC_API_URL
// in .env.local points at prod). Override with E2E_API_URL if needed.
const API = process.env.E2E_API_URL || 'http://localhost:3000';
const EMAIL = `e2e-brain-reset-${Date.now()}@tirbeo.test`;

const step = (m) => console.log(`▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

// ── env ─────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
function env(name) {
  const forFile = ['.env.local', '.env'];
  for (const f of forFile) {
    try {
      const m = readFileSync(f, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  return undefined;
}

const DB = env('DIRECT_DATABASE_URL') || env('DATABASE_URL');
const REDIS = env('REDIS_URL');

const pool = new Pool({ connectionString: DB, max: 1, ssl: { rejectUnauthorized: false } });
const redis = REDIS ? new Redis(REDIS, { maxRetriesPerRequest: 2 }) : null;

async function main() {
  step(`Using API ${API} and a fresh throwaway user`);
  const userId = `e2e-${Date.now()}`;
  await pool.query(
    `INSERT INTO users (id, email, name, email_verified)
     VALUES ($1, $2, 'E2E Brain Reset', true)
     ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id`,
    [userId, EMAIL],
  );
  ok(`user seeded: ${EMAIL}`);

  // ── 1. Request the reset through the real API ──
  step('POST /api/auth/password-reset/request (method=otp)');
  const res = await fetch(`${API}/api/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, method: 'otp' }),
  }).catch((e) => { fail(`API unreachable: ${e.message}`); return null; });
  if (!res) return;

  if (res.status === 429) {
    console.log('  ⚠ rate limited (cooldown from earlier runs) — use a fresh EMAIL or wait');
  }
  if (!res.ok && res.status !== 429) {
    fail(`API responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (res.ok) ok(`API answered ${res.status} (enumeration-safe response)`);

  // ── 2. Assert exactly one queued job ──
  step('Assert exactly ONE email_jobs row for this request');
  const jobs = await pool.query(
    `SELECT id, event_key, user_id, to_email, category, priority, status, payload, dedupe_key
     FROM email_jobs WHERE to_email = $1 ORDER BY created_at`,
    [EMAIL],
  );
  if (jobs.rows.length === 0) {
    // Legit alternate outcome: secure store failed closed → inline fallback path,
    // or the API fell back to legacy send. Detect and report honestly.
    const logs = await pool.query(
      `SELECT id FROM email_logs WHERE to_email = $1 AND template = 'password_reset_otp' AND created_at > NOW() - INTERVAL '2 minutes'`,
      [EMAIL],
    );
    if (logs.rows.length > 0) {
      console.log('  ⚠ job missing but legacy inline email sent (secure store unavailable?)');
      fail('expected an email_jobs row — flow fell back to legacy path');
    } else {
      fail('no email_jobs row and no legacy email_log — flow did not run');
    }
    return;
  }
  if (jobs.rows.length > 1) {
    fail(`expected 1 job, found ${jobs.rows.length}: ${jobs.rows.map((r) => r.id).join(', ')}`);
    return;
  }
  const job = jobs.rows[0];
  ok(`exactly one job (${job.id.slice(0, 8)}…) status=${job.status} priority=${job.priority}`);

  if (job.event_key !== 'auth.password_reset') fail(`event_key=${job.event_key}, expected auth.password_reset`);
  else ok('event_key = auth.password_reset');
  if (job.category !== 'security') fail(`category=${job.category}, expected security`);
  else ok('category = security (immediate, mandatory)');
  if (job.priority !== 'high') fail(`priority=${job.priority}, expected high`);
  else ok('priority = high (mandatory event)');

  // ── 3. Assert NO secret material in the payload or any DB column ──
  step('Assert payload is allowlisted and carries no secret material');
  const payload = job.payload || {};
  const payloadKeys = Object.keys(payload).map((k) => k.toLowerCase());
  const ALLOWED = ['user.name', 'secureref']; // contract: display name + one-time ref id ONLY
  const unexpected = payloadKeys.filter((k) => !ALLOWED.includes(k));
  if (unexpected.length > 0) {
    fail(`payload has unexpected key(s): ${unexpected.join(', ')} — review before allowlisting`);
  } else {
    ok(`payload keys allowlisted: {${payloadKeys.join(', ')}}`);
  }
  const ref = String(payload.secureRef || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    fail(`secureRef is not a UUID (may embed secret material): ${ref.slice(0, 24)}`);
  } else {
    ok('secureRef is an opaque UUID reference');
  }

  // Round-trip proof: read the OTP from the Redis secure store via the ref,
  // then assert that exact code appears NOWHERE in the job row.
  let otpCode = null;
  if (redis && ref) {
    const raw = await redis.get(`emailbrain:sv:${ref}`).catch(() => null);
    if (raw) {
      try { otpCode = JSON.parse(raw)?.otpCode || null; } catch {}
      if (otpCode) ok('secure store round-trip: OTP retrieved via ref (worker has not consumed it yet)');
    } else {
      console.log('  ⚠ secure key already consumed (worker processed the job during the test)');
    }
  }
  const jobStr = JSON.stringify(job);
  const sixDigits = jobStr.match(/\d{6}/g);
  if (otpCode && jobStr.includes(otpCode)) {
    fail(`OTP code present in the job row!`);
  } else if (!otpCode && sixDigits) {
    fail(`job row contains 6-digit sequence(s) that could be an OTP: ${sixDigits.slice(0, 3).join(', ')}`);
  } else {
    ok('job row contains no OTP material' + (otpCode ? ' (checked against the real code)' : ' (no 6-digit sequences)'));
  }

  // ── 4. Secure-ref store: the one-time key exists (or was already consumed) ──
  if (redis) {
    step('Secure store sanity (TTL-bounded, consumed on read)');
    const keys = await redis.keys('emailbrain:sv:*');
    ok(`secure store holds ${keys.length} key(s) across all flows`);
  }

  // ── 5. Idempotency: duplicate request inside the dedup window ──
  step('Duplicate event delivery → still exactly one job');
  // The dedup key includes a per-request UUID, so a NEW request legitimately
  // creates a NEW job (each user request is a distinct reset attempt). Instead
  // we verify the unique index directly: re-inserting the same dedupe_key must fail.
  const dup = await pool.query(
    `INSERT INTO email_jobs (dedupe_key, event_key, to_email, category, priority, status, payload)
     VALUES ($1, 'auth.password_reset', $2, 'security', 'high', 'queued', '{}')
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [job.dedupe_key, EMAIL],
  );
  if (dup.rows.length === 0) ok('duplicate dedupe_key rejected by unique index');
  else { fail('duplicate dedupe_key was accepted!'); await pool.query(`DELETE FROM email_jobs WHERE id = $1`, [dup.rows[0].id]); }

  // ── 6. Cleanup ──
  step('Cleanup');
  await pool.query(`DELETE FROM email_jobs WHERE to_email = $1`, [EMAIL]);
  await pool.query(`DELETE FROM email_logs WHERE to_email = $1`, [EMAIL]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  ok('test rows removed');
}

main()
  .catch((e) => { fail(e?.message || String(e)); })
  .finally(async () => {
    if (redis) await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
