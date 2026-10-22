import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyReauthToken } from '@/features/auth/jwt';
import { verifyPassword } from '@/features/auth/password';
import { verifyTotp } from '@/features/auth/totp';
import { checkWindowLimitDB } from '@/features/captcha/risk';
import { isRequire2FA, secondFactorBlocker } from '@/features/auth/second-factor';
import { getSession } from '@/features/auth/http-guards';
import { consumeReauthCode, issueReauthCode, signInEmailOf } from '@/features/auth/reauthCode';
import { OTP_TTL_MINUTES } from '@/features/status/accountLifecycle';
import { maskEmail } from '@/features/auth/recovery-email';

/**
 * Re-authentication proof for sensitive actions (disable 2FA, revoke all
 * sessions, delete passkeys). A stolen session cookie alone must not suffice.
 *
 * Accepted proofs:
 *   1. passkey  — `reauthToken`: the ≤5-min JWT from the WebAuthn
 *                 reauth-options/reauth-verify flow (userVerification required).
 *                 One ceremony opens the whole door.
 *   2. totp     — `totpCode`/`code` (body or ?code= query): a valid 6-digit
 *                 authenticator code, honored on its own while the account has
 *                 NOT switched on "require 2FA" — preserving the legacy
 *                 disable-2FA UX where the code is both the proof and the
 *                 thing being switched off.
 *   3. the chain — every door the account actually has, walked in order and
 *                 all of it required, one combined body:
 *                   `password`   first, when the account has a password
 *                   `reauthCode` next — the 6-digit code emailed to the
 *                                account's sign-in address (POST
 *                                /api/auth/reauth/send-code)
 *                   `totp`       last, when the account switched on "require
 *                                2FA for sensitive actions" WITH an
 *                                authenticator enrolled (a backup code rides
 *                                in place of the app code)
 *
 * The chain is what the "require 2FA for sensitive actions" toggle means, and
 * it generalizes: an account with a password owes the password AND the emailed
 * code, not one or the other. One proof being wrong (or absent) answers 403
 * `REAUTH_REQUIRED` with `methods` — the ordered chain this account must walk —
 * and the client sheet collects every step before re-running the action with
 * the whole proof in one body. Links are checked in order, so a wrong password
 * never spends a live emailed code.
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

/**
 * Fire-and-forget activity row for a consumed re-auth proof:
 * auth.reauth_verified (info, with the method) when a sensitive action gets
 * its proof, auth.reauth_failed (warning) when a presented proof is wrong.
 * Dynamic import keeps this module's static graph light (and the unit tests
 * hermetic) — a logging failure must never sink the guarded action.
 */
function logReauthProof(
  request: NextRequest,
  userId: string,
  outcome: 'verified' | 'failed',
  method: ReauthMethod,
  reason?: string,
): void {
  import('@/features/security/security')
    .then(({ logSecurityEvent }) => logSecurityEvent({
      request,
      userId,
      eventType: outcome === 'verified' ? 'auth.reauth_verified' : 'auth.reauth_failed',
      severity: outcome === 'verified' ? 'info' : 'warning',
      details: { method, ...(reason ? { reason } : {}) } }))
    .catch(() => {});
}

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

/**
 * The ordered chain THIS account must walk: every door it has, all of them,
 * password first, then the emailed code, then the authenticator when the
 * "require 2FA for sensitive actions" toggle is on with an app enrolled
 * (`isRequire2FA` asks both columns, so the toggle stays inert without one).
 * An empty chain means nothing can be demanded — see the `none` fallback.
 */
async function requiredFactors(userId: string): Promise<ReauthMethod[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      security: { select: { totpSecret: true, totpEnabled: true } },
    },
  }).catch(() => null);

  const factors: ReauthMethod[] = [];
  if (user?.passwordHash) factors.push('password');
  if (await signInEmailOf(userId).catch(() => null)) factors.push('code');
  if (user?.security?.totpSecret && (await isRequire2FA(userId).catch(() => false))) factors.push('totp');
  return factors;
}

/** The doors this account can open, which is also the answer to the one
 *  question the caller asks: is there any proof it could give at all. */
