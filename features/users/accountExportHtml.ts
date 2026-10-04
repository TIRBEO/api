/**
 * The HTML report a person can actually read.
 *
 * The JSON archive is for machines: it is complete, and it is something you have
 * to know the shape of before it says anything. This is the same data laid out
 * for a person — every part the JSON export holds, in sections with headings, in
 * one file that opens in a browser double-clicked from the Downloads folder.
 *
 * Four rules it is built to keep:
 *
 * 1. **Standalone.** All CSS is inline in the document. No stylesheet, font,
 *    image, script or tracker is fetched, so the report reads the same offline
 *    in ten years as it does now, and opening it cannot tell anyone anything
 *    about the account.
 * 2. **Nothing new.** It renders the archive object the JSON path already
 *    produces, so it inherits that path's decisions — which columns are read,
 *    which are left out (no password, no authenticator or recovery codes, no
 *    passkey or API-key credentials, no push endpoints), which parts failed,
 *    which were truncated. A secret can't appear here that isn't in the JSON.
 * 3. **Nothing invented either.** Sections are rendered by walking the archive's
 *    own keys, so a part added to the export shows up in the report without this
 *    file being edited; a part that came back empty says so instead of being
 *    dropped quietly.
 * 4. **Nothing raw.** Every key that reaches the page goes through a label map
 *    (with a readable fallback, never a naive title-case of a DB column name),
 *    every boolean is a word, every instant is a readable date, and nested
 *    objects — notification preferences, consents, settings bags — are rendered
 *    as labelled lines, never as a JSON dump.
 *
 * The look follows the Tirbeo account app (apps/myprofile/app/globals.css):
 * a black canvas, solid one-step-above panels, hairline rules, one blue,
 * 14px cards, the system grotesque, and a light palette for people whose
 * browser asks for one.
 */

/** The archive as `exportDataHandler` assembles it (rows still real Dates). */
export type AccountExportArchive = {
  format?: string;
  exportedAt?: string | Date;
  note?: string;
  account?: Record<string, unknown>;
  security?: Record<string, unknown>;
  sections?: Record<string, unknown[] | null>;
  counts?: Record<string, number>;
  missing?: string[];
  truncated?: string[];
};

/**
 * Headings for the parts a person reads past. A key with no entry here is still
 * rendered — under its own name — because the export gaining a part must not
 * silently vanish from the report.
 */
const SECTION_LABELS: Record<string, string> = {
  account: 'Your account',
  emails: 'Email addresses',
  phone: 'Phone number',
  profile: 'Profile',
  preferences: 'Saved preferences',
  identities: 'Identity records',
  sessions: 'Sign-in sessions',
  devices: 'Devices',
  passkeys: 'Passkeys',
  logins: 'Sign-in history',
  activity: 'Activity log',
  notifications: 'Notifications',
  emailsSent: 'Emails we sent you',
  tipLogs: 'Tips shown',
  statusChanges: 'Account status changes',
  restrictions: 'Restrictions',
  appeals: 'Appeals',
  deactivation: 'Deactivation',
  deletionRequest: 'Deletion request',
  apiKeys: 'API keys',
  pushSubscriptions: 'Push channels',
  security: 'Security',
};

/**
 * Labels for the user-account columns specifically — the ones the report leads
 * with and the ones a machine-named field reads worst as. Anything not here
 * still gets a readable fallback, but never a naive title-case of the raw key.
 */
