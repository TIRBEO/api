
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { revokeSessionState } from '@/features/auth/redis';
import { trackQuery } from '@/infrastructure/observability/queryMonitor';
import { bustSessionCache } from '@/features/auth/session';
import { jsonUnauthorized, jsonError } from '@/shared/response';
import { logSecurityEvent } from '@/features/security/security';
import { coordsByLoginAttempt, coordsFromMeta } from '@/features/security/loginCoords';
import { createAuditEvent } from '@/features/security/audit';
import { requireReauth } from '@/features/auth/reauth';
import { generateSecret, generateTotpUri, verifyTotp, generateRecoveryCodes, normalizeTotpCode } from '@/features/auth/totp';
import { hashRecoveryCode } from '@/features/auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode } from '@/features/auth/otp';
import { checkWindowLimitDB } from '@/features/captcha/risk';
import { sendTemplateEmail } from '@/features/email/email';
import { createNotification, describeDevice, NotifType } from '@/features/notifications/notifications';
import { bustProfileCache } from '@/features/auth/authHandlers';
import { fetchLoginUserById, setRecoveryContact, readRecoveryContact } from '@/features/identity/tirbeo';

async function notify(userId: string, title: string, body?: string, link?: string, type: NotifType = 'security', skipEmail = false) {
  try {
    await createNotification({
      userId,
      type,
      title,
      body: body || undefined,
      link: link || '/account/notifications',
      ...(skipEmail ? { skipEmail: true } : {}) });
  } catch (e) {
    console.error('[NOTIFICATION CREATE]', (e as Error)?.message || e);
  }
}

// ─── POST /api/security/phones ─────────────────────────────
export async function phonesAddHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number } = (await request.json()) as any;
    if (!number || typeof number !== 'string') {
      return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }
    const clean = number.replace(/[\s\-()]/g, '');
    if (!/^(\+?\d{7,15}|\d{10})$/.test(clean)) {
      return NextResponse.json({ error: 'Invalid phone number format' }, { status: 400 });
    }
    // Phone is stored as a plain contact field — SMS/OTP verification was removed.
    // The consolidated schema keeps it on its own row (user_phone, 1:1 with user).
    await prisma.userPhone.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, number: clean },
      update: { number: clean } });
    await createAuditEvent({
      actorId: session.userId,
      action: 'phone.added',
      targetType: 'user',
      targetId: session.userId,
      metadata: { phoneNumber: clean },
      severity: 'info' });
    return NextResponse.json({ ok: true, number: clean });
  } catch (err: any) {
    console.error('[PHONES ADD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to add phone' }, { status: 500 });
  }
}

// ─── DELETE /api/security/phones ─────────────────────────────
export async function phonesRemoveHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number } = (await request.json()) as any;
    // Deleting the contact row is the consolidated-schema equivalent of
    // clearing user.phone (verified state lives on the same row now).
    await prisma.userPhone.deleteMany({ where: { userId: session.userId } });
    await createAuditEvent({
      actorId: session.userId,
      action: 'phone.removed',
      targetType: 'user',
      targetId: session.userId,
      metadata: { phoneNumber: number },
      severity: 'info' });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PHONES REMOVE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to remove phone' }, { status: 500 });
  }
}

