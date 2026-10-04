/**
 * Read-only look at what the mail queue and the OTP table actually hold for the
 * account under test, so "the code never arrived" and "the code arrived but was
 * refused" can be told apart. Prints statuses and shapes only — no addresses,
 * no codes, no credentials.
 */
const { readFileSync } = require('fs');
const path = require('path');

function env(file) {
  const out = {};
  const at = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
  for (const line of readFileSync(at, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/i.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

async function main() {
  const e = { ...env('.env.local'), ...env('/tmp/tirbeo-e2e.env') };
  const { Client } = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'pg'));
  // Supabase's pooler presents a chain this box can't verify, so TLS stays on
  // with the hostname check relaxed. Local diagnostic only — reads nothing but
  // statuses, and prints no address, code or credential.
  const c = new Client({
    connectionString: e.DIRECT_DATABASE_URL || e.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
  });
  await c.connect();

  const EMAIL = (process.env.PROBE_EMAIL || e.E2E_EMAIL || '').toLowerCase();
  // The address may live in the email table, in the legacy column, or both —
  // find the account whichever way it is stored, because that difference is
  // exactly what makes a page name one inbox while the code goes to another.
  const user = await c.query(
    `select coalesce(
              (select user_id from "email".user_email where lower(address) = $1 limit 1),
              (select id from "user".users where lower(email) = $1 limit 1),
              (select id from "user".users where id = $2 limit 1)
     ) as id`,
    [EMAIL, e.E2E_USER_ID || 'none'],
  );
  const uid = user.rows[0]?.id;
  console.log('account resolved from the address:', uid ? 'yes' : 'NO — no user row carries it');
  if (!uid) { await c.end(); return; }

  // The send log keys on the address, not the user (createEmailLog doesn't set
  // userId), so look it up by who it went to.
  const jobs = await c.query(
    `select template_slug, status, subject, last_error, created_at, sent_at
       from "email".email_jobs
      where lower(to_address) = $1
      order by created_at desc limit 10`,
    [EMAIL],
  );
  console.log('\nlast mail sent to that address:');
  for (const r of jobs.rows) {
    console.log(' ', String(r.created_at), '|', r.template_slug || '(none)', '|', r.status,
      '|', r.sent_at ? 'delivered to provider' : 'never left',
      r.last_error ? '| ' + String(r.last_error).slice(0, 90) : '');
  }
  if (!jobs.rows.length) console.log('  (nothing — no mail was ever queued for that address)');

  const otps = await c.query(
    `select kind, attempts, created_at, expires_at from "security".otps
      where user_id = $1 or lower(address) = $2 order by created_at desc limit 8`,
    [uid, EMAIL],
  );
  console.log('\nlive OTP rows:');
  for (const r of otps.rows) {
    console.log(' ', String(r.created_at), '|', r.kind, '| attempts', r.attempts,
      '|', r.expires_at > new Date() ? 'unexpired' : 'EXPIRED');
  }
  if (!otps.rows.length) console.log('  (none — no code is waiting for this account)');

  const primary = await c.query(
    `select kind, is_default, (verified_at is not null) as verified
       from "email".user_email where user_id = $1`, [uid],
  );
  console.log('\nemail rows on the account:',
    primary.rows.map((r) => r.kind + (r.is_default ? '*' : '') + (r.verified ? '' : ' (unverified)')).join(', ') || '(none)');

  await c.end();
}

main().catch((err) => { console.error('PROBE FAILED:', err.message); process.exit(1); });
