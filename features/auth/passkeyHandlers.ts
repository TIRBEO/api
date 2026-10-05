import { NextRequest, NextResponse } from 'next/server';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getRedis } from '@/features/auth/redis';
import { consumeGenericWindow } from '@/features/auth/verify-limits';
import { getSession, createSession, setSessionCookie } from '@/features/auth/http-guards';
import { fetchLoginUserById } from '@/features/identity/tirbeo';
import { createAuditEvent } from '@/features/security/audit';
import { originFromRequest } from '@/shared/changeOrigin';
import { getAppDomain } from '@/config/app-urls';
import { notifySuspiciousLogin } from '@/features/security/suspiciousLoginAlert';
import { jsonError, jsonUnauthorized } from '@/shared/response';
import { signReauthToken } from '@/features/auth/jwt';
import { requireReauth } from '@/features/auth/reauth';

const RP_NAME = 'Tirbeo';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Enough keys for a phone, a laptop and a password manager, and few enough
    that a list of them can still be read by a person checking for a stranger's. */
const MAX_PASSKEYS_PER_ACCOUNT = 5;

function isLocalhost(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

// WebAuthn rpID must be a registrable-domain suffix of the page's origin.
// In local dev the dashboard is served from localhost, so use "localhost";
// in production the API and dashboard share the .tirbeo.com registrable domain.
function getRpID(request: NextRequest): string {
  const host = request.headers.get('host') || '';
  const origin = request.headers.get('origin') || '';

  // If the origin is from localhost, use localhost as RP ID
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (isLocalhost(originUrl.hostname)) return 'localhost';
    } catch {}
  }

  // Fallback to host-based detection
  if (isLocalhost(host)) return 'localhost';

  // Production: use the configured domain (loopback env values are ignored)
  return getAppDomain();
}

function getOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const host = request.headers.get('host') || '';
  if (isLocalhost(host)) return `http://${host}`;
  return `https://${host}`;
}

// ─── Challenge cache (Redis-first, in-memory mirror) ─────────────────────
// The challenge has to survive the round trip between the two browser calls:
// OPTIONS (here) then VERIFY (passkeyAuthVerifyHandler). On serverless those two
// requests routinely land on different instances, so a per-process Map answers
// "Challenge expired" to a user who did nothing wrong. Redis is the source of
// truth when configured; the Map mirrors it for single-instance dev.
type ChallengeRow = { challenge: string; type: 'register' | 'auth'; userId?: string; expiresAt: number };
const challengeCache = new Map<string, ChallengeRow>();
const CHALLENGE_REDIS_PREFIX = 'pk:chal:';

async function storeChallenge(nonce: string, challenge: string, type: 'register' | 'auth', userId?: string) {
  const row: ChallengeRow = { challenge, type, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS };

  const redis = getRedis();
  if (redis) {
    try {
      /* ioredis takes the expiry as arguments, not as an options object:
         `set(key, value, { px })` stringifies to "[object Object]" and Redis
         answers ERR syntax error — which sent every challenge to the memory
         mirror below and, with the read side, failed every verification. */
      await redis.set(
        `${CHALLENGE_REDIS_PREFIX}${nonce}`,
        JSON.stringify(row),
        'PX',
        CHALLENGE_TTL_MS,
      );
      console.log(`[PASSKEY] Stored ${type} challenge in Redis: ${nonce}`);
      return;
    } catch (err: any) {
      // Redis down — fall through to memory rather than failing the sign-in.
      console.warn('[PASSKEY] Redis challenge store failed, using memory:', err?.message || err);
    }
  }

  const now = Date.now();
  for (const [k, v] of challengeCache) {
    if (v.expiresAt < now) challengeCache.delete(k);
  }
  challengeCache.set(nonce, row);
  console.log(`[PASSKEY] Stored ${type} challenge in memory: ${nonce}`);
}