// ─── GET /api/security/events ────────────────────────────────
export async function securityEventsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

    // auditEvent + securityEvent merged into activityEvent: the old `action`
    // string is stored as `kind`, and ip/user-agent are first-class columns.
    const auditLogs = await prisma.activityEvent.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, kind: true, metadata: true, severity: true,
        ipAddress: true, userAgent: true, createdAt: true } });

    // Filter out admin-only actions that shouldn't appear in user security events
    const adminOnlyActions = ['application.', 'oauth_client.', 'oauth.client.', 'user.ban', 'user.unban', 'user.suspend', 'user.role', 'config.', 'feature_flag.', 'setting.', 'theme.', 'route.'];
    const filteredLogs = auditLogs.filter(log => !adminOnlyActions.some(prefix => log.kind.startsWith(prefix)));

    const events = filteredLogs.map((log) => {
      const action = log.kind;
      let type: 'sign_in' | 'password_change' | '2fa_enable' | '2fa_disable' | 'recovery_change' | 'session_revoke' | 'passkey_add' | 'app_disconnect' = 'sign_in';
      if (action.includes('password')) type = 'password_change';
      else if (action.includes('totp.enabled') || action.includes('2fa.enable') || action.includes('2fa_enabled')) type = '2fa_enable';
      else if (action.includes('totp.disabled') || action.includes('2fa.disable') || action.includes('2fa_disabled')) type = '2fa_disable';
      else if (action.includes('recovery')) type = 'recovery_change';
      else if (action.includes('session.revoked') || action.includes('sessions.revoked')) type = 'session_revoke';
      else if (action.includes('passkey')) type = 'passkey_add';
      else if (action.includes('app_disconnected') || action.includes('oauth.disconnected')) type = 'app_disconnect';
      else if (action.includes('login') || action.includes('phone.verified') || action.includes('backup_codes') || action.includes('recovery_email')) type = 'sign_in';

      const meta = (log.metadata as Record<string, any>) || {};
      return {
        id: log.id,
        type,
        description: formatAuditAction(action, meta),
        date: log.createdAt.toISOString(),
        location: meta.location || undefined,
        /* The point the edge resolved that address to, when it resolved one —
           what the sign-in's own page pins the map from. */
        coords: coordsFromMeta(meta.coords),
        ip: log.ipAddress || meta.ip || undefined,
        userAgent: log.userAgent || meta.userAgent || undefined,
        // Which app, on the rows that are about one specific app.
        provider: typeof meta.provider === 'string' ? meta.provider : undefined };
    });

    return NextResponse.json({ events });
  } catch (err: any) {
    console.error('[SECURITY EVENTS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}

function formatAuditAction(action: string, meta: Record<string, any>): string {
  if (action.includes('login')) return 'Signed in to your account';
  if (action.includes('phone.verified')) return 'Phone number verified';
  if (action.includes('phone.added')) return 'Phone number added';
  if (action.includes('phone.removed')) return 'Phone number removed';
  if (action.includes('totp.enabled') || action.includes('2fa_enabled')) return 'Two-factor authentication enabled';
  if (action.includes('totp.disabled') || action.includes('2fa_disabled')) return 'Two-factor authentication disabled';
  if (action.includes('backup_codes.regenerated')) return 'Backup codes regenerated';
  if (action.includes('recovery_email.verified')) return 'Recovery email verified';
  if (action.includes('recovery_email.updated')) return 'Recovery email updated';
  if (action.includes('recovery_email.removed')) return 'Recovery email removed';
  if (action.includes('session.revoked_all') || action.includes('sessions.revoked_all')) return 'All other sessions signed out';
  if (action.includes('session.revoked')) return 'A session was signed out';
  if (action.includes('password')) return 'Password was changed';
  if (action.includes('passkey.deleted')) return 'Passkey removed';
  if (action.includes('passkey')) return 'Passkey registered';
  if (action.includes('oauth.connected') || action.includes('oauth_client.connected')) return 'OAuth provider connected';
  if (action.includes('app_disconnected') || action.includes('oauth.disconnected') || action.includes('oauth_client.disconnected')) {
    const name = typeof meta.providerName === 'string' ? meta.providerName
      : typeof meta.provider === 'string' ? meta.provider.replace(/^\w/, (c) => c.toUpperCase()) : '';
    return name ? `${name} was disconnected` : 'OAuth provider disconnected';
  }
  if (action.includes('merge')) return 'Accounts merged';
  if (action.includes('user.created')) return 'Account created';
  if (action.includes('user.updated') || action.includes('profile.updated')) return 'Profile updated';
  if (action.includes('user.deleted')) return 'Account deletion requested';
  if (action.includes('user.export')) return 'Data export requested';
  if (action.includes('user.login')) return 'Signed in to your account';
  if (action.includes('account.merge')) return 'Accounts merged';
  if (action.includes('ticket')) return 'Support ticket activity';
  if (action.includes('form')) return 'Form activity';
  if (action.includes('notification')) return 'Notification preference changed';
  return action.replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── POST /api/security/totp/setup ───────────────────────────
export async function totpSetupHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Sensitive action — requires an identity proof. A stolen session cookie
    // alone must not be able to initiate 2FA setup (which would lock out the
    // real user by replacing their secret).
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;

    const secret = generateSecret();
    const uri = generateTotpUri(secret, session.email || 'user');
    // Save secret to DB immediately (totpEnabled stays false until verify)
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, totpSecret: secret },
      update: { totpSecret: secret } });
    return NextResponse.json({ uri });
  } catch (err: any) {
    console.error('[TOTP SETUP]', err?.message || err);
    return NextResponse.json({ error: 'Failed to setup TOTP' }, { status: 500 });
  }
}

