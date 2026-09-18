import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyReauthToken } from '@/features/auth/jwt';
import { verifyPassword } from '@/features/auth/password';
import { verifyTotp } from '@/features/auth/totp';
import { checkWindowLimitDB } from '@/features/captcha/risk';
import { getSession } from '@/features/auth/http-guards';

/**
 * Re-authentication proof for sensitive actions (disable 2FA, revoke all
 * sessions, delete passkeys). A stolen session cookie alone must not suffice.
 *
 * Accepted proofs, checked in order:
 *   1. passkey  — `reauthToken`: the ≤5-min JWT from the WebAuthn
 *                 reauth-options/reauth-verify flow (userVerification required)
 *   2. password — `password`: verified against the user's password hash;
 *                 failures are rate-limited (5 per 15 min per user)
 *   3. totp     — `totpCode`/`code` (body or ?code= query): a valid 6-digit
 *                 TOTP code doubles as the proof, preserving the legacy
 *                 disable-2FA UX
 *
 * The request body is read exactly once here and returned to the caller so
 * handlers don't double-consume it.
 */

export type ReauthMethod = 'passkey' | 'password' | 'totp' | 'none';

export type ReauthOk = {
  ok: true;
  method: ReauthMethod;
  /** Parsed JSON body (or {}) — reuse this instead of request.json(). */
  body: any;
};

export type ReauthFail = {
  ok: false;
  response: NextResponse;
};

export type ReauthResult = ReauthOk | ReauthFail;

const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MAX_ATTEMPTS = 5;

function reauthRequired(methods: ReauthMethod[] = ['passkey', 'password', 'totp']): ReauthFail {
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: 'REAUTH_REQUIRED',
        message: 'Verify your identity to continue.',
        methods,
      },
      { status: 403 },
    ),
  };
}

/**
 * POST /api/auth/reauth/verify — validate a password or TOTP proof without
 * performing any action. Used by the client dialog to confirm identity
 * before re-running the sensitive call with the same proof attached.
 */
export async function reauthVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const result = await requireReauth(request, session.userId);
    if ('response' in result) return result.response;
    return NextResponse.json({ ok: true, method: result.method });
  } catch (err: any) {
    console.error('[REAUTH VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

export async function requireReauth(
  request: NextRequest,
  sessionUserId: string,
  opts: { allowTotp?: boolean } = {},
): Promise<ReauthResult> {
  let body: any = {};
  try { body = await request.json(); } catch { /* no/invalid body — query fallback below */ }

  // 1) Passkey reauth proof
  const reauthToken = typeof body?.reauthToken === 'string' ? body.reauthToken : undefined;
  if (reauthToken) {
    const sub = await verifyReauthToken(reauthToken);
    if (sub === sessionUserId) return { ok: true, method: 'passkey', body };
    return reauthRequired(['passkey', 'password', ...(opts.allowTotp === false ? [] : ['totp' as ReauthMethod])]);
  }

  // 2) Password proof
  const password = typeof body?.password === 'string' ? body.password : undefined;
  if (password) {
    const user = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { passwordHash: true },
    });
    if (user?.passwordHash && (await verifyPassword(user.passwordHash, password))) {
      return { ok: true, method: 'password', body };
    }
    // Failed password — rate limit before revealing anything.
    const allowed = await checkWindowLimitDB(`reauth:pw:${sessionUserId}`, PASSWORD_MAX_ATTEMPTS, PASSWORD_WINDOW_MS).catch(() => true);
    if (!allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'REAUTH_RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
          { status: 429 },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json({ error: 'INVALID_PASSWORD', message: 'Incorrect password. Please try again.' }, { status: 400 }),
    };
  }

  // 3) TOTP proof (legacy disable-2FA flow sends ?code=)
  const totpCode =
    (typeof body?.totpCode === 'string' && body.totpCode) ||
    (typeof body?.code === 'string' && body.code) ||
    request.nextUrl?.searchParams.get('code') ||
    undefined;
  if (totpCode && opts.allowTotp !== false) {
    if (typeof totpCode !== 'string' || totpCode.length !== 6) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'INVALID_CODE', message: 'Invalid code. Enter a 6-digit code.' }, { status: 400 }),
      };
    }
    const user = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { totpSecret: true },
    });
    if (user?.totpSecret && (await verifyTotp(totpCode, user.totpSecret))) {
      return { ok: true, method: 'totp', body };
    }
    return {
      ok: false,
      response: NextResponse.json({ error: 'INVALID_CODE', message: 'Invalid code. Please try again.' }, { status: 400 }),
    };
  }

  // No proof supplied. If the account has NO possible second factor (no
  // password, no passkeys, no TOTP), demanding one would hard-lock the
  // account — allow the action and mark the proof absent.
  const user = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { passwordHash: true, totpSecret: true, _count: { select: { passkeys: true } } },
  }).catch(() => null);
  const hasFactor =
    !!user && (!!user.passwordHash || !!user.totpSecret || user._count.passkeys > 0);
  if (!hasFactor) return { ok: true, method: 'none', body };

  return reauthRequired();
}
