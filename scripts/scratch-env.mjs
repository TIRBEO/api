/**
 * Build apps/api/.env.scratch from .env.local — without carrying a live
 * credential into the file it writes.
 *
 *   node scripts/scratch-env.mjs
 *   node scripts/scratch-env.mjs --example   // the committed twin, placeholders only
 *
 * The scratch environment exists so that `prisma db push`, a seed and a browser
 * test can be run without touching the production database, sending real mail or
 * billing an SMS. That only holds if nothing live survives the copy, so the rule
 * here is a whitelist and not a denylist: a key is kept only because this file
 * names it, and every key it does not name is blanked. A new secret added to the
 * live file next month is therefore blank by default rather than copied by
 * accident.
 *
 * Three kinds of value:
 *   kept     — configuration, not authority: domains, ports, addresses, model
 *              names. Anything that only describes where the product lives.
 *   rotated  — a value both sides of a boundary must agree on (session signing,
 *              peppers, the internal shared secret). Fresh per machine, printed
 *              never.
 *   rewritten — the database URLs, which point at the scratch cluster from
 *              scratch-db.mjs, and the loopback hosts a local browser test needs.
 *
 * Nothing this script prints is a value from the live file. It prints key names
 * and the decision, and for the handful of genuinely public keys (a domain, a
 * port) it prints the rewritten local value.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchUrls } from './scratch-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, '..');
const SOURCE = join(API, '.env.local');
const TARGET = join(API, '.env.scratch');

/** Configuration, not authority. Safe to keep because it cannot open anything. */
const KEEP = new Set([
  'NODE_ENV',
  'EMAIL_PROVIDER',
  'TIRBEO_MAIL_DOMAIN',
  'EMAIL_RESEND_DOMAIN',
  'EMAIL_FROM_NAME',
  'ADMIN_FROM_EMAIL',
  'EMAIL_FROM',
  'EMAIL_ALERT_FROM',
  'EMAIL_CODE_FROM',
  'EMAIL_NOTICE_FROM',
  'EMAIL_SECURITY_FROM',
  'EMAIL_SUPPORT_FROM',
  'EMAIL_ACCOUNT_FROM',
  'EMAIL_HELLO_FROM',
  'SUPPORT_EMAIL',
  'SUPPORT_INBOX_EMAIL',
  'STAFF_ALERT_EMAIL',
  'ADMIN_SEED_EMAIL',
  'TIRBEO_LOGO_URL',
  'OPENROUTER_DEFAULT_MODEL',
  'REALTIME_SFU_NAME',
  'TURN_NAME',
  'WS_PORT',
]);

/** Authority, regenerated locally. Both sides of the boundary read this file,
    so one generated value is enough — but it must never be the live one. */
const ROTATE = [
  'JWT_SECRET',
  'SESSION_SECRET',
  'OTP_PEPPER',
  'RECOVERY_PEPPER',
  'UNSUBSCRIBE_SECRET',
  'SECURITY_LOG_KEY',
  'INTERNAL_API_SECRET',
  'API_TOKEN',
  'RT_API_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
];

/** Where the local build answers from. A production URL here would make a
    confirmation mail, a redirect or a client bundle point at the real product. */
const REWRITE = {
  NEXT_PUBLIC_API_URL: 'http://localhost:3000',
  NEXT_PUBLIC_WS_URL: 'ws://localhost:3001',
  WS_PORT: '3001',
  NEXT_PUBLIC_APP_DOMAIN: 'localhost',
  NEXT_PUBLIC_COOKIE_DOMAIN: '',
  NEXT_PUBLIC_DASHBOARD_URL: 'http://localhost:4000',
  NEXT_PUBLIC_ADMIN_URL: 'http://localhost:4000',
  ADMIN_URL: 'http://localhost:4000',
  ACCOUNTS_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  TURNSTILE_SITE_KEY: '',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
  CAPTCHA_WIDGET_SITE_KEY: '',
};

/** Parse KEY=value lines without evaluating anything in the file. */
function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      rows.push({ kind: 'raw', line });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      rows.push({ kind: 'raw', line });
      continue;
    }
    rows.push({
      kind: 'pair',
      key: line.slice(0, eq).trim().replace(/^export\s+/, ''),
      value: line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/s, '$2'),
    });
  }
  return rows;
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * No address in a scratch environment may name a mailbox that exists.
 *
 * `.test` is reserved by RFC 6761 and has no DNS at all, so a message aimed at
 * it cannot be delivered even if a transport is configured by accident later.
 * Applied to every kept value that looks like an address — including lists —
 * because the live file's staff alert target is a person's real inbox, and a
 * fixture run that mails a stranger is not a leak nobody noticed, it is a leak.
 */
function noRealMailbox(value) {
  return value
    .split(',')
    .map((token) => {
      const t = token.trim();
      // Only a `local@domain` token is an address. A bare domain — the verified
      // sending domain, the mail domain — describes a place, not a person, and
      // rewriting it would change what the screens say without protecting anyone.
      if (!/^[^@\s,]+@[^@\s,]+$/.test(t)) return t;
      const at = t.lastIndexOf('@');
      const domain = t.slice(at + 1).replace(/\.+$/, '');
      if (/\.(test|example|invalid)$/.test(domain) || domain === 'localhost') return t;
      return `${t.slice(0, at)}@scratch.tirbeo.test`;
    })
    .join(', ');
}

