import { prisma } from './db/prisma';
import type { Prisma } from '@prisma/client';
import { sendTemplateEmail } from './email';
import { getBranding } from './branding';

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
  const assignments = await prisma.userRole.findMany({
    where: { role: { name: { in: ['admin', 'super_admin'] } } },
    include: { user: { select: { id: true, email: true, name: true } }, role: { select: { name: true } } },
  });
  return assignments
    .map(a => ({ ...a.user, roleName: a.role.name }))
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

    const { getApiOrigin } = await import('./branding');
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
}): Promise<void> {
  const ip = input.request ? getClientIp(input.request) : undefined;
  const rayId = input.request ? getRayId(input.request) : undefined;
  const userAgent = input.request ? getUserAgent(input.request) : undefined;

  const metadata: Record<string, unknown> = { ...(input.details || {}) };
  if (rayId) metadata.rayId = rayId;

  try {
    await prisma.securityEvent.create({
      data: {
        userId: input.userId || null,
        eventType: input.eventType,
        severity: input.severity || 'info',
        ipAddress: ip,
        userAgent: userAgent,
        metadata: (metadata || {}) as Prisma.InputJsonValue,
      },
    });
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
}

function humanizeEventType(type: string): string {
  return type
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function buildDetailsString(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
}

// ─── Blocklist management (IP / user / target blocks) ───

export async function isIpBlocked(ip: string): Promise<boolean> {
  if (!ip || ip === 'unknown') return false;
  try {
    const entry = await prisma.blocklist.findUnique({
      where: { targetType_targetId: { targetType: 'ip', targetId: ip } },
    });
    if (!entry || entry.isActive === false) return false;
    if (entry.expiresAt && entry.expiresAt < new Date()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function blockTarget(input: {
  targetType: 'ip' | 'user' | 'email';
  targetId: string;
  reason: string;
  blockedBy?: string;
  expiresAt?: Date | null;
}): Promise<void> {
  await prisma.blocklist.upsert({
    where: { targetType_targetId: { targetType: input.targetType, targetId: input.targetId } },
    update: {
      reason: input.reason,
      blockedBy: input.blockedBy || null,
      isActive: true,
      expiresAt: input.expiresAt || null,
      updatedAt: new Date(),
    },
    create: {
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      blockedBy: input.blockedBy || null,
      isActive: true,
      expiresAt: input.expiresAt || null,
    },
  });
}

export async function unblockTarget(targetType: string, targetId: string): Promise<void> {
  await prisma.blocklist.updateMany({
    where: { targetType, targetId },
    data: { isActive: false, updatedAt: new Date() },
  });
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
      { targetId: { contains: options.search } },
      { reason: { contains: options.search } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.blocklist.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { users: { select: { id: true, email: true, name: true } } },
    }),
    prisma.blocklist.count({ where: where as any }),
  ]);

  return { items, total, page, limit };
}

// ─── Security events query ───

export async function listSecurityEvents(options: {
  page?: number;
  limit?: number;
  eventType?: string;
  severity?: string;
  ip?: string;
  userId?: string;
  from?: string;
  to?: string;
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(200, options.limit || 50);
  const where: Record<string, unknown> = {};
  if (options.eventType) where.eventType = options.eventType;
  if (options.severity) where.severity = options.severity;
  if (options.ip) where.ipAddress = { contains: options.ip };
  if (options.userId) where.userId = options.userId;
  if (options.from || options.to) {
    const createdAt: Record<string, Date> = {};
    if (options.from) createdAt.gte = new Date(options.from);
    if (options.to) createdAt.lte = new Date(options.to);
    where.createdAt = createdAt;
  }

  const [events, total] = await Promise.all([
    prisma.securityEvent.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    prisma.securityEvent.count({ where: where as any }),
  ]);

  return { events, total, page, limit };
}

export async function getSecurityStats() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const count = async (gte: Date) => prisma.securityEvent.count({ where: { createdAt: { gte } } });
  const criticalCount = (gte: Date) => prisma.securityEvent.count({ where: { createdAt: { gte }, severity: { in: ['error', 'critical'] } } });

  const [todayTotal, weekTotal, monthTotal, total, todayCritical, weekCritical, monthCritical, activeBlocks, recentEvents] = await Promise.all([
    count(startOfDay), count(startOfWeek), count(startOfMonth), prisma.securityEvent.count(),
    criticalCount(startOfDay), criticalCount(startOfWeek), criticalCount(startOfMonth),
    prisma.blocklist.count({ where: { isActive: true } }),
    prisma.securityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return {
    today: { total: todayTotal, critical: todayCritical },
    week: { total: weekTotal, critical: weekCritical },
    month: { total: monthTotal, critical: monthCritical },
    total,
    activeBlocks,
    recent: recentEvents,
  };
}
