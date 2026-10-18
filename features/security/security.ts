import { prisma } from '@/infrastructure/db/prisma';
import type { Prisma } from '@prisma/client';
import { getRedis } from '@/features/auth/redis';
import { sendTemplateEmail } from '@/features/email/email';
import { getBranding } from '@/features/branding/branding';
import { currentRequestOrigin } from '@/infrastructure/observability/requestContext';
import { resolveLoginPlace, resolveLoginCoords } from '@/shared/geo';
import { refCodeCandidates } from '@/features/users/refcode';

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

export function scanForXss(values: unknown[]): string | null {
  for (const v of values) {
    const hit = detectXss(v);
    if (hit) return hit;
  }
  return null;
}

export function stripXss(value: string): string {
  return value
    .replace(/<\s*\/?\s*(script|iframe|object|embed|svg|math|link|meta|form|template)[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(javascript|vbscript|data:text\/html)\s*:/gi, 'blocked:')
    .trim();
}

export function sanitizeInput(value: string, maxLength = 5000): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

/**
 * Sanitize user-authored custom CSS for a form's <style> tag. Strips anything
 * that could escape the stylesheet (HTML/JS) while keeping valid CSS rules.
 */
export function sanitizeCss(value: string, maxLength = 20000): string {
  let css = String(value || '').slice(0, maxLength);
  // No HTML or tag-closing tokens — CSS must never be able to break out.
  css = css.replace(/[<>]/g, '');
  // Block script-y constructs and dangerous url() based beacons (data:).
  css = css.replace(/expression\s*\(/gi, 'none(');
  css = css.replace(/(javascript|vbscript)\s*:/gi, 'blocked:');
  css = css.replace(/@import\b/gi, '@noimport');
  css = css.replace(/url\s*\(\s*['"]?(data|javascript|vbscript)\s*:/gi, 'url(blocked:');
  return css;
}

/**
 * Sanitize user-authored custom HTML (the `custom-html` field type) to a safe
 * subset. Strips script-bearing tags and event handlers, blocks dangerous URL
 * schemes and only keeps an allow-list of tags/attributes. Never trusted on its
 * own — the renderer still escapes through React's dangerouslySetInnerHTML.
 */
const SAFE_HTML_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span', 'img', 'hr', 'div', 'small',
  'sub', 'sup', 'mark', 'del', 'ins', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const SAFE_HTML_ATTRS = new Set(['href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'class', 'style', 'colspan', 'rowspan']);
const SAFE_HTML_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

export function sanitizeHtml(value: string, maxLength = 50000): string {
  let html = String(value || '').slice(0, maxLength);
  // Remove script-bearing containers and anything that can leak JS entirely.
  html = html.replace(/<\s*\/*\s*(script|iframe|frame|object|embed|style|link|meta|form|template|svg|math|noscript|base|input|button|textarea|select|option|source)[^>]*>/gi, ' ');
  // Drop event handlers and null/obvious hooks.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s(style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/(javascript|vbscript|data:text\/html|data:image\/svg\+xml)\s*:/gi, 'blocked:');
  // Re-tokenize tags and drop anything not on the allow-list.
  html = html.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (match, close, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!SAFE_HTML_TAGS.has(name)) return '';
    const cleaned = String(attrs).replace(/([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (am, attrName, rawVal) => {
      const n = attrName.toLowerCase();
      if (!SAFE_HTML_ATTRS.has(n)) return '';
      const v = String(rawVal).replace(/^["']|["']$/g, '');
      if ((n === 'href' || n === 'src') && v) {
        const scheme = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (scheme && !SAFE_HTML_SCHEMES.has(scheme[1].toLowerCase()) && !v.startsWith('/') && !v.startsWith('#')) return '';
        if (n === 'src' && scheme && scheme[1].toLowerCase() !== 'https' && !v.startsWith('/')) return '';
      }
      return ` ${n}="${v.replace(/"/g, '&quot;')}"`;
    });
    return `<${close}${name}${cleaned}>`;
  });
  return html;
}

export function sanitizeJsonStrings<T>(value: T, maxLength = 5000): T {
  if (typeof value === 'string') return sanitizeInput(value, maxLength) as unknown as T;
  if (Array.isArray(value)) return value.map(v => sanitizeJsonStrings(v, maxLength)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeJsonStrings(v, maxLength);
    }
    return out as unknown as T;
  }
  return value;
}

// ─── Security event logging + admin notification ───

const notificationTimestamps: Record<string, number> = {};
const NOTIFY_THROTTLE_MS = 60_000;

export async function getAdminUsers() {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: {
      id: true, username: true,
      profile: { select: { name: true } },
      emails: { where: { kind: 'primary' }, select: { address: true }, take: 1 },
    },
  });
  return admins
    .map(a => ({ ...a, email: a.emails[0]?.address ?? null, name: a.profile?.name ?? null, roleName: 'admin' }))
    .filter(u => u.email);
}

export async function notifyAdmins(input: {
  subject: string;
  message: string;
  details: string;
  severity?: SecuritySeverity;
}): Promise<void> {
  try {
    const admins = await getAdminUsers();
    if (admins.length === 0) return;

    const dedupeKey = `${input.subject}:${input.details.slice(0, 80)}`;
    const now = Date.now();
    if (notificationTimestamps[dedupeKey] && now - notificationTimestamps[dedupeKey] < NOTIFY_THROTTLE_MS) {
      return;
    }
    notificationTimestamps[dedupeKey] = now;

    const { getApiOrigin } = await import('@/features/branding/branding');
    const dashboardUrl = `${getApiOrigin().replace('api.', 'admin.')}`;
    const branding = await getBranding();

    const htmlDetails = input.details
      .split('\n')
      .map(l => `<p style="margin:2px 0;font-size:13px;color:#5f6368;">${l.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])}</p>`)
      .join('');

    await Promise.all(admins.map(admin =>
      sendTemplateEmail(admin.email, 'admin_alert', {
        subject: `[${input.severity || 'alert'}] ${input.subject}`,
        message: input.message,
        details: htmlDetails,
        dashboardUrl,
        brandName: branding.brandName,
        logoUrl: branding.logoUrl,
      }, { fromName: branding.emailFromName, rawVars: ['details'] }).catch(() => {})
    ));
  } catch (e) {
    console.error('[SECURITY] Failed to notify admins:', e instanceof Error ? e.message : e);
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
  const ip = input.request ? getClientIp(input.request) : currentRequestOrigin()?.ip ?? undefined;
  const rayId = input.request ? getRayId(input.request) : undefined;
  const userAgent = input.request ? getUserAgent(input.request) : currentRequestOrigin()?.userAgent ?? undefined;

  const metadata: Record<string, unknown> = { ...(input.details || {}) };
  if (rayId) metadata.rayId = rayId;
  /* The address the edge saw, so a security event reads as "from Pokhara, Nepal"
     rather than as a bare IP. Whatever the caller passed in wins; a write from a
     job with no request at all leaves the place out instead of inventing one. */
  const ctx = currentRequestOrigin();
  const place = (input.request ? resolveLoginPlace(input.request.headers) : null) ?? ctx?.location ?? null;
  const coords = (input.request ? resolveLoginCoords(input.request.headers) : null) ?? ctx?.coords ?? null;
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
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
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
    const ctx = currentRequestOrigin();
    const ip = input.request ? getClientIp(input.request) : ctx?.ip ?? undefined;
    const userAgent = input.request ? getUserAgent(input.request) : ctx?.userAgent ?? undefined;
    /* The sign-in list reads this column, so a login has to say where it came
       from and not only from which address. */
    const location = (input.request ? resolveLoginPlace(input.request.headers) : null)
      ?? ctx?.location ?? null;
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
