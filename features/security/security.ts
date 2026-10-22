import { prisma } from '@/infrastructure/db/prisma';
import type { Prisma } from '@prisma/client';
import { getRedis } from '@/features/auth/redis';
import { sendTemplateEmail } from '@/features/email/email';
import { getBranding } from '@/features/branding/branding';
import { currentRequestOrigin } from '@/infrastructure/observability/requestContext';
import { resolveLoginPlace, resolveLoginCoords } from '@/shared/geo';
import { refCodeCandidates, generateEventId, refFromRowId } from '@/features/users/refcode';
import { factPlate } from '@/features/email/email-fragments';

export type SecuritySeverity = 'info' | 'warning' | 'error' | 'critical';

export function getClientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-vercel-forwarded-for') ||
    'unknown'
  );
}

/** `getClientIp` answers 'unknown' for a header-less hop; a row should store
    no address rather than the word. */
function dropUnknown(ip: string): string | undefined {
  return ip === 'unknown' ? undefined : ip;
}

export function getRayId(request: Request): string {
  return (
    request.headers.get('cf-ray') ||
    request.headers.get('x-vercel-id') ||
    request.headers.get('x-request-id') ||
    ''
  );
}

export function getUserAgent(request: Request): string {
  return request.headers.get('user-agent') || '';
}

// ─── XSS detection ───