const COLUMN_LABELS: Record<string, string> = {
  // Account row
  id: 'ID',
  userId: 'User ID',
  user_id: 'User ID',
  username: 'Username',
  email: 'Email address',
  emailVerified: 'Email verified',
  email_verified: 'Email verified',
  name: 'Display name',
  photoUrl: 'Photo URL',
  photo_url: 'Photo URL',
  bannerUrl: 'Banner URL',
  banner_url: 'Banner URL',
  status: 'Account status',
  isAdmin: 'Administrator',
  is_admin: 'Administrator',
  theme: 'Theme',
  language: 'Language',
  timezone: 'Time zone',
  time_zone: 'Time zone',
  consents: 'Consents',
  notificationPreferences: 'Notification preferences',
  notification_preferences: 'Notification preferences',
  emailUnsubscribed: 'Unsubscribed from email',
  email_unsubscribed: 'Unsubscribed from email',
  is2FAEnabled: 'Two-factor enabled',
  is_banned: 'Banned',
  isBanned: 'Banned',
  isSuspended: 'Suspended',
  is_suspended: 'Suspended',
  suspendReason: 'Suspension reason',
  suspendedUntil: 'Suspended until',
  banRefCode: 'Ban reference code',
  suspendRefCode: 'Suspension reference code',
  deletedAt: 'Deleted at',
  scheduledDeletionAt: 'Deletion scheduled for',
  deletionReason: 'Deletion reason',
  lastActiveAt: 'Last active',
  lastLoginAt: 'Last sign-in',
  createdAt: 'Created at',
  created_at: 'Created at',
  updatedAt: 'Updated at',
  updated_at: 'Updated at',
  // Wider vocabulary across the other parts
  ip: 'IP address',
  ipAddress: 'IP address',
  ip_address: 'IP address',
  userAgent: 'User agent',
  user_agent: 'User agent',
  deviceName: 'Device name',
  device_name: 'Device name',
  totp: 'TOTP',
  totpEnabled: 'Authenticator app enabled',
  mustChangePassword: 'Must change password',
  mustChangePw: 'Must change password',
  backupCodesRemaining: 'Recovery codes left',
  twoFactorEnabled: 'Two-factor enabled',
  connectedAccounts: 'Connected accounts',
  phoneVerified: 'Phone verified',
  isDefault: 'Default',
  isRead: 'Read',
  isActive: 'Active',
  is_active: 'Active',
  opensNewWindow: 'Opens a new window',
  verifiedAt: 'Verified at',
  lastUsedAt: 'Last used',
  last_used_at: 'Last used',
  revokedAt: 'Revoked at',
  expiresAt: 'Expires at',
  sentAt: 'Sent at',
  openedAt: 'Opened at',
  clickedAt: 'Clicked at',
  keyPrefix: 'Key prefix',
  permissions: 'Permissions',
  transports: 'Transports',
  eventKey: 'Event key',
  toEmail: 'Sent to',
  kind: 'Kind',
  title: 'Title',
  detail: 'Detail',
  severity: 'Severity',
  metadata: 'Extra data',
  subject: 'Subject',
  provider: 'Provider',
  event: 'Event',
  category: 'Category',
  number: 'Number',
  bio: 'Bio',
  pronouns: 'Pronouns',
  gender: 'Gender',
  birthday: 'Birthday',
  location: 'Location',
  website: 'Website',
  jobRole: 'Job role',
  jobCompany: 'Company',
  jobPlace: 'Work location',
  jobStarted: 'Started working there',
  skills: 'Skills',
  followers: 'Followers',
  following: 'Following',
  appearance: 'Appearance',
  notif: 'Notification settings',
  privacy: 'Privacy',
  misc: 'Other settings',
  verifiedSource: 'Verified through',
  link: 'Link',
  body: 'Message',
  type: 'Type',
};

/**
 * The notification-preference vocabulary, from `DEFAULT_PREFS` in
 * features/notifications/notifications.ts and the email categories in
 * features/email/emailPrefs.ts. Each stored key becomes a line a person
 * recognises, with its value phrased for that key rather than as data.
 */
const PREF_LABELS: Record<string, string> = {
  email: 'All email',
  push: 'All push',
  forms: 'Forms',
  product: 'Product updates',
  support: 'Support',
  tips: 'Tips',
  offers: 'Offers and promotions',
  security: 'Security alerts (always on)',
  formsEmail: 'Forms — email',
  formsPush: 'Forms — push',
  productEmail: 'Product updates — email',
  productPush: 'Product updates — push',
  supportEmail: 'Support — email',
  supportPush: 'Support — push',
  offersEmail: 'Offers — email',
  offersPush: 'Offers — push',
  tipsEmail: 'Tips — email',
  tipsPush: 'Tips — push',
  emailPaused: 'Pause all email',
  emailPausedUntil: 'Paused until',
  summaryEnabled: 'Periodic account recap',
  summaryFrequency: 'Recap cadence',
  unsubscribed: 'Unsubscribed from',
  quietHoursEnabled: 'Quiet hours',
  quietHoursStart: 'Quiet hours start',
  quietHoursEnd: 'Quiet hours end',
  lastSummarySentAt: 'Last recap sent',
  lastDigestSentAt: 'Last digest sent',
  lastWeeklySentAt: 'Last weekly mail sent',
};