async function proofOptions(userId: string): Promise<{ methods: ReauthMethod[]; hasSecondFactor: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      security: { select: { totpSecret: true, totpEnabled: true } },
      _count: { select: { passkeys: true } },
    },
  }).catch(() => null);

  const methods: ReauthMethod[] = [];
  if ((user?._count?.passkeys ?? 0) > 0) methods.push('passkey');
  if (user?.passwordHash) methods.push('password');
  // The secret survives disabling 2FA — only an *enabled* authenticator is a
  // door. Offering it against a switched-off second factor confuses the
  // person with a tab that has no meaning.
  if (user?.security?.totpEnabled && user?.security?.totpSecret) methods.push('totp');
  if (await signInEmailOf(userId).catch(() => null)) methods.push('code');

  // The emailed code counts. Listing it as a door and then waving the account
  // past it would mean a passwordless account — the common OAuth one — could
  // do every sensitive thing with nothing but the cookie it already had.
  return { methods, hasSecondFactor: methods.length > 0 };
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
  // 1) Passkey reauth proof — one ceremony opens the whole door.
  const reauthToken = typeof body?.reauthToken === 'string' ? body.reauthToken : undefined;
  if (reauthToken) {
    const sub = await verifyReauthToken(reauthToken);
    if (sub === sessionUserId) {
      logReauthProof(request, sessionUserId, 'verified', 'passkey');
      return { ok: true, method: 'passkey', body };
    }
    logReauthProof(request, sessionUserId, 'failed', 'passkey', 'token_invalid_or_mismatched');
    return reauthRequired(await requiredFactors(sessionUserId));
  }

  // 2) A volunteered authenticator code, honored on its own while the 2FA
  //    policy is OFF: the legacy disable-2FA flow (?code=, totpCode, body.code)
  //    treats the code as both the proof and the thing being switched off.
  //    With the policy ON the code is a chain link instead, checked in order
  //    below — which is what "require 2FA for sensitive actions" means.
  const totpCode =
    (typeof body?.totpCode === 'string' && body.totpCode) ||
    (typeof body?.code === 'string' && body.code) ||
    request.nextUrl?.searchParams.get('code') ||
    undefined;
  if (totpCode && opts.allowTotp !== false && !(await isRequire2FA(sessionUserId))) {
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
      logReauthProof(request, sessionUserId, 'verified', 'totp');
      return { ok: true, method: 'totp', body };
    }
    logReauthProof(request, sessionUserId, 'failed', 'totp', 'invalid_code');
    return {
      ok: false,
      response: NextResponse.json({ error: 'INVALID_CODE', message: 'Invalid code. Please try again.' }, { status: 400 }),
    };
  }

  // 3) The chain: every door this account has, all of them, in order. Links
  //    are checked one at a time — and spent one at a time, so a wrong
  //    password never burns the live emailed code that rides with it.
  const required = await requiredFactors(sessionUserId);
  for (const factor of required) {
    const fail = await checkChainLink(request, sessionUserId, factor, required, body);
    if (fail) return fail;
  }
  if (required.length) {
    return { ok: true, method: required[required.length - 1], body };
  }

  // 4) Nothing the chain demands, but proofs were still presented: answer them
  //    the way the guard always has — a password for an account with no hash
  //    is refused (and rate-limited), a well-formed code is still spent.
  const password = typeof body?.password === 'string' ? body.password : undefined;
  if (password) return wrongPassword(request, sessionUserId);

  const strayCode = typeof body?.reauthCode === 'string' ? body.reauthCode.trim() : undefined;
  if (strayCode) {
    const fail = await checkChainLink(request, sessionUserId, 'code', [], body);
    if (fail) return fail;
    return { ok: true, method: 'code', body };
  }

  // No proof supplied. If the account has no door at all — no password, no
  // passkey, no TOTP, no sign-in address it could be emailed a code to —
  // demanding one would hard-lock the account. Allow the action, mark the
  // proof absent. Every account with even one way to prove itself gets asked.
  const { methods, hasSecondFactor: hasFactor } = await proofOptions(sessionUserId);
  if (!hasFactor) return { ok: true, method: 'none', body };

  // Otherwise ask, and ask honestly: only the doors this account can open.
  // A caller that has ruled TOTP out for this action must not be handed a menu
  // advertising it.
  return reauthRequired(opts.allowTotp === false ? methods.filter((m) => m !== 'totp') : methods);
}

/** One link of the chain, checked against the already-read body. `null` means
 *  the link holds; a `ReauthFail` is the response that says why it doesn't. */
async function checkChainLink(
  request: NextRequest,
  sessionUserId: string,
  factor: ReauthMethod,
  required: ReauthMethod[],
  body: any,
): Promise<ReauthFail | null> {
  if (factor === 'password') {
    const password = typeof body?.password === 'string' ? body.password : undefined;
    // Missing is not "wrong": the sheet still has the whole ordered chain to
    // collect, and `REAUTH_REQUIRED.methods` is what walks it.
    if (!password) return reauthRequired(required);
    const user = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { passwordHash: true },
    });
    if (user?.passwordHash && (await verifyPassword(user.passwordHash, password))) {
      logReauthProof(request, sessionUserId, 'verified', 'password');
      return null;
    }
    return wrongPassword(request, sessionUserId);
  }

  if (factor === 'code') {
    const reauthCode = typeof body?.reauthCode === 'string' ? body.reauthCode.trim() : undefined;
    if (!reauthCode) return reauthRequired(required);
    // A wrong shape can't be the code we sent, and must not spend an attempt on
    // the live one.
    if (!/^\d{6}$/.test(reauthCode)) {
      logReauthProof(request, sessionUserId, 'failed', 'code', 'malformed_code');
      return { ok: false, response: NextResponse.json(INVALID_REAUTH_CODE, { status: 400 }) };
    }
    if (await consumeReauthCode(sessionUserId, reauthCode).catch(() => false)) {
      logReauthProof(request, sessionUserId, 'verified', 'code');
      return null;
    }
    logReauthProof(request, sessionUserId, 'failed', 'code', 'invalid_or_spent_code');
    return { ok: false, response: NextResponse.json(INVALID_REAUTH_CODE, { status: 400 }) };
  }

  // factor === 'totp' — the policy's link. A live authenticator code or an
  // unspent backup code satisfies it (`second-factor.ts`); nothing presented
  // means the chain is still owed, so hand it the ordered chain rather than a
  // bare SECOND_FACTOR_REQUIRED.
  const presented =
    (typeof body?.totpCode === 'string' && body.totpCode) ||
    (typeof body?.code === 'string' && body.code) ||
    (typeof body?.backupCode === 'string' && body.backupCode) ||
    request.nextUrl?.searchParams.get('code');
  if (!presented) return reauthRequired(required);
  const blocked = await secondFactorBlocker(sessionUserId, body);
  if (blocked) {
    logReauthProof(request, sessionUserId, 'failed', 'totp', 'second_factor_invalid');
    return { ok: false, response: blocked };
  }
  logReauthProof(request, sessionUserId, 'verified', 'totp');
  return null;
}

/** A presented password that doesn't match: log it, rate-limit before
 *  revealing anything, then say either "too many attempts" or "wrong". */
async function wrongPassword(request: NextRequest, sessionUserId: string): Promise<ReauthFail> {
  logReauthProof(request, sessionUserId, 'failed', 'password', 'invalid_password');
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