async function getAndDeleteChallenge(nonce: string): Promise<ChallengeRow | null> {
  const redis = getRedis();
  if (redis) {
    try {
      // Single round trip: read and delete together so a challenge is single-use
      // even under concurrent retries.
      const key = `${CHALLENGE_REDIS_PREFIX}${nonce}`;
      const raw = typeof redis.getDel === 'function' ? await redis.getDel(key) : await redis.get(key);
      if (typeof raw === 'string' && raw) {
        const row = JSON.parse(raw) as ChallengeRow;
        if (typeof redis.getDel !== 'function') await redis.del(key);
        if (!row?.challenge) return null;
        if (row.expiresAt < Date.now()) return null;
        return row;
      }
      // No row in Redis is NOT the same as "expired": the store falls back to
      // this process's mirror whenever Redis refused the write, and on
      // serverless the two calls routinely land on different instances.
      // Returning null here answered "Challenge expired" to a challenge that
      // was sitting in memory a few lines below.
    } catch (err: any) {
      console.warn('[PASSKEY] Redis challenge read failed, using memory:', err?.message || err);
    }
  }

  const row = challengeCache.get(nonce);
  if (!row) return null;
  challengeCache.delete(nonce);
  if (row.expiresAt < Date.now()) return null;
  return row;
}

// ─── Registration: generate options ────────────────────────

export async function passkeyRegisterOptionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      console.warn('[PASSKEY REGISTER OPTIONS] No session found');
      return jsonUnauthorized(undefined, request);
    }

    // Consolidated schema: email/name live in user_email/user_profile; the
    // identity helper assembles the legacy flat view (user.email, user.name).
    const user = await fetchLoginUserById(session.userId);
    if (!user) {
      console.warn(`[PASSKEY REGISTER OPTIONS] User not found: ${session.userId}`);
      return jsonError('User not found', 404, request);
    }

    const existingPasskeys = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true } });

    // The cap is checked here, before the browser is asked for a signature, so
    // an account that is full is told so without an authenticator prompt it
    // can't finish.
    if (existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
      return jsonError(
        `An account holds up to ${MAX_PASSKEYS_PER_ACCOUNT} passkeys — remove one before adding another`,
        400,
        request,
      );
    }

    const rpID = getRpID(request);
    const userEmail = user.email || '';
    console.log(`[PASSKEY REGISTER OPTIONS] Generating options for user ${userEmail}, rpID: ${rpID}`);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: userEmail,
      userDisplayName: user.name || userEmail,
      attestationType: 'none',
      excludeCredentials: existingPasskeys.map((pk) => ({ id: pk.credentialId })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred' } });

    const nonce = crypto.randomUUID();
    await storeChallenge(nonce, options.challenge, 'register', user.id);
    console.log(`[PASSKEY REGISTER OPTIONS] Challenge stored with nonce: ${nonce}`);

    const res = NextResponse.json({ publicKey: options, challengeNonce: nonce });
    return res;
  } catch (err: any) {
    console.error('[PASSKEY REGISTER OPTIONS] Error:', err?.message || err, err?.stack);
    return jsonError('Failed to generate registration options: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── Registration: verify response ─────────────────────────

export async function passkeyRegisterVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      console.warn('[PASSKEY REGISTER VERIFY] No session found');
      return jsonUnauthorized(undefined, request);
    }

    const body: any = await request.json();
    const { credential, deviceName, challengeNonce } = body as {
      credential: RegistrationResponseJSON;
      deviceName?: string;
      challengeNonce?: string;
    };

    if (!credential) {
      console.warn('[PASSKEY REGISTER VERIFY] Missing credential in request body');
      return jsonError('Missing credential', 400, request);
    }
    if (!challengeNonce) {
      console.warn('[PASSKEY REGISTER VERIFY] Missing challengeNonce in request body');
      return jsonError('Missing challengeNonce', 400, request);
    }
    // Checked before anything is signed: the library parses these two as CBOR
    // and JSON, and a body that isn't that shape throws rather than returns,
    // which would read as a server fault to whoever sent it.
    if (
      typeof credential?.response?.clientDataJSON !== 'string' ||
      typeof credential?.response?.attestationObject !== 'string' ||
      typeof credential?.id !== 'string'
    ) {
      console.warn('[PASSKEY REGISTER VERIFY] Credential is not in the shape a browser sends');
      return jsonError('That is not a passkey this account can check', 400, request);
    }

    console.log(`[PASSKEY REGISTER VERIFY] Verifying registration for user ${session.userId}, nonce: ${challengeNonce}`);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) {
      console.warn(`[PASSKEY REGISTER VERIFY] Challenge not found or expired: ${challengeNonce}`);
      return jsonError('Challenge expired or not found. Please try again.', 400, request);
    }

    const origin = getOrigin(request);
    const rpID = getRpID(request);
    console.log(`[PASSKEY REGISTER VERIFY] Using origin: ${origin}, rpID: ${rpID}`);

    /* A verification failure is always about the credential — the wrong
       challenge, an origin the key wasn't made for, an attestation that
       doesn't decode. None of those are this server's fault, so they answer
       400, and the reason the library gave stays in the log rather than in
       the reply. */
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID });
    } catch (err: any) {
      console.warn('[PASSKEY REGISTER VERIFY] Rejected:', err?.message || err);
      return jsonError('That passkey couldn’t be verified. Try adding it again.', 400, request);
    }

    if (!verification.verified || !verification.registrationInfo) {
      console.warn('[PASSKEY REGISTER VERIFY] Verification failed - not verified or no registrationInfo');
      return jsonError('Registration verification failed', 400, request);
    }

    const { credential: regCredential } = verification.registrationInfo;
    const transports = credential.response?.transports || [];
    const deviceNameStr = deviceName || parseDeviceName(request.headers.get('user-agent') || '');

    console.log(`[PASSKEY REGISTER VERIFY] Creating passkey with credentialId: ${regCredential.id}`);

    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: regCredential.id,
        credentialPubkey: Buffer.from(regCredential.publicKey),
        counter: BigInt(regCredential.counter),
        transports: transports.join(','),
        deviceName: deviceNameStr } });

    console.log(`[PASSKEY REGISTER VERIFY] Passkey created successfully for user ${session.userId}`);

    await createAuditEvent({
      actorId: session.userId,
      action: 'passkey.registered',
      targetType: 'user',
      targetId: session.userId,
      metadata: { deviceName: deviceNameStr },
      severity: 'info',
      origin: originFromRequest(request.headers) });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER VERIFY] Error:', err?.message || err, err?.stack);
    return jsonError('Failed to verify registration', 500, request);
  }
}