/** Cadences and other small enums, phrased. */
const PREF_VALUE_LABELS: Record<string, string> = {
  weekly: 'weekly',
  daily: 'daily',
  monthly: 'monthly',
  all: 'everything',
  product: 'product updates',
  forms: 'forms',
  support: 'support',
  tips: 'tips',
  offers: 'offers',
  digest: 'the account recap',
};

/** Consent vocabulary, from features/users/consent.ts (and the short forms a
    stored bag may use for the same choices). */
const CONSENT_LABELS: Record<string, string> = {
  allowAnalytics: 'Usage analytics',
  analytics: 'Usage analytics',
  allowCrashReports: 'Crash reports',
  crashReports: 'Crash reports',
  marketing: 'Marketing',
};

/** Words that must not be lower-cased by the readable fallback. */
const KEEP_AS_IS_WORDS: Record<string, string> = {
  url: 'URL',
  id: 'ID',
  ip: 'IP',
  otp: 'OTP',
  totp: 'TOTP',
  api: 'API',
  sms: 'SMS',
  mfa: 'MFA',
  pw: 'password',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A readable heading for any key: the explicit map first, then a fallback that
 * splits snake_case and camelCase, lower-cases every word, capitalises only the
 * first, and re-fixes acronyms. `photo_url` → `Photo URL`, never `Photo Url`;
 * an unseen column `suspended_until` → `Suspended until`, never `AdminInistrator`.
 */
function columnLabel(key: string): string {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ');
  const fixed = words
    .map((w) => KEEP_AS_IS_WORDS[w] ?? w)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
  return fixed.charAt(0).toUpperCase() + fixed.slice(1);
}

function sectionLabel(key: string): string {
  return SECTION_LABELS[key] ?? columnLabel(key);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `3 October 2026, 02:50 UTC` — readable first, with the exact instant kept in
    the machine-readable `datetime` so nothing about the wording loses precision. */
function readableTimestamp(parsed: Date): string | null {
  if (Number.isNaN(parsed.getTime())) return null;
  const day = parsed.getUTCDate();
  const month = MONTHS[parsed.getUTCMonth()];
  const year = parsed.getUTCFullYear();
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const mm = String(parsed.getUTCMinutes()).padStart(2, '0');
  const ss = String(parsed.getUTCSeconds()).padStart(2, '0');
  const clock = ss === '00' ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`;
  return `${day} ${month} ${year}, ${clock} UTC`;
}

function timestampHtml(iso: string): string {
  const parsed = new Date(iso);
  const readable = readableTimestamp(parsed);
  if (readable === null) return escapeHtml(iso);
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(readable)}</time>`;
}

/** How a boolean reads, in the tone of the structure holding it. */
function booleanPhrase(value: boolean, mode: RenderMode): string {
  if (mode === 'prefs') return value ? 'on' : 'off';
  if (mode === 'consents') return value ? 'given' : 'not given';
  return value ? 'Yes' : 'No';
}

const NOTHING_RECORDED = '<span class="none">Nothing recorded</span>';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Which vocabulary a key's value should be phrased with. */
type RenderMode = 'prefs' | 'consents' | 'plain';

function modeForKey(key: string | undefined, inherited: RenderMode): RenderMode {
  const k = (key ?? '').toLowerCase();
  if (k.includes('notif') || k.includes('preference')) return 'prefs';
  if (k.includes('consent')) return 'consents';
  return inherited;
}

function fieldLabel(key: string, mode: RenderMode): string {
  if (mode === 'prefs' && PREF_LABELS[key]) return PREF_LABELS[key];
  if (mode === 'consents' && CONSENT_LABELS[key]) return CONSENT_LABELS[key];
  return columnLabel(key);
}

/** Epoch-ms pauses and send-clocks are instants, not numbers. */
function isEpochMs(key: string, value: unknown): value is number {
  return (
    typeof value === 'number' && value > 10_000_000_000 && /(until|at)$/i.test(key)
  );
}

/**
 * One value as HTML. Dates get a `<time>`, booleans a word, and a nested object
 * or array is rendered as labelled lines — never a JSON blob, and never left
 * out. Unknown keys inside a known structure fall back to `Label — value` lines.
 */
function formatValue(value: unknown, keyHint?: string, mode: RenderMode = 'plain'): string {
  if (value === null || value === undefined || value === '') {
    return NOTHING_RECORDED;
  }
  if (value instanceof Date) {
    return timestampHtml(value.toISOString());
  }
  if (typeof value === 'boolean') {
    return `<span class="bool">${escapeHtml(booleanPhrase(value, mode))}</span>`;
  }
  if (typeof value === 'number') {
    if (mode === 'prefs' && keyHint && isEpochMs(keyHint, value)) {
      return timestampHtml(new Date(value).toISOString());
    }
    return escapeHtml(String(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ISO_TIMESTAMP.test(trimmed)) return timestampHtml(trimmed);
    if (mode === 'prefs' && PREF_VALUE_LABELS[trimmed.toLowerCase()]) {
      return escapeHtml(PREF_VALUE_LABELS[trimmed.toLowerCase()]);
    }
    return escapeHtml(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return NOTHING_RECORDED;
    const allPrimitives = value.every((item) => item === null || typeof item !== 'object');
    if (allPrimitives && value.length <= 8) {
      return value
        .map((item) => formatValue(item, keyHint, mode))
        .join('<span class="sep">, </span>');
    }
    const items = value.map((item) => `<li>${formatValue(item, keyHint, mode)}</li>`).join('');
    return `<ul class="flat">${items}</ul>`;
  }
  if (isPlainObject(value)) {
    return structuredHtml(value, modeForKey(keyHint, mode));
  }
  return escapeHtml(String(value));
}

/**
 * A nested object as readable lines: `Push — on`, `Recap cadence — weekly`,
 * `Extra data —` followed by its own lines. Empty objects say so; nothing here
 * is ever a `JSON.stringify` dump.
 */
function structuredHtml(obj: Record<string, unknown>, mode: RenderMode): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return NOTHING_RECORDED;
  const lines = entries.map(([key, value]) => {
    const label = fieldLabel(key, mode);
    const childMode = modeForKey(key, mode);
    const rendered = formatValue(value, key, childMode);
    const isBlock = rendered.startsWith('<div class="struct"') || rendered.startsWith('<ul');
    if (isBlock) {
      return `<div class="fline"><div class="fkey">${escapeHtml(label)}</div>${rendered}</div>`;
    }
    return `<div class="fline"><span class="fkey">${escapeHtml(label)}</span> <span class="fsep">—</span> <span class="fval">${rendered}</span></div>`;
  });
  return `<div class="struct">${lines.join('')}</div>`;
}

function countLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'}`;
}

/** The columns of a set: every key any row has, in the order they first appear,
    so a sparse row doesn't shave a column off the whole table. */
function columnsOf(rows: unknown[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

function tableHtml(rows: unknown[]): string {
  const plain = rows.filter(isPlainObject) as Record<string, unknown>[];
  const columns = columnsOf(plain);
  if (!columns.length) {
    // A set can hold values that aren't objects (a list of strings, say). It is
    // better shown than quietly skipped.
    const items = rows.map((row) => `<li>${formatValue(row)}</li>`).join('');
    return `<ul class="flat">${items}</ul>`;
  }
  const head = columns.map((key) => `<th scope="col">${escapeHtml(columnLabel(key))}</th>`).join('');
  const body = plain
    .map((row) => {
      const cells = columns
        .map((key) => `<td class="col-${escapeHtml(key)}">${formatValue(row[key], key)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Field/value pairs for the two sets that hold one record each. */
function definitionHtml(fields: Record<string, unknown>): string {
  const rows = Object.entries(fields)
    .map(([key, value]) => {
      const mode = modeForKey(key, 'plain');
      return `<tr><th scope="row">${escapeHtml(fieldLabel(key, mode))}</th><td>${formatValue(value, key, mode)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table class="kv"><tbody>${rows}</tbody></table></div>`;
}

function sectionHtml(key: string, rows: unknown[] | null, counts: Record<string, number>, truncated: string[]): string {
  const label = sectionLabel(key);
  const anchor = `sec-${escapeHtml(key)}`;
  const recorded = counts[key];
  const heading = `<h2>${escapeHtml(label)}</h2>`;

  if (rows === null) {
    return `<section class="card" id="${anchor}">${heading}<p class="warn">This part could not be read from your account when the file
      was written, so it is not in it. Nothing was skipped quietly: it is named here, and under
      &ldquo;What is not in this file&rdquo; below.</p></section>`;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return `<section class="card" id="${anchor}">${heading}<p class="none-block">Nothing recorded.</p>${
      typeof recorded === 'number' ? `<p class="meta">${countLabel(0)} in this part.</p>` : ''
    }</section>`;
  }
  const plural = rows.length === 1 ? 'record' : 'records';
  // The cap keeps the oldest rows of a part (rows are read oldest-first), so a
  // truncated part says which end is missing rather than implying a sample.
  const cap = truncated.includes(key)
    ? ` Capped at 10,000 records, so the newest rows of this part are not in this file.`
    : '';
  return `<section class="card" id="${anchor}">${heading}<p class="meta">${rows.length.toLocaleString('en-US')} ${plural} in this file.${cap}</p>${tableHtml(rows)}</section>`;
}

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #000000;
  --surface: #0e0e10;
  --surface-2: rgba(255, 255, 255, 0.09);
  --fg: #f5f5f5;
  --muted: #a8a8a8;
  --border: rgba(255, 255, 255, 0.13);
  --divider: rgba(255, 255, 255, 0.1);
  --accent: #0095f6;
  --accent-ink: #5cb4f9;
  --warn-bg: rgba(255, 178, 36, 0.08);
  --warn-ink: #ffc45c;
  --r-card: 14px;
  --r-control: 8px;
  --r-pill: 999px;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --surface: #ffffff;
    --surface-2: #f4f4f4;
    --fg: #1a1a1a;
    --muted: #696969;
    --border: #dbdbdb;
    --divider: #dbdbdb;
    --accent: #0064c8;
    --accent-ink: #0064c9;
    --warn-bg: #fdf4ee;
    --warn-ink: #a45c00;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2.5rem 1.25rem 5rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 var(--sans); }
main { max-width: 62rem; margin: 0 auto; }
.wordmark { font-size: 1.05rem; font-weight: 700; letter-spacing: .02em; color: var(--accent-ink);
  margin: 0 0 2rem; }
h1 { font-size: 1.6rem; font-weight: 700; margin: 0 0 .5rem; letter-spacing: -.015em; }
.intro { color: var(--muted); font-size: .95rem; margin: 0 0 1.75rem; max-width: 46rem; }
.intro strong { color: var(--fg); font-weight: 600; }
.chips { margin: 0 0 2rem; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: .5rem; }
.chips li { font-size: .8rem; }
.chips a { display: inline-block; padding: .3rem .75rem; border: 1px solid var(--border);
  border-radius: var(--r-pill); background: var(--surface); color: var(--fg); text-decoration: none; }
.chips a:hover { border-color: var(--accent); color: var(--accent-ink); }
.chips .n { color: var(--muted); }
.note { margin: 0 0 2rem; padding: 1rem 1.25rem; border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--surface); color: var(--muted); font-size: .9rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: 1.5rem 1.75rem; margin: 0 0 1.25rem; }
h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 .75rem; letter-spacing: -.01em; }
.meta { color: var(--muted); font-size: .85rem; margin: 0 0 1rem; }
.warn { margin: 0; padding: .85rem 1.1rem; border-radius: var(--r-control); background: var(--warn-bg);
  color: var(--warn-ink); font-size: .9rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--divider); vertical-align: top; }
th:last-child, td:last-child { padding-right: 0; }
th:first-child, td:first-child { padding-left: 0; }
thead th { position: sticky; top: 0; background: var(--surface); color: var(--muted);
  font-weight: 600; font-size: .78rem; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
table.kv th { width: 15rem; font-weight: 600; color: var(--muted); }
pre, code, .fval .mono { font-family: var(--mono); }
.none { color: var(--muted); font-style: italic; font-weight: 400; }
.none-block { color: var(--muted); font-style: italic; margin: 0; }
.bool { color: var(--accent-ink); }
.struct { margin: 0; }
.struct .struct { margin: .2rem 0 .35rem; padding-left: .85rem; border-left: 2px solid var(--divider); }
.fline { padding: .12rem 0; }
.fkey { color: var(--muted); font-size: .82rem; }
.fsep { color: var(--muted); }
.fval { font-size: .88rem; }
.sep { color: var(--muted); }
ul.flat { margin: 0; padding-left: 1.15rem; }
time { white-space: nowrap; }
.foot { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
  color: var(--muted); font-size: .85rem; }
.foot p { margin: 0 0 .6rem; max-width: 46rem; }
@media print { body { padding: 0; background: #fff; color: #16181d; } .card { border-color: #d8dbe2; } }
`.trim();

/**
 * Renders the archive as one standalone HTML document. Whatever the JSON export
 * holds is in here: the account row, the security summary, and every part with
 * its rows, plus the honest notes about what was missing or cut off.
 */
export function renderAccountExportHtml(archive: AccountExportArchive): string {
  const account = archive.account ?? {};
  const sections = archive.sections ?? {};
  const counts = archive.counts ?? {};
  const missing = Array.isArray(archive.missing) ? archive.missing : [];
  const truncated = Array.isArray(archive.truncated) ? archive.truncated : [];

  const exportedAtIso =
    archive.exportedAt instanceof Date
      ? archive.exportedAt.toISOString()
      : String(archive.exportedAt ?? new Date().toISOString());
  const who = String(account.username || account.name || account.email || 'this account');
  const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);

  const keys = Object.keys(sections);

  // The chips row names only the parts that hold something: a zero counting
  // chip says "Emails we sent you · 0" which is noise in a bar of them. The
  // empty parts still get their own section below, saying so in words.
  const chipKeys = keys.filter((key) => (counts[key] ?? 0) >= 1);
  const contents = chipKeys.length
    ? `<ul class="chips">${chipKeys
        .map(
          (key) =>
            `<li><a href="#sec-${escapeHtml(key)}">${escapeHtml(sectionLabel(key))} <span class="n">· ${escapeHtml(
              counts[key].toLocaleString('en-US'),
            )}</span></a></li>`,
        )
        .join('')}</ul>`
    : '';

  const body = keys.map((key) => sectionHtml(key, sections[key], counts, truncated)).join('\n');

  const notes: string[] = [];
  if (missing.length) {
    notes.push(
      `Could not be read from the account when this file was written, so not included: ${missing
        .map((key) => escapeHtml(sectionLabel(String(key))))
        .join(', ')}.`,
    );
  }
  if (truncated.length) {
    notes.push(
      `Longer than the 10,000-record cap per part, so the rows after the cap are not in this file: ${truncated
        .map((key) => escapeHtml(sectionLabel(String(key))))
        .join(', ')}.`,
    );
  }
  const notesHtml = notes.length
    ? `<section class="card" id="notes"><h2>What is not in this file</h2><p class="meta">${notes.join(' ')}</p></section>`
    : '';

  const security = archive.security ?? {};
  const securityHtml = Object.keys(security).length
    ? `<section class="card" id="security"><h2>${escapeHtml(sectionLabel('security'))}</h2>${definitionHtml(security)}</section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Tirbeo account export — ${escapeHtml(who)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="wordmark">Tirbeo</p>
<h1>Your account data</h1>
<p class="intro">Everything Tirbeo held about <strong>${escapeHtml(who)}</strong> when this report was
written, on ${timestampHtml(exportedAtIso)} — ${total.toLocaleString('en-US')} records across
${keys.length.toLocaleString('en-US')} parts. It is a complete copy of your data for you to keep;
secrets such as passwords and security keys are never part of an export.</p>
${archive.note ? `<div class="note">${escapeHtml(String(archive.note))}</div>` : ''}
${contents}
${Object.keys(account).length ? `<section class="card" id="account"><h2>${escapeHtml(sectionLabel('account'))}</h2>${definitionHtml(account)}</section>` : ''}
${securityHtml}
${body}
${notesHtml}
<footer class="foot" id="about">
  <p>This document is self-contained: the styles are in the file, and it asks nothing of a network.
  Opened in any browser it reads the same as it did the day it was made.</p>
  <p>No password, authenticator secret or recovery code, passkey or API-key credential, or push address
  is in it — those are never part of an export, in either format.</p>
</footer>
</main>
</body>
</html>
`;
}
