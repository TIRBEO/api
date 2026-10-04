import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyReauthToken } from '@/features/auth/jwt';
import { verifyPassword } from '@/features/auth/password';
import { verifyTotp } from '@/features/auth/totp';
import { checkWindowLimitDB } from '@/features/captcha/risk';
import { getSession } from '@/features/auth/http-guards';
import { consumeReauthCode, issueReauthCode, signInEmailOf } from '@/features/auth/reauthCode';
import { OTP_TTL_MINUTES } from '@/features/status/accountLifecycle';
import { maskEmail } from '@/features/auth/recovery-email';

/**
 * Re-authentication proof for sensitive actions (disable 2FA, revoke all
 * sessions, delete passkeys). A stolen session cookie alone must not suffice.
 *
 * Accepted proofs, checked in order:
 *   1. passkey  — `reauthToken`: the ≤5-min JWT from the WebAuthn
 *                 reauth-options/reauth-verify flow (userVerification required)
 *   2. password — `password`: verified against the user's password hash;
 *                 failures are rate-limited (5 per 15 min per user)
 *   3. code     — `reauthCode`: the 6-digit code emailed to the account's
 *                 sign-in address (POST /api/auth/reauth/send-code). The door
 *                 for accounts that have no password and no passkey/TOTP —
 *                 without it they could not complete a sensitive action at all
 *   4. totp     — `totpCode`/`code` (body or ?code= query): a valid 6-digit
 *                 TOTP code doubles as the proof, preserving the legacy
 *                 disable-2FA UX
 *
 * `reauthCode` is deliberately its own field: `code` has meant TOTP since the
 * legacy flow and still does.
 *
 * The request body is read exactly once here and returned to the caller so
 * handlers don't double-consume it.
 */

export type ReauthMethod = 'passkey' | 'password' | 'totp' | 'code' | 'none';

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

/** What a wrong/spent emailed code answers with. `reauthCode` is the field. */
const INVALID_REAUTH_CODE = {
  error: 'INVALID_CODE',
  message: 'That code is wrong or has been used. Ask for a new one.',
};

function reauthRequired(methods: ReauthMethod[]): ReauthFail {
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
 * Which proofs this account can actually produce.
 *
 * The 403 used to answer `['passkey','password','totp']` unconditionally, so
 * the client rendered a password box for an OAuth account with no password and
 * a passkey prompt for an account with no passkey — every option a dead end.
 * Now each door is listed only if the thing that opens it exists, and the
 * emailed code is offered whenever the account has a sign-in address.
 *
 * Every lookup is `.catch()`-ed: this feeds an error message, and a DB hiccup
 * here must narrow the choices, not throw away the caller's action.
 */
export async function availableReauthMethods(userId: string): Promise<ReauthMethod[]> {
  return (await proofOptions(userId)).methods;
}

/** The methods list for the 403, plus whether the account has a real second
 *  factor at all — "it has none" is what the anti-lockout fallback keys on. */
async function proofOptions(userId: string): Promise<{ methods: ReauthMethod[]; hasSecondFactor: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      security: { select: { totpSecret: true } },
      _count: { select: { passkeys: true } },
    },
  }).catch(() => null);

  const hasSecondFactor =
    !!user && (!!user.passwordHash || !!user.security?.totpSecret || (user._count?.passkeys ?? 0) > 0);

  const methods: ReauthMethod[] = [];
  if ((user?._count?.passkeys ?? 0) > 0) methods.push('passkey');
  if (user?.passwordHash) methods.push('password');
  if (user?.security?.totpSecret) methods.push('totp');
  if (await signInEmailOf(userId).catch(() => null)) methods.push('code');

  return { methods, hasSecondFactor };
}

/**
 * POST /api/auth/reauth/send-code — mail a 6-digit code to the account's
 * sign-in address so it can prove identity for a sensitive action.
 *
 * The code is never echoed back, only the masked address it went to (the house
 * masking, same as forgot-password), so the response is useless to anybody
 * reading it over a shoulder and tells an attacker nothing about whether the
 * address exists — this endpoint is session-authenticated, so it never can.
 */