if (!existsSync(SOURCE)) {
  console.error(`no ${SOURCE} to copy the shape from — the scratch file needs the same keys the real build reads`);
  process.exit(1);
}

const rows = parse(readFileSync(SOURCE, 'utf8'));
const urls = scratchUrls();

/* `--example` writes the committed twin of .env.scratch: the same keys, in the
   same order, with every value that would have been generated or read from the
   live file replaced by a placeholder. It exists so a fresh machine knows what
   the scratch environment is made of without anyone committing a shape that was
   only ever meant to be local. */
const EXAMPLE = process.argv.includes('--example');
const EXAMPLE_TARGET = join(API, '.env.scratch.example');
const PLACEHOLDER = 'set-this-locally-or-run-scripts-scratch-env-mjs';

const out = EXAMPLE
  ? [
      '# SCRATCH ENVIRONMENT — the shape of .env.scratch, committed so a fresh',
      '# machine knows which keys the scratch build reads. Never fill this in by',
      '# copying values out of .env.local: run `npm run scratch:setup`, which starts',
      '# the throwaway cluster, generates its own signing secrets, moves every',
      '# address to the .test domain that cannot be delivered to, pushes the schema',
      '# and lays down the fixture rows.',
      '',
    ]
  : [
      '# SCRATCH ONLY — generated by scripts/scratch-env.mjs, never committed.',
      '# The database is a throwaway cluster under <repo>/.scratch; every provider',
      '# credential is blank or rotated, so nothing run against this file can send',
      '# mail, bill an SMS, write to a bucket or touch the production schema.',
      '',
    ];
const seen = new Set();

const decisions = [];
for (const row of rows) {
  if (row.kind === 'raw') {
    out.push(row.line);
    continue;
  }
  const { key, value } = row;
  if (seen.has(key)) continue;
  seen.add(key);

  if (key === 'DATABASE_URL' || key === 'DIRECT_DATABASE_URL' || key === 'COCKROACH_DATABASE_URL') {
    // All three to the same cluster. A second database URL in the live file is a
    // second way to reach real rows, so it is rewritten rather than blanked —
    // whatever reads it reads scratch. Loopback TCP, not the socket, because
    // Prisma's URL parser wants a host.
    out.push(`${key}=${urls.tcp}`);
    decisions.push([key, 'rewritten → scratch cluster']);
    continue;
  }
  if (key === 'EMAIL_PROVIDER') {
    out.push('EMAIL_PROVIDER=none');
    decisions.push([key, 'forced to none — no transport, nothing leaves the machine']);
    continue;
  }
  if (key === 'NODE_ENV') {
    out.push('NODE_ENV=development');
    decisions.push([key, 'forced to development']);
    continue;
  }
  if (key in REWRITE) {
    out.push(`${key}=${REWRITE[key]}`);
    decisions.push([key, REWRITE[key] ? `rewritten → ${REWRITE[key]}` : 'blanked (a production host)']);
    continue;
  }
  if (ROTATE.includes(key)) {
    out.push(`${key}=${EXAMPLE ? PLACEHOLDER : secret()}`);
    decisions.push([key, EXAMPLE ? 'rotated: placeholder here, a real one locally' : 'rotated locally']);
    continue;
  }
  if (KEEP.has(key)) {
    let safe = noRealMailbox(value);
    // The committed twin goes one step further: a `.test` address is undeliverable
    // but still names a person, so its local part is genericised too.
    if (EXAMPLE) safe = safe.replace(/[^@\s,]+@scratch\.tirbeo\.test/g, 'someone@scratch.tirbeo.test');
    out.push(`${key}=${safe}`);
    decisions.push([key, safe === value ? 'kept (configuration, not authority)' : 'kept, address moved to .test']);
    continue;
  }
  out.push(`${key}=`);
  decisions.push([key, 'blanked — not on the keep list']);
}

for (const key of ROTATE) {
  if (seen.has(key)) continue;
  out.push(`${key}=${EXAMPLE ? PLACEHOLDER : secret()}`);
  decisions.push([key, EXAMPLE ? 'rotated: placeholder here, absent from the live file' : 'rotated locally (absent from the live file)']);
}

out.push('');
const target = EXAMPLE ? EXAMPLE_TARGET : TARGET;
writeFileSync(target, out.join('\n'), EXAMPLE ? {} : { mode: 0o600 });
console.log(EXAMPLE
  ? `wrote ${target} — committed, and no value in it opens anything\n`
  : `wrote ${target} (0600, gitignored by .env*)\n`);
for (const [key, decision] of decisions) console.log(`  ${key.padEnd(36)} ${decision}`);
console.log(`\n${decisions.length} keys. Kept: ${decisions.filter((d) => d[1].startsWith('kept')).length}, blanked: ${decisions.filter((d) => d[1].startsWith('blanked')).length}, rotated: ${decisions.filter((d) => d[1].startsWith('rotated')).length}, rewritten: ${decisions.filter((d) => d[1].startsWith('rewritten') || d[1].startsWith('forced')).length}.`);