// ─── POST /api/security/totp/verify ──────────────────────────
export async function totpVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Sensitive action — requires an identity proof. The TOTP code itself
    // serves as the proof, but we also accept passkey/password via requireReauth
    // for defense in depth.
    const proof = await requireReauth(request, session.userId, { allowTotp: true });
    if ('response' in proof) return proof.response;

    // requireReauth already consumed the stream — take the parsed body from it,
    // or request.json() throws "Body has already been read".
    const body = proof.body as any;
    const code = normalizeTotpCode(body?.code ?? body?.token);
    if (!code) {
      return NextResponse.json({ error: 'Invalid code. Enter a 6-digit code.' }, { status: 400 });
    }
    const security = await prisma.userSecurity.findUnique({
      where: { userId: session.userId },
      select: { totpSecret: true } });
    const secretToVerify = security?.totpSecret;
    if (!secretToVerify) {
      return NextResponse.json({ error: 'TOTP not set up. Please start setup again.' }, { status: 400 });
    }
    const valid = await verifyTotp(code, secretToVerify);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid code. Please try again.' }, { status: 400 });
    }
    const recoveryCodes = generateRecoveryCodes(8);
    const mintedAt = new Date().toISOString();
    const backupCodesJson = recoveryCodes.map(rc => ({ code: hashRecoveryCode(rc), used: false, createdAt: mintedAt }));
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, totpSecret: secretToVerify, totpEnabled: true, backupCodes: backupCodesJson as any },
      update: { totpSecret: secretToVerify, totpEnabled: true, backupCodes: backupCodesJson as any } });
    bustProfileCache(session.userId); // profile cache holds is2FAEnabled — refresh it
    // Secondary effects must never turn a successful enable into a 500 (e.g. a
    // transient DB/network blip on the audit insert or notification delivery).
    await createAuditEvent({
      actorId: session.userId,
      action: 'totp.enabled',
      targetType: 'user',
      targetId: session.userId,
      severity: 'info',
      metadata: { reauthMethod: proof.method } }).catch(() => {});
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.2fa_enabled', details: { method: 'totp' } }).catch(() => {});
    await notify(session.userId, 'Two-step verification enabled', 'Authenticator app two-factor is now active on your account.', undefined, 'security', true).catch(() => {});

    if (session.email) {
      sendTemplateEmail(session.email, 'login_alert', {
        name: session.email.split('@')[0],
        location: 'Security Settings',
        device: request.headers.get('user-agent') || 'Unknown device',
        loginTime: new Date().toLocaleString() }).catch(() => {});
    }

    return NextResponse.json({ ok: true, backupCodes: recoveryCodes });
  } catch (err: any) {
    console.error('[TOTP VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to verify TOTP' }, { status: 500 });
  }
}