export async function reauthSendCodeHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const email = await signInEmailOf(session.userId);
    if (!email) {
      return NextResponse.json(
        { error: 'NO_EMAIL', message: 'There is no sign-in email on this account to send a code to.' },
        { status: 400 },
      );
    }

    const issued = await issueReauthCode(session.userId, email);
    if (!issued.ok) {
      // Same wording the deletion code uses — one sentence, seconds in it.
      const secs = Math.ceil(issued.remainingMs / 1000);
      const msg = `Please wait ${secs}s before requesting another code.`;
      return NextResponse.json({ error: msg, message: msg }, { status: 429 });
    }

    // Its own template: the login mail says "finish signing in", and this code
    // isn't a sign-in — it's a confirmation inside a session the person already
    // has. Awaited, and its answer believed: a refusal the provider never
    // accepted must not be reported to the reader as "check your inbox".
    const { sendTemplateEmail } = await import('@/features/email/email');
    const sent = await sendTemplateEmail(email, 'reauth_otp', {
      otp: issued.code,
      lifetimeMinutes: String(OTP_TTL_MINUTES),
    }).catch((e: any) => ({ success: false, error: e?.message || 'mail send failed' }));
    if (!sent.success) {
      console.error('[REAUTH OTP]', sent.error);
      return NextResponse.json(
        { error: 'The code could not be sent right now. Please try again, or use another method.', message: 'The code could not be sent right now. Please try again, or use another method.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      email: maskEmail(email),
      message: `A code was sent to ${maskEmail(email)}. It expires in 15 minutes.`,
    });
  } catch (err: any) {
    console.error('[REAUTH SEND CODE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to send the code' }, { status: 500 });
  }
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

/**
 * `opts.body` is for a handler that already read the body for its own reasons
 * (which provider to unlink, say). Without it the guard would be the second
 * reader of a stream that can only be read once, and the caller's action would
 * be refused forever with `REAUTH_BODY_UNREADABLE`.
 */
export async function requireReauth(
  request: NextRequest,
  sessionUserId: string,
  opts: { allowTotp?: boolean; body?: any } = {},
): Promise<ReauthResult> {
  if (opts.body !== undefined) return checkProof(request, opts.body, sessionUserId, opts);

  let body: any = {};
  try {
    body = await request.json();
  } catch (err: any) {
    // No body at all (a bare DELETE) is a missing proof, handled below. A body
    // the handler already consumed is a bug in that handler: its own read won
    // here, so the proof it meant to send is invisible and the caller would be
    // told to verify themselves forever. Say which it is.
    if (/already been read/i.test(String(err?.message))) {
      console.error('[REAUTH] request body was read before the proof could be checked');
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'REAUTH_BODY_UNREADABLE', message: 'Something went wrong verifying your identity. Please try again.' },
          { status: 500 },
        ),
      };
    }
    /* no/invalid body — query fallback below */
  }

  return checkProof(request, body, sessionUserId, opts);
}

/** The proofs, checked in the order the guard accepts them, against a body that
 *  has already been read — by `requireReauth` above, or by the handler itself. */
async function checkProof(
  request: NextRequest,
  body: any,
  sessionUserId: string,
  opts: { allowTotp?: boolean },
): Promise<ReauthResult> {
  // 1) Passkey reauth proof
  const reauthToken = typeof body?.reauthToken === 'string' ? body.reauthToken : undefined;
  if (reauthToken) {
    const sub = await verifyReauthToken(reauthToken);
    if (sub === sessionUserId) return { ok: true, method: 'passkey', body };
    const methods = await availableReauthMethods(sessionUserId);
    return reauthRequired(opts.allowTotp === false ? methods.filter((m) => m !== 'totp') : methods);
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

  // 3) Emailed-code proof. Checked before TOTP and independently of
  //    `allowTotp`, because it is not a second factor the account configured —
  //    it is the mailbox the account signs in with, and it is the only door an
  //    account whose passkey is gone has left.
  const reauthCode = typeof body?.reauthCode === 'string' ? body.reauthCode.trim() : undefined;
  if (reauthCode) {
    // A wrong shape can't be the code we sent, and must not spend an attempt on
    // the live one.
    if (!/^\d{6}$/.test(reauthCode)) {
      return { ok: false, response: NextResponse.json(INVALID_REAUTH_CODE, { status: 400 }) };
    }
    if (await consumeReauthCode(sessionUserId, reauthCode).catch(() => false)) {
      return { ok: true, method: 'code', body };
    }
    return {
      ok: false,
      response: NextResponse.json(INVALID_REAUTH_CODE, { status: 400 }),
    };
  }

  // 4) TOTP proof (legacy disable-2FA flow sends ?code=)
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
    const security = await prisma.userSecurity.findUnique({
      where: { userId: sessionUserId },
      select: { totpSecret: true },
    });
    if (security?.totpSecret && (await verifyTotp(totpCode, security.totpSecret))) {
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
  const { methods, hasSecondFactor: hasFactor } = await proofOptions(sessionUserId);
  if (!hasFactor) return { ok: true, method: 'none', body };

  // Otherwise ask, and ask honestly: only the doors this account can open.
  return reauthRequired(methods);
}