const XSS_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /<\s*script[\s>]/i, label: 'script_tag' },
  { regex: /<\s*\/\s*script/i, label: 'script_close' },
  { regex: /<\s*iframe[\s>]/i, label: 'iframe_tag' },
  { regex: /<\s*object[\s>]/i, label: 'object_tag' },
  { regex: /<\s*embed[\s>]/i, label: 'embed_tag' },
  { regex: /<\s*svg[\s>]/i, label: 'svg_tag' },
  { regex: /<\s*math[\s>]/i, label: 'math_tag' },
  { regex: /<\s*template[\s>]/i, label: 'template_tag' },
  { regex: /<\s*link[\s>]/i, label: 'link_tag' },
  { regex: /<\s*meta[\s>]/i, label: 'meta_tag' },
  { regex: /<\s*form[\s>]/i, label: 'form_tag' },
  { regex: /javascript\s*:/i, label: 'javascript_proto' },
  { regex: /vbscript\s*:/i, label: 'vbscript_proto' },
  { regex: /data\s*:\s*text\/html/i, label: 'data_html' },
  { regex: /on(?:error|load|click|mouseover|mouseenter|focus|blur|change|submit|pointerover|pointerenter)\s*=/i, label: 'inline_handler' },
  { regex: /style\s*=\s*["']?[^"']*(?:expression|behavior|moz-binding|@import)[^"']*["']?/i, label: 'css_expression' },
  { regex: /document\.(?:cookie|location|domain|write)/i, label: 'dom_access' },
  { regex: /window\.(?:location|top|parent)/i, label: 'window_access' },
  { regex: /alert\s*\(/i, label: 'alert_call' },
  { regex: /eval\s*\(/i, label: 'eval_call' },
  { regex: /fetch\s*\(/i, label: 'fetch_call' },
  { regex: /document\.getElementById/i, label: 'dom_query' },
  { regex: /src\s*=\s*["']?\s*\/?\/?[^"'\s>]*data:/i, label: 'src_data' },
];

export function detectXss(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return null;
  for (const { regex, label } of XSS_PATTERNS) {
    if (regex.test(str)) return label;
  }
  return null;
}

export function sanitizeInput(value: string, maxLength = 5000): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

// ─── Security event logging + admin notification ───

const notificationTimestamps: Record<string, number> = {};
const NOTIFY_THROTTLE_MS = 60_000;

/**
 * The staff an alert may go to — everyone on the roster by default, or, when a
 * `permission` is given, only the ones whose role actually holds it.
 *
 * With one admin the two are indistinguishable; with five they are not, and a
 * mail to all of them about something four of them cannot act on is how a
 * security inbox becomes noise nobody opens. The capability, not the count,
 * decides the recipient list.
 */
export async function getAdminUsers(permission?: string) {
  // A dynamic import, not a top-level one: `features/auth/staff` pulls in the
  // audit writer, which reaches back here for the security-event shape.
  const { listStaff, listStaffWithPermission } = await import('@/features/auth/staff');
  const staff = permission ? await listStaffWithPermission(permission) : await listStaff();
  return staff
    .filter((s) => !!s.email)
    .map((s) => ({
      id: s.userId,
      email: s.email as string,
      username: s.username,
      name: s.name,
      roleName: s.role ?? 'admin' }));
}

export type AdminAlert = {
  subject: string;
  message: string;
  details: string;
  severity?: SecuritySeverity;
  /** The incident's own handle, when one exists — the code the account was
     shown, the reference on the request being reported. Passing it means the
     alert row carries that code too, so one quote answers with both sides of
     the same incident instead of opening a second, unrelated one. */
  refCode?: string | null;
};

/**
 * The mail's variables and the log row's metadata, built once from an alert.
 *
 * The reference is minted here and goes into BOTH — that is the whole point of
 * it. A code a mail shows that the log does not carry is a code nobody can look
 * up, and the details are rendered from the caller's `Label: value` lines into
 * the plate the admin reads, so what lands in the inbox is the same set of facts
 * the row keeps.
 */
async function buildAdminAlert(input: AdminAlert, recipients: number) {
  const { getApiOrigin } = await import('@/features/branding/branding');
  const dashboardUrl = `${getApiOrigin().replace('api.', 'admin.')}`;
  const branding = await getBranding();
  const refCode = input.refCode?.trim() || generateEventId('system');
  const severity = input.severity || 'warning';

  return {
    refCode,
    vars: {
      // The severity is the log's business, not the subject line's. A reader
      // opening `[warning] Account holder disputed a sign-in` has to parse a
      // label before the sentence, and every alert is a warning to somebody.
      subject: input.subject,
      refCode,
      message: input.message,
      details: factPlate(await detailRows(input.details)),
      dashboardUrl,
      brandName: branding.brandName,
      logoUrl: branding.logoUrl,
    },
    // No sender override here: an admin alert is security mail, and the
    // mailbox and name the security category gives it (security@tirbeo.com,
    // "Tirbeo Security") is exactly what should show in the admin's inbox.
    options: { rawVars: ['details'] },
    row: {
      kind: 'admin.alert',
      title: input.subject,
      detail: input.message,
      severity,
      metadata: {
        message: input.message,
        details: input.details,
        severity,
        refCode,
        notifiedAdmins: recipients,
        dashboardUrl,
      },
    },
  };
}

/**
 * One admin-facing mail to one named address — the alert's shape for a mail that
 * goes to a person rather than to the whole admin list. The row is written with
 * the code, so the address it was sent to can quote something findable.
 */
export async function sendAdminAlert(to: string, input: AdminAlert): Promise<void> {
  try {
    const alert = await buildAdminAlert(input, 1);
    await Promise.all([
      prisma.activityEvent.create({ data: alert.row as never })
        .catch((e: unknown) => console.error('[SECURITY] Failed to record admin alert row:', e instanceof Error ? e.message : e)),
      sendTemplateEmail(to, 'admin_alert', alert.vars, alert.options).catch(() => {}),
    ]);
  } catch (e) {
    console.error('[SECURITY] Failed to send admin alert:', e instanceof Error ? e.message : e);
  }
}

/**
 * Someone reached the admin panel without the right to be there.
 *
 * Three doors can refuse that way — the password step, the 2FA step, and the
 * session refresh — and each had written its own list of facts, so one said the
 * device and another said only an IP. One builder means every refusal arrives
 * with the same thing an admin needs to decide: whose account, when, on what,
 * from where.
 */
export async function alertAdminPanelAttempt(
  headers: Headers,
  email: string,
): Promise<void> {
  const { deviceDetail } = await import('@/features/notifications/notifications');
  const ip = (headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const device = deviceDetail(headers.get('user-agent'));
  const place = resolveLoginPlace(headers);
  await sendAdminAlert(email, {
    subject: 'Admin panel access attempt',
    message: 'An account without admin rights reached the admin panel and was refused.',
    details: [
      `Account: ${email}`,
      `When: ${new Date().toISOString()}`,
      device ? `Device: ${device}` : '',
      place ? `Location: ${place}` : '',
      ip ? `Address: ${ip}` : '',
    ].filter(Boolean).join('\n'),
    severity: 'warning',
  });
}

/**
 * Who a staff mail goes to: every account whose role holds `permission`, plus
 * the shared mailbox this installation reads alerts in, when it named one.
 *
 * The shared address exists because a team of four does not want four copies of
 * one page in four inboxes. What it must not become is the *only* address: a
 * mailbox one person owns is undeliverable the day that person leaves, cannot be
 * scoped to whoever is able to act, and is not a domain this platform can verify
 * as a sender. So the alias is a copy everyone on the team can see, and the role
 * is still what decides who is on the team.
 */
export async function staffRecipients(permission: string): Promise<string[]> {
  const staff = await getAdminUsers(permission);
  const shared = (process.env.STAFF_ALERT_EMAIL || '').trim().toLowerCase();
  const out = new Set<string>(staff.map((s) => s.email.toLowerCase()));
  if (shared) out.add(shared);
  return [...out];
}

export async function notifyAdmins(input: AdminAlert): Promise<void> {
  try {
    const emails = await staffRecipients('security.read');
    if (emails.length === 0) return;

    const dedupeKey = `${input.subject}:${input.details.slice(0, 80)}`;
    const now = Date.now();
    if (notificationTimestamps[dedupeKey] && now - notificationTimestamps[dedupeKey] < NOTIFY_THROTTLE_MS) {
      return;
    }
    notificationTimestamps[dedupeKey] = now;

    const alert = await buildAdminAlert(input, emails.length);

    /* The alert is written down before the mail goes out, so the panel shows it
       while the inbox is still catching up. Waiting for the mail to land made
       the panel look quiet at exactly the moment it should have been loud: the
       one screen an operator is watching is the one that was slowest. The two
       run side by side, and a failed write never blocks the mail — the row is
       the fast copy, the mail is the one that reaches a phone. */
    await Promise.all([
      prisma.activityEvent.create({ data: alert.row as never }).catch((e: unknown) => {
        console.error('[SECURITY] Failed to record admin alert row:', e instanceof Error ? e.message : e);
      }),
      ...emails.map(email =>
        sendTemplateEmail(email, 'admin_alert', alert.vars, alert.options).catch(() => {})
      ),
    ]);
  } catch (e) {
    console.error('[SECURITY] Failed to notify admins:', e instanceof Error ? e.message : e);
  }
}

/**
 * Staff's copy of a support request — a conversation, not an alert.
 *
 * The request already has its record: the ledger row the handler wrote, under
 * the code the account was just quoted. What the mail has to do is make the
 * answer possible from the inbox — the message in full, whose account it is,
 * where a reply reaches them, and what it arrived on — so it goes out on the
 * request's own template and writes no second row. The generic alert made this
 * mail a blob of `Label:` lines under somebody else's headline.
 */
export async function notifyAdminsOfSupportRequest(input: {
  refCode: string;
  subject: string;
  message: string;
  /** Where an answer has to go — the mailbox the person actually reads. */
  replyTo: string;
  /** The address the account signs in with: the sender when the provider will
      accept it, the Account row when it will not. */
  identity: string | null;
  senderName: string;
  receivedAt: Date;
  device: string | null;
  location: string | null;
  ip: string | null;
}): Promise<void> {
  try {
    // Whoever can answer a request, not whoever can open the console: a
    // moderator on holiday should not decide whether this one gets a reply.
    const recipients = await staffRecipients('tickets.answer');
    if (recipients.length === 0) return;

    const { supportSender } = await import('@/features/email/email');
    const { getApiOrigin } = await import('@/features/branding/branding');
    const sender = supportSender(input.identity, input.senderName);
    const origin = [input.ip, input.location].filter(Boolean).join(' · ');
    const dashboardUrl = `${getApiOrigin().replace('api.', 'admin.')}`;
    // An account with no address on file still deserves an answer, so the one
    // action in the mail changes shape rather than going dead.
    const contact = input.replyTo || 'an address we cannot see';
    /* Not a mailto. A reply typed into whatever mail client the alert happened
       to be opened in answers the person but writes nothing down: no row
       beside the request, no notification on the account, no record of the
       answer on either side. The panel's reply box is the one door that does
       all three, so this button goes there and quotes the code it is about. */
    const replyHref = `${dashboardUrl}/admin/tickets/${encodeURIComponent(input.refCode)}`;

    await Promise.all(recipients.map(email =>
      sendTemplateEmail(email, 'support_request_admin', {
        subject: input.subject,
        senderName: input.senderName,
        contact,
        account: input.identity || contact,
        receivedAt: input.receivedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        device: input.device || 'Not recorded',
        origin: origin || 'Not recorded',
        refCode: input.refCode,
        message: input.message,
        dashboardUrl,
        replyHref,
        replyLabel: 'Answer in the admin panel',
      }, {
        ...sender,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        threadId: input.refCode,
        // Staff's own queue is not a marketing channel: an admin who muted
        // product mail still has to see the message they are being asked to
        // answer.
        skipSuppression: true,
      }).catch(() => {}),
    ));
  } catch (e) {
    console.error('[SECURITY] Failed to notify admins of a support request:', e instanceof Error ? e.message : e);
  }
}

export async function logSecurityEvent(input: {
  request?: Request;
  userId?: string | null;
  eventType: string;
  severity?: SecuritySeverity;
  details?: Record<string, unknown>;
  notifyAdmin?: boolean;
}): Promise<string | null> {
  /* The context wins over the raw request whenever one was set. That order is
     the whole point of checking it first: for a call relayed through another of
     our services, the request's own forwarding and geo headers belong to the
     relay hop — preferring them wrote the relay's datacentre as the owner's
     machine and city. The context has already applied the trust rules at the
     door: a verified relay speaks for the browser it carried, an unverifiable
     one for nobody, and once the door has answered, falling back to the raw
     headers would only resurrect the hop's lie. */
  const ctx = currentRequestOrigin();
  const ip = ctx
    ? ctx.ip ?? undefined
    : input.request
      ? dropUnknown(getClientIp(input.request))
      : undefined;
  const rayId = input.request ? getRayId(input.request) : undefined;
  const userAgent = ctx
    ? ctx.userAgent ?? undefined
    : input.request
      ? getUserAgent(input.request)
      : undefined;

  const metadata: Record<string, unknown> = { ...(input.details || {}) };
  if (rayId) metadata.rayId = rayId;
  /* The address the edge saw, so a security event reads as "from Pokhara, Nepal"
     rather than as a bare IP. Whatever the caller passed in wins; a write from a
     job with no request at all leaves the place out instead of inventing one. */
  const place = ctx
    ? ctx.location
    : input.request
      ? resolveLoginPlace(input.request.headers)
      : null;
  const coords = ctx
    ? ctx.coords
    : input.request
      ? resolveLoginCoords(input.request.headers)
      : null;
  if (place && metadata.location === undefined) metadata.location = place;
  if (coords && metadata.coords === undefined) metadata.coords = coords;

  // The created activity row's id, returned so a caller can surface a
  // reference (e.g. the "Ref: XXXXXXXX" on a 429 screen). Null when the write
  // failed — callers must handle the no-id case (most ignore it entirely).
  let eventId: string | null = null;
  try {
    // user_id is nullable since the anonymous-events change, so every security
    // event lands as a queryable row — pre-account flows (signup OTP, magic
    // link, telemetry) write with userId null and stay attributable later via
    // ip/metadata.
    const row = await prisma.activityEvent.create({
      data: {
        userId: input.userId ?? null,
        kind: input.eventType,
        title: humanizeEventType(input.eventType),
        detail: input.details?.reason ? String(input.details.reason).slice(0, 500) : null,
        severity: input.severity || 'info',
        ipAddress: ip,
        userAgent: userAgent,
        metadata: (metadata || {}) as Prisma.InputJsonValue,
      },
    });
    eventId = row?.id ?? null;
  } catch (e) {
    console.error('[SECURITY] Failed to log event:', e instanceof Error ? e.message : e);
  }

  if (input.notifyAdmin || input.severity === 'critical') {
    const subject = humanizeEventType(input.eventType);
    await notifyAdmins({
      subject,
      message: `${subject} — ${input.details?.reason ? String(input.details.reason) : 'A security event was detected.'}`,
      details: buildDetailsString({ ...input.details, ip, rayId, userId: input.userId || 'anonymous' }),
      severity: input.severity || 'warning',
    });
  }

  return eventId;
}

/**
 * A rate-limit trip becomes a real, queryable activity row. Returns the
 * created event's id (null if the write failed) so the caller can echo it back
 * on the 429 as `eventId` — a client shows "Ref: XXXXXXXX" and staff can look
 * that id up in the security log (listSecurityEvents matches by event id).
 *
 * Privacy: the caller passes the email DOMAIN only, never the full address, and
 * a short "hint" describing which limit bucket tripped (e.g. the key's prefix),
 * not the raw key with a full email/IP embedded.
 */
export async function logRateLimited(input: {
  request?: Request;
  userId?: string | null;
  /** Which endpoint/action tripped the limit, e.g. 'auth/login'. */
  action: string;
  /** Email domain only — never the local part or full address. */
  emailDomain?: string | null;
  /** Short, non-identifying hint at the limit bucket key shape. */
  keyHint?: string;
  /** Epoch ms when the window resets (RateLimitResult.reset seconds → ms). */
  resetsAt?: number | null;
}): Promise<string | null> {
  return logSecurityEvent({
    request: input.request,
    userId: input.userId ?? null,
    eventType: 'security.rate_limited',
    severity: 'warning',
    details: {
      action: input.action,
      emailDomain: input.emailDomain ?? null,
      keyHint: input.keyHint ?? null,
      resetsAt: input.resetsAt ? new Date(input.resetsAt).toISOString() : null,
      reason: 'rate_limited',
    },
  });
}

/** Extract just the domain of an email — the only part safe to persist on a
    rate-limit row (the full address stays out of the event log). */
export function emailDomainOf(email?: string | null): string | null {
  if (!email) return null;
  const at = String(email).indexOf('@');
  return at > 0 ? String(email).slice(at + 1).toLowerCase() : null;
}

/** Event kinds are written for machines — `security.password_changed`. A
    record a person reads wants the other half of that name: the namespace it
    sits under tells them nothing, and the snake_case is not how anyone
    sentences. */
export function humanizeEventType(type: string): string {
  const leaf = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type;
  return leaf
    .replace(/[_-]+/g, ' ')
    .replace(/\b2fa\b/gi, 'two-factor')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function buildDetailsString(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${stringify(v)}`)
    .join('\n');
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    // A JSON dump reads as noise at mail width. Flatten one level into pairs,
    // which is what the alert plate renders anyway.
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? entries.map(([k, v]) => `${k}=${stringify(v)}`).join(', ') : '';
  }
  return String(value);
}

// ═══════════════════════════════════════════════════════════════════
// THE ADMIN'S READ — labels, values, and what is worth showing at all
// ═══════════════════════════════════════════════════════════════════
//
// An alert mail is one screen a person scans on a phone in a corridor. The row
// in the log keeps every raw field; the mail shows what a human can act on:
// labelled lines, a date a date looks like, an address instead of an id, and
// nothing where the log had nothing.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const NOT_A_VALUE = new Set(['unknown', 'an unknown device', 'an unrecognized device', 'anonymous', 'null', 'undefined', 'n/a', 'none', 'not given', '-']);

/** `user_agent` → `User agent`, `ipAddress` → `Ip address`, and a line that
    was never labelled gets no label rather than a invented one. */
function labelize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeValue(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (NOT_A_VALUE.has(value.toLowerCase())) return '';
  if (ISO_SHAPE.test(value) || /^\d{13}$/.test(value)) {
    const when = new Date(value);
    if (!Number.isNaN(when.getTime())) {
      return when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    }
  }
  if (value === 'true' || value === 'false') return value === 'true' ? 'yes' : 'no';
  return value;
}

/** A uuid is a handle for a query, not a fact about a person. Name the account
    it belongs to when one exists; otherwise the code the panel shows for the
    row, which is at least short enough to read aloud. */
async function readableId(value: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(value)) return cache.get(value)!;
  let out = '';
  try {
    const found = await prisma.user.findUnique({
      where: { id: value },
      select: {
        profile: { select: { name: true } },
        emails: { where: { kind: 'primary' }, select: { address: true }, take: 1 },
      } });
    const address = found?.emails?.[0]?.address;
    if (address) out = found?.profile?.name ? `${found.profile.name} (${address})` : address;
  } catch { /* fall through to the row-code form */ }
  if (!out) out = refFromRowId(value) ?? value;
  cache.set(value, out);
  return out;
}

async function detailRows(details: string): Promise<Array<[string, string]>> {
  const cache = new Map<string, string>();
  const rows: Array<[string, string]> = [];
  for (const line of String(details || '').split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    const label = at === -1 ? '' : labelize(line.slice(0, at));
    const raw = at === -1 ? line : line.slice(at + 1);
    const value = UUID_SHAPE.test(raw.trim())
      ? humanizeValue(await readableId(raw.trim(), cache))
      : humanizeValue(raw);
    if (value) rows.push([label || 'Detail', value]);
  }
  return rows;
}

// ─── Blocklist management (IP / user / target blocks) ───

const ipBlockCache = new Map<string, { blocked: boolean; expires: number }>();
const IP_BLOCK_CACHE_TTL = 15_000;
// Hard deadline for the blocklist lookup. This check runs on EVERY
// authenticated request — without a timeout, one DB/network stall turns
// every route into a multi-minute hang (seen as "proxy.ts: 16min" logs).
const IP_BLOCK_TIMEOUT_MS = 1_500;

/** Race a promise against a deadline; resolves null on timeout. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

interface BlockEntry {
  targetType: string;
  targetId: string;
  reason?: string;
  blockedBy?: string | null;
  isActive: boolean;
  expiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

const BLOCKLIST_REDIS_KEY = 'blocklist';

async function redisBlockLookup(field: string): Promise<BlockEntry | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await withDeadline(redis.hget(BLOCKLIST_REDIS_KEY, field) as Promise<string | null>, IP_BLOCK_TIMEOUT_MS);
    if (!raw) return null;
    return JSON.parse(raw) as BlockEntry;
  } catch {
    return null;
  }
}

/** True when a block entry is active now (flag set and not past expiry). */
function isEntryActive(entry: BlockEntry): boolean {
  return entry.isActive !== false && (!entry.expiresAt || new Date(entry.expiresAt) >= new Date());
}

function blockRowToEntry(row: {
  targetType: string; targetId: string; reason: string | null; blockedBy: string | null;
  isActive: boolean | null; expiresAt: Date | null; createdAt: Date; updatedAt: Date;
}): BlockEntry {
  return {
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason ?? undefined,
    blockedBy: row.blockedBy ?? null,
    isActive: row.isActive !== false,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** DB blocklist lookup. Returns the row, `null` for a definite "no row", or
 *  `undefined` when the query failed (DB outage) so callers can fall back. */
async function dbBlockLookup(targetType: string, targetId: string): Promise<BlockEntry | null | undefined> {
  try {
    const row = await prisma.blocklist.findUnique({ where: { targetType_targetId: { targetType, targetId } } });
    return row ? blockRowToEntry(row) : null;
  } catch {
    return undefined;
  }
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!ip || ip === 'unknown') return false;
  const cached = ipBlockCache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.blocked;
  const dbRow = await dbBlockLookup('ip', ip);
  // DB outage: trust the Redis cache, don't poison the in-process cache.
  if (dbRow === undefined) {
    const r = await redisBlockLookup(`ip:${ip}`);
    return r ? isEntryActive(r) : false;
  }
  let blocked = dbRow ? isEntryActive(dbRow) : false;
  // Not blocked per DB: honor a Redis-only entry (legacy ban written before the
  // DB path existed) so the transition never silently un-blocks someone.
  if (!blocked) {
    const r = await redisBlockLookup(`ip:${ip}`);
    if (r && isEntryActive(r)) blocked = true;
  }
  ipBlockCache.set(ip, { blocked, expires: Date.now() + IP_BLOCK_CACHE_TTL });
  if (ipBlockCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of ipBlockCache) {
      if (v.expires <= now) ipBlockCache.delete(k);
    }
  }
  return blocked;
}

export async function blockTarget(input: {
  targetType: 'ip' | 'user' | 'email';
  targetId: string;
  reason: string;
  blockedBy?: string;
  expiresAt?: Date | null;
}): Promise<void> {
  const expiresAt = input.expiresAt ?? null;
  // Postgres is the source of truth; Redis is only a fast read cache. Blocking
  // therefore works with no Redis configured (it used to throw).
  try {
    await prisma.blocklist.upsert({
      where: { targetType_targetId: { targetType: input.targetType, targetId: input.targetId } },
      update: { reason: input.reason, blockedBy: input.blockedBy ?? null, isActive: true, expiresAt },
      create: {
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        blockedBy: input.blockedBy ?? null,
        isActive: true,
        expiresAt,
      },
    });
  } catch (dbErr) {
    // DB down: fall back to Redis so a block still lands when it is configured;
    // with neither store reachable the caller must see the failure.
    const redis = getRedis();
    if (!redis) throw dbErr;
    const now = new Date().toISOString();
    const entry: BlockEntry = {
      targetType: input.targetType, targetId: input.targetId, reason: input.reason,
      blockedBy: input.blockedBy || null, isActive: true,
      expiresAt: expiresAt ? expiresAt.toISOString() : null, createdAt: now, updatedAt: now,
    };
    await redis.hset(BLOCKLIST_REDIS_KEY, `${input.targetType}:${input.targetId}`, JSON.stringify(entry));
    if (input.targetType === 'ip') ipBlockCache.delete(input.targetId);
    return;
  }
  // Mirror to Redis when configured (best-effort; a cache miss just reads DB).
  const redis = getRedis();
  if (redis) {
    const now = new Date().toISOString();
    const entry: BlockEntry = {
      targetType: input.targetType, targetId: input.targetId, reason: input.reason,
      blockedBy: input.blockedBy || null, isActive: true,
      expiresAt: expiresAt ? expiresAt.toISOString() : null, createdAt: now, updatedAt: now,
    };
    await redis.hset(BLOCKLIST_REDIS_KEY, `${input.targetType}:${input.targetId}`, JSON.stringify(entry)).catch(() => {});
  }
  if (input.targetType === 'ip') ipBlockCache.delete(input.targetId);
}

export async function unblockTarget(targetType: string, targetId: string): Promise<void> {
  try {
    await prisma.blocklist.delete({ where: { targetType_targetId: { targetType, targetId } } });
  } catch (dbErr) {
    const redis = getRedis();
    if (!redis) throw dbErr;
  }
  const redis = getRedis();
  if (redis) await redis.hdel(BLOCKLIST_REDIS_KEY, `${targetType}:${targetId}`).catch(() => {});
  if (targetType === 'ip') ipBlockCache.delete(targetId);
}

export async function listBlocks(options: {
  page?: number;
  limit?: number;
  targetType?: string;
  activeOnly?: boolean;
  search?: string;
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, options.limit || 50);
  const where: Record<string, unknown> = {};
  if (options.targetType) where.targetType = options.targetType;
  if (options.activeOnly) where.isActive = true;
  if (options.search) {
    where.OR = [
      { targetId: { contains: options.search, mode: 'insensitive' } },
      { reason: { contains: options.search, mode: 'insensitive' } },
    ];
  }

  // Postgres is the source of truth. On a DB outage fall back to the Redis hash
  // so the admin list still renders.
  try {
    const [rows, total] = await Promise.all([
      prisma.blocklist.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.blocklist.count({ where: where as any }),
    ]);
    const items = rows.map((r: any) => blockRowToEntry(r));
    return { items, total, page, limit };
  } catch {
    return listBlocksFromRedis(options, page, limit);
  }
}

async function listBlocksFromRedis(options: {
  page?: number; limit?: number; targetType?: string; activeOnly?: boolean; search?: string;
}, page: number, limit: number) {
  const redis = getRedis();
  if (!redis) return { items: [], total: 0, page, limit };
  const all: Record<string, string> = await redis.hgetall(BLOCKLIST_REDIS_KEY).catch(() => ({}));
  let entries = Object.values(all || {}).map((raw) => {
    try { return JSON.parse(raw) as BlockEntry & { users?: unknown }; } catch { return null; }
  }).filter((e): e is BlockEntry & { users?: unknown } => !!e);
  if (options.targetType) entries = entries.filter((e) => e.targetType === options.targetType);
  if (options.activeOnly) entries = entries.filter((e) => e.isActive !== false);
  if (options.search) {
    const q = options.search.toLowerCase();
    entries = entries.filter((e) =>
      e.targetId.toLowerCase().includes(q) || (e.reason || '').toLowerCase().includes(q));
  }
  entries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const total = entries.length;
  const items = entries.slice((page - 1) * limit, page * limit);

  return { items, total, page, limit };
}

// ─── Security events query ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listSecurityEvents(options: {
  page?: number;
  limit?: number;
  eventType?: string;
  severity?: string;
  id?: string;
  ip?: string;
  userId?: string;
  from?: string;
  to?: string;
  q?: string;
  includeUser?: boolean;
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(200, options.limit || 50);
  const where: Record<string, unknown> = {};
  if (options.id) {
    // The `id` filter accepts BOTH shapes staff actually paste: the event's
    // own uuid, and the user-facing reference code (xxxx-xxxx-xxxx) shown on
    // ban/suspend screens and quoted in security emails — which lives in
    // metadata.refCode of the activity row (mirrored from
    // user_status_events.metadata.refCode at enforcement time). A value that
    // isn't a uuid but parses as a ref code matches the uuid exactly, or any
    // stored refCode candidate shape (canonical, plain-hex, legacy 8-char and
    // SUS-/BAN- prefixed forms).
    const isUuid = UUID_RE.test(options.id);
    const candidates = isUuid ? [] : refCodeCandidates(options.id);
    if (candidates.length) {
      where.OR = [
        { id: options.id },
        ...candidates.map((c) => ({ id: c })),
        ...candidates.map((c) => ({ metadata: { path: ['refCode'], equals: c } })),
      ];
    } else {
      where.id = options.id;
    }
  }
  if (options.eventType) where.kind = options.eventType;
  if (options.severity) where.severity = options.severity;
  if (options.ip) where.ipAddress = { contains: options.ip };
  if (options.userId) where.userId = options.userId;
  /* One search box, the way an operator thinks: a fragment of an address, a
     fragment of a kind, a piece of an account id, or the row's own id. The
     console's search has always meant all four at once, and answering it with
     only one of them would quietly narrow what an operator can find. */
  if (options.q) {
    const q = options.q.trim();
    if (q) {
      const parts: Record<string, unknown>[] = [
        { kind: { contains: q } },
        { ipAddress: { contains: q } },
        { userId: { contains: q } },
        { id: q },
      ];
      // A pasted ref code (xxxx-xxxx-xxxx) is not a uuid, so it is matched
      // through the same candidate list the id filter uses.
      const candidates = UUID_RE.test(q) ? [] : refCodeCandidates(q);
      if (candidates.length) {
        parts.push({ id: { in: candidates } });
        parts.push({ metadata: { path: ['refCode'], equals: q } });
      }
      // A search widens the other filters rather than replacing them, so
      // "severity: warning" plus a fragment still means both.
      const narrowed = where.OR;
      where.OR = parts;
      if (narrowed) where.AND = [{ OR: narrowed }];
    }
  }
  if (options.from || options.to) {
    const createdAt: Record<string, Date> = {};
    if (options.from) createdAt.gte = new Date(options.from);
    if (options.to) createdAt.lte = new Date(options.to);
    where.createdAt = createdAt;
  }

  const queryOptions: any = {
    where: where as any,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
  };
  queryOptions.select = { id: true, userId: true, kind: true, title: true, detail: true, severity: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true };

  /* `includeUser` was read by the route and then dropped on the floor, so every
     caller that asked who an event happened to was handed a user id and nothing
     else. An operator reading a queue of bare uuids cannot act on it, so the
     parameter now does what its name says. */
  if (options.includeUser !== false) {
    queryOptions.select.user = {
      select: {
        email: true,
        username: true,
        isAdmin: true,
        profile: { select: { name: true } },
      },
    };
  }

  const [rows, total] = await Promise.all([
    prisma.activityEvent.findMany(queryOptions),
    prisma.activityEvent.count({ where: where as any }),
  ]);
  const events = rows.map((e: any) => ({ ...e, eventType: e.kind }));

  return { events, total, page, limit };
}

export async function getSecurityStats() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const count = async (gte: Date) => prisma.activityEvent.count({ where: { createdAt: { gte } } });
  const criticalCount = (gte: Date) => prisma.activityEvent.count({ where: { createdAt: { gte }, severity: { in: ['error', 'critical'] } } });

  const redis = getRedis();
  const [todayTotal, weekTotal, monthTotal, total, todayCritical, weekCritical, monthCritical, blockHash, recentEvents] = await Promise.all([
    count(startOfDay), count(startOfWeek), count(startOfMonth), prisma.activityEvent.count(),
    criticalCount(startOfDay), criticalCount(startOfWeek), criticalCount(startOfMonth),
    redis ? redis.hgetall(BLOCKLIST_REDIS_KEY).catch(() => ({})) : Promise.resolve({}),
    prisma.activityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  const activeBlocks = Object.values(blockHash || {}).filter((raw: any) => {
    try { const e = JSON.parse(raw); return e.isActive !== false && (!e.expiresAt || new Date(e.expiresAt) >= new Date()); } catch { return false; }
  }).length;

  return {
    today: { total: todayTotal, critical: todayCritical },
    week: { total: weekTotal, critical: weekCritical },
    month: { total: monthTotal, critical: monthCritical },
    total,
    activeBlocks,
    recent: recentEvents,
  };
}

// ─── Record login history ────────────────────────────────────────
// login_history was consolidated into security_events (the single auth-event
// log): a login is event_type 'login' / 'login_failed'. Call sites keep using
// this helper so the write shape stays consistent across every auth path.
export async function recordLoginHistory(input: {
  request?: Request;
  userId: string;
  email: string;
  success: boolean;
  method: string;
}): Promise<void> {
  try {
    /* Same order as logSecurityEvent: once the door has checked the trust
       rules, its answer wins over the request's raw headers, because on a
       relayed call those headers describe the relay, not the person signing
       in. */
    const ctx = currentRequestOrigin();
    const rawIp = ctx
      ? ctx.ip ?? undefined
      : input.request
        ? getClientIp(input.request)
        : undefined;
    const ip = rawIp === 'unknown' ? undefined : rawIp;
    const userAgent = ctx
      ? ctx.userAgent ?? undefined
      : input.request
        ? getUserAgent(input.request)
        : undefined;
    /* The sign-in list reads this column, so a login has to say where it came
       from and not only from which address. */
    const location = ctx
      ? ctx.location
      : input.request
        ? resolveLoginPlace(input.request.headers)
        : null;
    await prisma.userLogin.create({
      data: {
        userId: input.userId,
        method: input.method,
        success: input.success,
        ipAddress: ip || null,
        userAgent: userAgent || null,
        location,
      },
    });
    if (!input.success) {
      await prisma.activityEvent.create({
        data: {
          userId: input.userId,
          kind: 'login_failed',
          title: 'Failed login',
          detail: input.email,
          severity: 'warning',
          ipAddress: ip || null,
          userAgent: userAgent || null,
          metadata: { method: input.method },
        },
      }).catch(() => {});
    }
  } catch (e) {
    console.error('[LOGIN_HISTORY] Failed to record:', e instanceof Error ? e.message : e);
  }
}