// ─── DELETE /api/security/totp/disable ───────────────────────
export async function totpDisableHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Sensitive action — requires an identity proof. The 6-digit TOTP code the
    // dialog already collects satisfies it; a passkey reauth token or the
    // account password are also accepted (proof checked via requireReauth).
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;

    // The dialog collects the account password *and* a fresh code, so the code
    // comes off the body whichever proof carried the reauth. (Reading it only
    // when method === 'totp' made password+code impossible to submit.)
    const totpCode: string | undefined =
      normalizeTotpCode(
        proof.body?.totpCode || proof.body?.code || request.nextUrl?.searchParams.get('code'),
      ) || undefined;
    // A backup code is the door for someone who has lost the app — it is
    // alphanumeric and single-use, so it never goes through normalizeTotpCode
    // (which would strip it to digits).
    const backup: string =
      typeof proof.body?.backupCode === 'string' ? proof.body.backupCode.trim() : '';
    if (!totpCode && !backup) {
      return NextResponse.json(
        { error: 'Enter a code from your app or one of your backup codes.' },
        { status: 400 },
      );
    }
    const security = await prisma.userSecurity.findUnique({
      where: { userId: session.userId },
      select: { totpSecret: true, backupCodes: true } });
    if (!security?.totpSecret) {
      return NextResponse.json({ error: 'TOTP not configured' }, { status: 400 });
    }

    // Either a live authenticator code, or an unspent backup code spent here.
    let accepted = totpCode ? await verifyTotp(totpCode, security.totpSecret) : false;
    if (!accepted && backup) {
      const codes = Array.isArray(security.backupCodes) ? (security.backupCodes as any[]) : [];
      const inputHash = hashRecoveryCode(backup);
      const idx = codes.findIndex((c: any) => c?.code === inputHash && !c?.used);
      if (idx !== -1) {
        // Atomic single-use, same shape as the second-factor blocker and login recovery.
        const spent = await prisma.userSecurity.updateMany({
          where: { userId: session.userId, backupCodes: { array_contains: [codes[idx]] } as any },
          data: {
            backupCodes: codes.map((c: any) =>
              c?.code === inputHash ? { ...c, used: true, usedAt: new Date().toISOString() } : c
            ) as any,
          },
        });
        accepted = spent.count === 1;
      }
    }
    if (!accepted) {
      return NextResponse.json({ error: 'Invalid code. Please try again.' }, { status: 400 });
    }
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      // require2FA without an enrolled TOTP is inert by definition — turning
      // 2FA off clears it so the flag can never outlive the factor.
      create: { userId: session.userId, totpSecret: null, totpEnabled: false, backupCodes: [], require2FA: false },
      update: { totpSecret: null, totpEnabled: false, backupCodes: [], require2FA: false } });
    bustProfileCache(session.userId); // profile cache holds is2FAEnabled — refresh it
    await createAuditEvent({
      actorId: session.userId,
      action: 'totp.disabled',
      targetType: 'user',
      targetId: session.userId,
      severity: 'warning',
      metadata: { reauthMethod: proof.method } }).catch(() => {});
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.2fa_disabled', severity: 'warning' }).catch(() => {});
    await notify(session.userId, 'Two-step verification disabled', 'Two-factor authentication was turned off for your account.', undefined, 'security', true).catch(() => {});

    const loginUser = await fetchLoginUserById(session.userId);
    if (loginUser?.email) {
      // This used to send 'suspicious_login' — a mail that says an unfamiliar
      // device just signed in. Nobody signed in; the person changed their own
      // setting from a session they were already in. Telling somebody a stranger
      // reached their account when that is not what happened is worse than
      // staying quiet about it.
      sendTemplateEmail(loginUser.email, 'two_factor_disabled', {
        name: loginUser.name || loginUser.email.split('@')[0],
        device: describeDevice(request.headers.get('user-agent')),
        loginTime: new Date().toLocaleString(),
        twoFactorUrl: `${(await import('@/config/app-urls')).getDashboardBaseUrl()}/settings/two-factor` }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[TOTP DISABLE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to disable TOTP' }, { status: 500 });
  }
}

// ─── GET /api/security/backup-codes ─────────────────────────
export async function backupCodesListHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const security = await prisma.userSecurity.findUnique({
      where: { userId: session.userId },
      select: { backupCodes: true, totpEnabled: true } });
    const codes = Array.isArray(security?.backupCodes) ? (security!.backupCodes as any[]) : [];
    // Sets are grouped by the stamp they were minted under — one click of
    // "Generate" mints a set that shares a single createdAt. Codes stored
    // before the stamp existed carry none, so they read as one undated set.
    const sets = new Map<string, { createdAt: string | null; total: number; remaining: number }>();
    for (const code of codes) {
      const key = typeof code?.createdAt === 'string' ? code.createdAt : '';
      const set = sets.get(key) ?? { createdAt: key || null, total: 0, remaining: 0 };
      set.total++;
      if (code?.used !== true) set.remaining++;
      sets.set(key, set);
    }
    const ordered = [...sets.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const remaining = codes.filter((c) => c && c.used !== true).length;
    // Plaintext never leaves the server after generation — codes are hashed.
    return NextResponse.json({
      codes: [],
      enabled: codes.length > 0,
      totpEnabled: !!security?.totpEnabled,
      count: codes.length,
      remaining,
      used: codes.length - remaining,
      lastGeneratedAt: ordered[0]?.createdAt ?? null,
      sets: ordered });
  } catch (err: any) {
    console.error('[BACKUP CODES LIST]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch backup codes' }, { status: 500 });
  }
}