// ─── Authentication: generate options ──────────────────────

export async function passkeyAuthOptionsHandler(request: NextRequest) {
  try {
    // WebAuthn Relying Party never picks the account from a client-supplied
    // credential ID — it only needs a list of *allowed* credentials bound to
    // the account that will authenticate. The dashboard asks for options
    // AFTER the user has already chosen a passkey in its own list, so it can
    // hand the server a challenge + chosen credential ID and expect an
    // assertion-possible answer. Because `allowCredentials` is what the
    // authenticator uses to scope the credential ID the browser signs, and
    // because the browser will happily attest ANY allowed credential, an
    // unauthenticated caller who lists a victim's public key can learn public
    // details that help to confirm the passkey is tied to that account.
    //
    // The fix: GET OPTIONS WITHOUT a body. The dashboard renders a
    // registration/attestation form without a session and answers the server's
    // challenge WITHOUT echoing a client-chosen credential ID back to a
    // cross-origin page that had no session. This closes the side-channel and
    // forces the JWT'd session (the `Authorization` header that the dashboard
    // sends with credentials: 'include' on every authenticated call) to be
    // the only thing that can select an enumerated credential set.
    const session = await getSession(request);

    if (!session) {
      /* No session — but this is the sign-in screen, not an attack. Answer with
         DISCOVERABLE credentials (`allowCredentials: undefined`) instead of a
         401. That is the standard usernameless WebAuthn flow: the
         authenticator picks the passkey locally, so the response reveals
         nothing about which credential IDs exist on any account — the exact
         side-channel the session gate above protects against is never opened.
         Refusing here instead meant "Sign in with a passkey" could only ever
         return 401 to the one screen that needs it, and the client surfaced it
         as "Your session has expired", which is both wrong and unactionable.

         Registration asks for `residentKey: 'preferred'`, so passkeys created
         through this API are discoverable and this path works for them. */
      console.log('[PASSKEY AUTH OPTIONS] No session — issuing discoverable-credential challenge');
      const options = await generateAuthenticationOptions({
        rpID: getRpID(request),
        allowCredentials: undefined,
        userVerification: 'preferred' });
      const nonce = crypto.randomUUID();
      await storeChallenge(nonce, options.challenge, 'auth');
      return NextResponse.json({ publicKey: options, challengeNonce: nonce });
    }

    const passkeys = await prisma.passkey.findMany({
      where: { userId: session.userId },
      select: { credentialId: true, transports: true } });
    if (passkeys.length === 0) {
      // Signed in, but nothing registered yet. Still a valid challenge, and no
      // credential list to leak.
      const options = await generateAuthenticationOptions({
        rpID: getRpID(request),
        allowCredentials: undefined,
        userVerification: 'preferred' });
      const nonce = crypto.randomUUID();
      await storeChallenge(nonce, options.challenge, 'auth');
      return NextResponse.json({ publicKey: options, challengeNonce: nonce });
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpID(request),
      allowCredentials: passkeys.map((pk) => ({
        id: pk.credentialId,
        transports: pk.transports
          ? (pk.transports.split(',') as AuthenticatorTransport[])
          : undefined })),
      userVerification: 'preferred' });

    const nonce = crypto.randomUUID();
    await storeChallenge(nonce, options.challenge, 'auth');

    const res = NextResponse.json({ publicKey: options, challengeNonce: nonce });
    return res;
  } catch (err: any) {
    console.error('[PASSKEY AUTH OPTIONS]', err?.message || err);
    return jsonError('Failed to generate authentication options', 500, request);
  }
}

