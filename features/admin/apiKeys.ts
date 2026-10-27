import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { hashPassword } from '@/features/auth/password';
import { ALL_PERMISSION_KEYS } from '@/features/auth/roles';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';

/* Machine credentials.
 *
 * Read the honesty note before the code: nothing in this product accepts one of
 * these yet. `getSession` in `features/auth/http-guards.ts` reads the session
 * cookie and a bearer JWT, and no path reads `api_keys`. What this module
 * provides is the record and its lifecycle — mint, list, revoke — and the
 * console has to say so on the screen rather than present a key that unlocks
 * nothing as if it did. A feature whose number one job is to open a door is not
 * a feature to leave ambiguous.
 *
 * What is stored: an argon2id hash of the secret and an eight-character prefix
 * of the clear text. The prefix exists so two keys can be told apart on a list
 * — it is not a lookup that can be brute-forced, because it is a slice of a
 * 186-bit value and the hash beside it costs 64 MB to test. The clear secret is
 * returned exactly once, in the response that created the row, and is in no
 * read thereafter.
 */

const SECRET_MARKER = 'tk_live_';
const MAX_LIMIT = 200;

const scopeSchema = z.array(z.string().trim().min(1)).max(ALL_PERMISSION_KEYS.length);

function newSecret() {
  // base64url of 24 random bytes: 32 characters, no padding, safe to paste into
  // a header, a query string or a .env without quoting.
  return SECRET_MARKER + randomBytes(24).toString('base64url');
}

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string | null;
};

const KEY_SELECT = {
  id: true, name: true, prefix: true, scopes: true, createdAt: true,
  lastUsedAt: true, lastUsedIp: true, revokedAt: true, revokedBy: true, createdBy: true,
} as const;

/** Scopes are catalogue permission keys — `people.read`, not an invented verb.
 *  A machine credential that means "can read accounts" is the same sentence the
 *  console already uses for a person, so a screen can show one list of what is
 *  allowed rather than two that disagree about what "read" covers. */
function shape(row: {
  id: string; name: string; prefix: string; scopes: unknown; createdAt: Date;
  lastUsedAt: Date | null; lastUsedIp: string | null; revokedAt: Date | null;
  revokedBy: string | null; createdBy: string | null;
}): ApiKeyRow {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [],
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy ?? null,
    createdBy: row.createdBy ?? null,
  };
}

function pageArgs(search: URLSearchParams) {
  const page = Math.max(1, Number(search.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Number(search.get('size')) || Number(search.get('limit')) || 25);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function listApiKeys(request: NextRequest) {
  const session = await requirePermission(request, 'keys.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { page, limit, skip, take } = pageArgs(p);
  const showRevoked = p.get('revoked');

  const where: Record<string, unknown> = {};
  if (showRevoked === 'only') where.revokedAt = { not: null };
  else if (showRevoked !== 'all') where.revokedAt = null;

  const [rows, total] = await Promise.all([
    prisma.apiKey.findMany({ where: where as any, select: KEY_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.apiKey.count({ where: where as any }),
  ]);

  return NextResponse.json({
    keys: rows.map(shape),
    total,
    page,
    limit,
    // Said here rather than left to a caption, because a list of credentials
    // that no code path reads is the kind of thing a screen should not be able
    // to present as though it were enforcing something.
    enforced: false,
    note: 'Nothing authenticates with these keys yet: minting one opens no door.',
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: scopeSchema.default([]),
});

export async function createApiKey(request: NextRequest) {
  const session = await requirePermission(request, 'keys.manage');
  if (session instanceof NextResponse) return session;

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A key needs a name, and the permission keys it may act as.' }, { status: 400 });
  }
  const known = new Set(ALL_PERMISSION_KEYS);
  const unknown = parsed.data.scopes.filter((scope) => !known.has(scope));
  if (unknown.length) {
    // Refused, not dropped — the same rule the staff-role delta follows. A key
    // scoped to `people.everything` would silently mean nothing.
    return NextResponse.json({ error: `Unknown permission: ${unknown.join(', ')}` }, { status: 400 });
  }

  const secret = newSecret();
  const prefix = secret.slice(SECRET_MARKER.length, SECRET_MARKER.length + 8);
  const secretHash = await hashPassword(secret);

  let created;
  try {
    created = await prisma.apiKey.create({
      data: { name: parsed.data.name, prefix, secretHash, scopes: parsed.data.scopes, createdBy: session.userId },
      select: KEY_SELECT,
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
    // Two keys sharing eight characters of a 186-bit secret is not a bug in the
    // caller, it is a birthday coincidence; mint again rather than refuse.
    const retry = newSecret();
    created = await prisma.apiKey.create({
      data: {
        name: parsed.data.name,
        prefix: retry.slice(SECRET_MARKER.length, SECRET_MARKER.length + 8),
        secretHash: await hashPassword(retry),
        scopes: parsed.data.scopes,
        createdBy: session.userId,
      },
      select: KEY_SELECT,
    });
    return await minted(retry, shape(created), session);
  }

  return await minted(secret, shape(created), session);
}

/** The one place that answers a successful mint, so there is exactly one shape
 *  that carries a clear secret and it is easy to grep for. */
async function minted(
  secret: string,
  row: ApiKeyRow,
  session: { userId: string; email: string },
) {
  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.api_key_created',
    severity: 'warning',
    targetType: 'api_key',
    targetId: row.id,
    // Prefix and scopes only. An audit row that could reproduce a credential
    // turns the ledger into the thing the credential was hashed to protect.
    metadata: { name: row.name, prefix: row.prefix, scopes: row.scopes, actorEmail: session.email },
  });

  return NextResponse.json({
    key: row,
    secret,
    shownOnce: true,
    note: 'Copy this now. It is stored hashed, and no later read can show it again.',
  }, { status: 201 });
}

export async function revokeApiKey(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'keys.manage');
  if (session instanceof NextResponse) return session;

  const body = (await request.json().catch(() => ({}))) as any;
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;

  const existing = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, name: true, prefix: true, revokedAt: true } });
  if (!existing) return NextResponse.json({ error: 'No such key.' }, { status: 404 });
  if (existing.revokedAt) {
    // An honest second answer to the same request. Revoking twice is what a
    // retry looks like, and "ok" on a row that changed nothing is how an
    // operator comes to distrust the list.
    return NextResponse.json({ error: `“${existing.name}” was already revoked.`, alreadyRevoked: true }, { status: 409 });
  }

  const row = await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date(), revokedBy: session.userId },
    select: KEY_SELECT,
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.api_key_revoked',
    severity: 'warning',
    targetType: 'api_key',
    targetId: id,
    metadata: { name: existing.name, prefix: existing.prefix, reason, actorEmail: session.email },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ ok: true, key: shape(row) });
}