// ─── POST /api/security/backup-codes/regenerate ──────────────
export async function backupCodesRegenerateHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    // A fresh set invalidates the old one, so this is a sensitive action: it
    // needs a proof, not just a cookie. `none` means the account has no second
    // factor to ask for, and demanding one would lock it out of its own codes.
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;
    // Each mint throws away the set before it, so a hijacked session can't
    // quietly cycle through codes while the owner isn't looking.
    const allowed = await checkWindowLimitDB(`backup-codes:mint:${session.userId}`, 3, 60 * 60_000).catch(() => true);
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many sets in the last hour. Try again later.' },
        { status: 429 },
      );
    }
    const codes = generateRecoveryCodes(8);
    const mintedAt = new Date().toISOString();
    const backupCodesJson = codes.map(code => ({ code: hashRecoveryCode(code), used: false, createdAt: mintedAt }));
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, backupCodes: backupCodesJson as any },
      update: { backupCodes: backupCodesJson as any } });
    await createAuditEvent({
      actorId: session.userId,
      action: 'backup_codes.regenerated',
      targetType: 'user',
      targetId: session.userId,
      metadata: { via: proof.method },
      severity: 'info' });
    return NextResponse.json({ ok: true, codes });
  } catch (err: any) {
    console.error('[BACKUP CODES REGEN]', err?.message || err);
    return NextResponse.json({ error: 'Failed to regenerate codes' }, { status: 500 });
  }
}

// ─── GET /api/security/status ──────────────────────────────────
/** What the "Password and security" screen is actually made of: whether this
    account can be signed into with a password at all (an account created
    through Google has none until one is set, and the screen must not ask for a
    current password that doesn't exist), and the address a recovery would go
    to. One read, because the screen paints both from it. */
export async function securityStatusHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const [user, contact] = await Promise.all([
      prisma.user.findUnique({ where: { id: session.userId }, select: { passwordHash: true } }),
      readRecoveryContact(session.userId),
    ]);
    if (!user) return jsonError('No such account', 404, request);

    return NextResponse.json({
      hasPassword: !!user.passwordHash,
      recoveryEmail: contact?.email ?? null,
      recoveryEmailVerified: !!contact?.verified });
  } catch (err: any) {
    console.error('[SECURITY STATUS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read security status' }, { status: 500 });
  }
}

// ─── PUT /api/security/recovery-email ────────────────────────
export async function recoveryEmailHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    // Setting, changing or removing the recovery address is a sensitive action
    // either way, and requireReauth is the only permitted reader of the body —
    // reading it here first used to hide the proof from the guard.
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;
    const { email } = (proof.body ?? {}) as any;

    // Removing the recovery email — recovery contact is a user_email row of
    // kind 'recovery' now, so removal means deleting the row (secondary kept
    // for legacy rows).
    if (email === null || email === undefined || email === '') {
      await prisma.userEmail.deleteMany({
        where: { userId: session.userId, kind: { in: ['recovery', 'secondary'] } } });
      await createAuditEvent({
        actorId: session.userId,
        action: 'recovery_email.removed',
        targetType: 'user',
        targetId: session.userId,
        metadata: { reauthMethod: proof.method },
        severity: 'info' });
      await notify(session.userId, 'Recovery email removed', 'Your recovery email has been removed from your account.');
      return NextResponse.json({ ok: true });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }
    // Primary email comes from the LoginUser view; the recovery address and its
    // verified state live on a user_email row (verifiedAt != null).
    const loginUser = await fetchLoginUserById(session.userId);
    const recoveryRow = await prisma.userEmail.findFirst({
      where: { userId: session.userId, kind: { in: ['recovery', 'secondary'] } },
      select: { address: true, verifiedAt: true },
      orderBy: { createdAt: 'desc' } });
    if (loginUser?.email && loginUser.email.toLowerCase() === email.toLowerCase()) {
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }

    const wasVerified = !!recoveryRow?.verifiedAt;
    const emailChanged = recoveryRow?.address?.toLowerCase() !== email.toLowerCase();
    // Only reset verification if the email actually changed
    await setRecoveryContact({
      userId: session.userId,
      email,
      verifiedBy: !emailChanged && wasVerified ? 'code' : null,
      verifiedAt: !emailChanged && wasVerified ? recoveryRow!.verifiedAt : null });
    // If email hasn't changed and is already verified, return early
    if (!emailChanged && wasVerified) {
      return NextResponse.json({ ok: true, alreadyVerified: true });
    }
    await createAuditEvent({
      actorId: session.userId,
      action: 'recovery_email.updated',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email, verified: false, reauthMethod: proof.method },
      severity: 'info' });
    await notify(session.userId, 'Recovery email updated', `Your recovery email was changed to ${email}. Please verify it.`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update recovery email' }, { status: 500 });
  }
}