// ─── Authentication: verify response ───────────────────────

export async function passkeyAuthVerifyHandler(request: NextRequest) {
  try {
    /* This route mints sessions and used to be reachable only by people who
       already had one, because auth-options refused to answer without a
       session. auth-options now issues a discoverable challenge to anyone on
       the sign-in screen, so verify is anonymous too — and an anonymous route
       that issues sessions needs its own ceiling. Each attempt costs a Prisma
       lookup and an audit write, and an unbounded endpoint is an invitation to
       both. 20 per 15 min per IP is far above real use (a person who fumbles
       their phone lock twice has used 2) and low enough to be useless. */
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const limit = await consumeGenericWindow(`passkey-verify:ip:${ip}`, 20, 15 * 60 * 1000);
    if (!limit.ok) {
      const mins = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60000));
      return jsonError(`Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429, request);
    }

    const body: any = await request.json();
    const { credential, challengeNonce } = body as {
      credential: AuthenticationResponseJSON;
      challengeNonce: string;
    };

    if (!credential || !challengeNonce) return jsonError('Missing credential or challenge', 400, request);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) {
      return jsonError('Challenge expired. Please try again.', 400, request);
    }

    const passkey = await prisma.passkey.findUnique({
      where: { credentialId: credential.id },
      // Consolidated schema: isBanned/isSuspended/email columns gone — gate on
      // status and read the primary email from user_email.
      include: { user: { select: { id: true, name: true, status: true, emails: { where: { isDefault: true }, select: { address: true } } } } } });

    if (!passkey) return jsonError('Passkey not found. It may have been deleted.', 404, request);
    const passkeyUser = passkey.user;
    const primaryEmail = passkeyUser.emails[0]?.address || '';
    if (passkeyUser.status === 'deleted' || passkeyUser.status === 'deletion_pending') {
      const { eventIdFor } = await import('@/features/users/refcode');
      return NextResponse.json({
        error: 'ACCOUNT_BANNED',
        banned: true,
        eventId: eventIdFor(passkeyUser.id, 'ban'),
        message: 'Your account has been permanently banned.' }, { status: 403 });
    }
    if (passkeyUser.status === 'suspended') {
      const { eventIdFor } = await import('@/features/users/refcode');
      return NextResponse.json({
        error: 'ACCOUNT_SUSPENDED',
        suspended: true,
        eventId: eventIdFor(passkeyUser.id, 'suspend'),
        reason: null,
        until: null,
        message: 'Your account is temporarily suspended.' }, { status: 403 });
    }

    const origin = getOrigin(request);

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: getRpID(request),
      requireUserVerification: false,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.credentialPubkey),
        counter: Number(passkey.counter),
        transports: passkey.transports
          ? (passkey.transports.split(',') as AuthenticatorTransport[])
          : undefined } });

    if (!verification.verified) {
      return jsonError('Authentication verification failed', 400, request);
    }

    // Update counter
    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) } });

    // Create session
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(
      passkey.user.id,
      request.headers.get('user-agent') || undefined,
      clientIp,
    );
    // A passkey proves the person holds the credential, not that the browser in
    // front of it is one this account has ever signed in from — so the same
    // "was that you?" mail applies here as anywhere else. Gated on the device,
    // and never allowed to delay or fail the sign-in.
    notifySuspiciousLogin({
      userId: passkey.user.id,
      email: primaryEmail,
      name: passkeyUser.name,
      ip: clientIp || 'unknown',
      userAgent: request.headers.get('user-agent'),
      fingerprint: request.cookies.get('__dfp')?.value || request.headers.get('x-device-fingerprint') || null,
      headers: request.headers,
      method: 'passkey' });

    await createAuditEvent({
      actorId: passkey.user.id,
      action: 'passkey.authenticated',
      targetType: 'user',
      targetId: passkey.user.id,
      metadata: { passkeyId: passkey.id, deviceName: passkey.deviceName },
      severity: 'info',
      origin: originFromRequest(request.headers) });

    const res = NextResponse.json({
      id: passkey.user.id,
      email: primaryEmail });
     setSessionCookie(res, token, refreshToken, request);
    return res;
  } catch (err: any) {
    console.error('[PASSKEY AUTH VERIFY]', err?.message || err);
    return jsonError('Failed to verify authentication: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── List passkeys ─────────────────────────────────────────

export async function passkeyListHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const passkeys = await prisma.passkey.findMany({
      where: { userId: session.userId },
      select: {
        id: true,
        deviceName: true,
        transports: true,
        createdAt: true,
        lastUsedAt: true },
      orderBy: { createdAt: 'desc' } });

    return NextResponse.json({ passkeys });
  } catch (err: any) {
    console.error('[PASSKEY LIST]', err?.message || err);
    return jsonError('Failed to list passkeys', 500, request);
  }
}

// ─── Re-authentication for sensitive actions ───────────────

/**
 * POST /api/auth/passkey/reauth-options
 * WebAuthn assertion options scoped to the SESSION USER's passkeys with
 * userVerification: 'required' — used to prove presence before sensitive
 * actions (e.g. removing a passkey). Unlike login auth-options, this never
 * accepts an email and never issues a session.
 */
export async function passkeyReauthOptionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const passkeys = await prisma.passkey.findMany({
      where: { userId: session.userId },
      select: { credentialId: true, transports: true } });
    if (passkeys.length === 0) {
      return jsonError('No passkeys registered on this account', 400, request);
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpID(request),
      allowCredentials: passkeys.map((pk) => ({
        id: pk.credentialId,
        transports: pk.transports
          ? (pk.transports.split(',') as AuthenticatorTransport[])
          : undefined })),
      userVerification: 'required' });

    const nonce = crypto.randomUUID();
    await storeChallenge(nonce, options.challenge, 'auth', session.userId);

    return NextResponse.json({ publicKey: options, challengeNonce: nonce });
  } catch (err: any) {
    console.error('[PASSKEY REAUTH OPTIONS]', err?.message || err);
    return jsonError('Failed to generate re-authentication options', 500, request);
  }
}

/**
 * POST /api/auth/passkey/reauth-verify
 * Verifies the assertion, binds it to the session user (the asserted
 * credential MUST belong to them), and returns a 5-minute reauth proof.
 * Creates no session and changes no state.
 */
export async function passkeyReauthVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const body: any = await request.json();
    const { credential, challengeNonce } = body as {
      credential: AuthenticationResponseJSON;
      challengeNonce: string;
    };
    if (!credential || !challengeNonce) return jsonError('Missing credential or challenge', 400, request);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) return jsonError('Challenge expired. Please try again.', 400, request);
    if (stored.type !== 'auth' || stored.userId !== session.userId) {
      return jsonError('Challenge does not match this session. Please try again.', 400, request);
    }

    const passkey = await prisma.passkey.findUnique({
      where: { credentialId: credential.id },
      select: { id: true, userId: true, credentialId: true, credentialPubkey: true, counter: true, transports: true } });
    if (!passkey) return jsonError('Passkey not found. It may have been deleted.', 404, request);
    if (passkey.userId !== session.userId) {
      return jsonError('Forbidden', 403, request);
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: stored.challenge,
      expectedOrigin: getOrigin(request),
      expectedRPID: getRpID(request),
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.credentialPubkey),
        counter: Number(passkey.counter),
        transports: passkey.transports
          ? (passkey.transports.split(',') as AuthenticatorTransport[])
          : undefined } });
    if (!verification.verified) return jsonError('Verification failed', 400, request);

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) } });

    const reauthToken = await signReauthToken(session.userId);
    return NextResponse.json({ ok: true, reauthToken });
  } catch (err: any) {
    console.error('[PASSKEY REAUTH VERIFY]', err?.message || err);
    return jsonError('Failed to verify re-authentication', 500, request);
  }
}

// ─── Delete passkey ────────────────────────────────────────

export async function passkeyDeleteHandler(request: NextRequest, passkeyId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    // Sensitive action: require a fresh identity proof bound to this user —
    // passkey assertion, account password, or TOTP. 403 + REAUTH_REQUIRED
    // lets the client prompt without leaking whether the passkey id exists.
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;

    const passkey = await prisma.passkey.findUnique({
      where: { id: passkeyId },
      select: { userId: true, deviceName: true } });

    if (!passkey) return jsonError('Passkey not found', 404, request);
    if (passkey.userId !== session.userId) return jsonError('Forbidden', 403, request);

    await prisma.passkey.delete({ where: { id: passkeyId } });

    await createAuditEvent({
      actorId: session.userId,
      action: 'passkey.deleted',
      targetType: 'user',
      targetId: session.userId,
      metadata: { passkeyId, deviceName: passkey.deviceName, reauthMethod: proof.method },
      severity: 'warning',
      origin: originFromRequest(request.headers) });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY DELETE]', err?.message || err);
    return jsonError('Failed to delete passkey', 500, request);
  }
}

// ─── Update passkey name ───────────────────────────────────

export async function passkeyUpdateHandler(request: NextRequest, passkeyId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const body: any = await request.json();
    const { deviceName } = body as { deviceName?: string };

    if (typeof deviceName !== 'string') return jsonError('Invalid device name', 400, request);

    const passkey = await prisma.passkey.findUnique({
      where: { id: passkeyId },
      select: { userId: true } });

    if (!passkey) return jsonError('Passkey not found', 404, request);
    if (passkey.userId !== session.userId) return jsonError('Forbidden', 403, request);

    await prisma.passkey.update({
      where: { id: passkeyId },
      data: { deviceName: deviceName || null } });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY UPDATE]', err?.message || err);
    return jsonError('Failed to update passkey', 500, request);
  }
}

// ─── Helpers ───────────────────────────────────────────────

function parseDeviceName(ua: string): string {
  if (!ua) return 'Unknown device';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build/);
    return match ? match[1].trim() : 'Android device';
  }
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux device';
  return 'Unknown device';
}