// ─── POST /api/security/recovery-email/send-code ─────────────
export async function recoveryEmailSendCodeHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { email } = (await request.json()) as any;
    console.log('[RECOVERY EMAIL SEND] email:', email, 'typeof:', typeof email);
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      console.warn('[RECOVERY EMAIL SEND] Rejected: invalid email', { email });
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }
    const loginUser = await fetchLoginUserById(session.userId);
    if (loginUser?.email && loginUser.email.toLowerCase() === email.toLowerCase()) {
      console.warn('[RECOVERY EMAIL SEND] Rejected: same as primary');
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }
    const code = generateOtpCode();
    // The code proves access to one particular mailbox, so it is bound to that
    // address: a code sent to a mailbox the person controls could otherwise be
    // spent on any address they typed, and the account would believe an inbox it
    // never checked.
    await storeOtp(session.userId, 'email', code, email);
    const { sendTemplateEmail } = await import('@/features/email/email');
    const result = await sendTemplateEmail(email, 'verify_email', { otp: code });
    if (!result.success) {
      console.error(`[RECOVERY EMAIL SEND] Failed to deliver to ${email}: ${result.error}`);
      return NextResponse.json({ ok: true, message: 'Verification code sent', delivered: false, error: result.error });
    }
    return NextResponse.json({ ok: true, message: 'Verification code sent', delivered: true, messageId: result.messageId });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL SEND]', err?.message || err);
    return NextResponse.json({ error: 'Failed to send code' }, { status: 500 });
  }
}

// ─── POST /api/security/recovery-email/verify ────────────────
export async function recoveryEmailVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { email, code } = (await request.json()) as any;
    if (!email || typeof email !== 'string' || !email.includes('@') || !code || typeof code !== 'string') {
      return NextResponse.json({ error: 'Email and code required' }, { status: 400 });
    }
    const loginUser = await fetchLoginUserById(session.userId);
    if (loginUser?.email && loginUser.email.toLowerCase() === email.toLowerCase()) {
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }
    const ok = await verifyOtpCode(session.userId, 'email', code, email);
    if (!ok) return NextResponse.json({ error: 'Invalid or expired verification code' }, { status: 400 });
    await setRecoveryContact({
      userId: session.userId,
      email,
      verifiedBy: 'code',
      verifiedAt: new Date() });
    await createAuditEvent({
      actorId: session.userId,
      action: 'recovery_email.verified',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email, verified: true },
      severity: 'info' });
    await notify(session.userId, 'Recovery email verified', `Your recovery email (${email}) has been confirmed.`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to verify email' }, { status: 500 });
  }
}

// ─── POST /api/security/password-check ───────────────────────
export async function passwordCheckHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { passwordHash: true } });
    const hasPassword = !!user?.passwordHash && user.passwordHash.length > 0;
    return NextResponse.json({
      hasPassword,
      weak: !hasPassword ? 0 : 0,
      reused: 0,
      total: 1,
      score: hasPassword ? 'good' : 'no_password',
      label: hasPassword ? 'Password is set' : 'No password set',
      feedback: [] });
  } catch (err: any) {
    console.error('[PASSWORD CHECK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to check password' }, { status: 500 });
  }
}

// ─── DELETE /api/security/sessions/revoke-all ────────────────
/**
 * End sessions. One guarded call covers both shapes the settings screens ask
 * for: "everything but this device" (the panic button) and "exactly these"
 * (the device picker). It stays a single request because the identity proof
 * that pays for it is single-use — an emailed code spent on the first of three
 * deletes would leave the other two refused.
 *
 * The caller's own session is never in the set, from either shape: signing
 * yourself out of the screen you are standing on is not a thing a settings
 * page should be able to do.
 */
export async function sessionsRevokeAllHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Sensitive action — requires a fresh identity proof (passkey, password,
    // emailed code, or TOTP). A stolen session cookie alone cannot sign out every device.
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;

    const picked: string[] = Array.isArray(proof.body?.sessionIds)
      ? proof.body.sessionIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];

    // user_sessions has no status column: a session is active while revokedAt
    // is null and expiresAt is in the future. Revocation is the revokedAt stamp
    // only (tokenHash is a non-unique lookup key and must stay intact).
    const now = new Date();
    const mine = { userId: session.userId, revokedAt: null };
    const where = picked.length
      ? { AND: [mine, { id: { in: picked } }, { id: { not: session.sessionId } }] }
      : { ...mine, expiresAt: { gt: now }, id: { not: session.sessionId } };
    const toRevoke = await prisma.userSession.findMany({ where, select: { id: true } });
    await prisma.userSession.updateMany({ where, data: { revokedAt: now } });
    for (const s of toRevoke) {
      bustSessionCache(s.id);
      await revokeSessionState(s.id).catch(() => {});
    }
    // One ledger line per device when the person named them, one line for the
    // sweep when they didn't — the same two shapes the history page already reads.
    if (picked.length) {
      for (const s of toRevoke) {
        await createAuditEvent({
          actorId: session.userId,
          action: 'session.revoked',
          targetType: 'session',
          targetId: s.id,
          severity: 'info',
          metadata: { reauthMethod: proof.method } });
      }
    } else {
      await createAuditEvent({
        actorId: session.userId,
        action: 'sessions.revoked_all',
        targetType: 'user',
        targetId: session.userId,
        severity: 'warning',
        metadata: { reauthMethod: proof.method, revokedCount: toRevoke.length } });
    }
    await notify(session.userId, 'Sessions signed out', `${toRevoke.length} of your sessions were signed out for your account.`);
    return NextResponse.json({ ok: true, revoked: toRevoke.length });
  } catch (err: any) {
    console.error('[SESSIONS REVOKE ALL]', err?.message || err);
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
  }
}

// ─── DELETE /api/security/sessions/[id] ──────────────────────
export async function sessionRevokeHandler(request: NextRequest, sessionId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    if (!sessionId) return NextResponse.json({ error: 'Session ID required' }, { status: 400 });
    await prisma.userSession.updateMany({
      where: { id: sessionId, userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() } });
    bustSessionCache(sessionId);
    await revokeSessionState(sessionId).catch(() => {});
    await createAuditEvent({
      actorId: session.userId,
      action: 'session.revoked',
      targetType: 'session',
      targetId: sessionId,
      severity: 'info' });
    await notify(session.userId, 'Session signed out', 'One of your sessions was signed out.');
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[SESSION REVOKE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}

// ─── GET /api/security/login-history ──────────────────────
export async function loginHistoryHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    // login_history -> user_logins: the consolidated per-attempt ledger (failed
    // sign-ins are rows there too, with success=false), so the eventType filter
    // the old security_events query needed is gone. `email` is the account's own
    // login address, carried on the session.
    const rows = await trackQuery('login_history_by_user_created', () => prisma.userLogin.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        location: true,
        success: true,
        method: true,
        createdAt: true } }));
    /* The ledger kept a place name but no point; the auth path's own event
       for the same attempt did. Pair them so the map draws from the real
       coordinates or not at all. */
    const coords = await coordsByLoginAttempt(
      session.userId,
      rows.map((r) => ({ ip: r.ipAddress, at: r.createdAt })));
    const logs = rows.map((row, i) => ({ ...row, coords: coords[i], email: session.email }));
    return NextResponse.json({ logs });
  } catch (err: any) {
    console.error('[LOGIN HISTORY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch login history' }, { status: 500 });
  }
}
