/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { revokeSessionState } from './auth/redis';
import { trackQuery } from './queryMonitor';
import { revokeSessionFamilyByUser, bustSessionCache } from './auth/session';
import { jsonUnauthorized, jsonError } from './response';
import { logSecurityEvent } from './security';
import { createAuditEvent } from './audit';
import { generateSecret, generateTotpUri, verifyTotp, generateRecoveryCodes } from './auth/totp';
import { hashRecoveryCode } from './auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp, sendPhoneOtp } from './auth/otp';
import { sendTemplateEmail } from './email';
import { createNotification, fmtNow, NotifType } from './notifications';

async function notify(userId: string, title: string, body?: string, link?: string, type: NotifType = 'security') {
  try {
    await createNotification({
      userId,
      type,
      title,
      body: body ? `${body} — ${fmtNow()}` : undefined,
      link: link || '/account/inbox',
    });
  } catch (e) {
    console.error('[NOTIFICATION CREATE]', (e as Error)?.message || e);
  }
}

// ─── POST /api/security/phones/send-otp ─────────────────────
export async function phonesSendOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number } = (await request.json()) as any;
    if (!number || typeof number !== 'string') {
      return new NextResponse('Phone number required', { status: 400 });
    }
    const clean = number.replace(/[\s\-()]/g, '');
    if (!/^(\+?\d{7,15}|\d{10})$/.test(clean)) {
      return new NextResponse('Invalid phone number format', { status: 400 });
    }
    const code = generateOtpCode();
    await storeOtp(session.userId, 'phone', code);
    await sendPhoneOtp(clean, code);
    return NextResponse.json({ ok: true, message: 'Verification code sent' });
  } catch (err: any) {
    console.error('[PHONES SEND OTP]', err?.message || err);
    return new NextResponse('Failed to send OTP', { status: 500 });
  }
}

// ─── POST /api/security/phones/verify-otp ────────────────────
export async function phonesVerifyOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number, code } = (await request.json()) as any;
    if (!number || typeof number !== 'string' || !code || typeof code !== 'string' || code.length !== 6) {
      return new NextResponse('Invalid request', { status: 400 });
    }
    const clean = number.replace(/[\s\-()]/g, '');
    if (!/^(\+?\d{7,15}|\d{10})$/.test(clean)) {
      return new NextResponse('Invalid phone number format', { status: 400 });
    }
    const ok = await verifyOtpCode(session.userId, 'phone', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });
    await prisma.user.update({
      where: { id: session.userId },
      data: { phoneNumber: clean, phoneVerified: true },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'phone.verified',
      targetType: 'user',
      targetId: session.userId,
      metadata: { phoneNumber: clean },
      severity: 'info',
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PHONES VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify OTP', { status: 500 });
  }
}

// ─── POST /api/security/phones (add directly — requires OTP verification) ───
export async function phonesAddHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number, code } = (await request.json()) as any;
    if (!number || typeof number !== 'string') {
      return new NextResponse('Phone number required', { status: 400 });
    }
    if (!code || typeof code !== 'string') {
      return new NextResponse('Verification code required', { status: 400 });
    }
    const clean = number.replace(/[\s\-()]/g, '');
    if (!/^(\+?\d{7,15}|\d{10})$/.test(clean)) {
      return new NextResponse('Invalid phone number format', { status: 400 });
    }
    // Verify the OTP before accepting the phone
    const { verifyOtpCode } = await import('./auth/otp');
    const ok = await verifyOtpCode(session.userId, 'phone', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });
    await prisma.user.update({
      where: { id: session.userId },
      data: { phoneNumber: clean, phoneVerified: true },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'phone.added',
      targetType: 'user',
      targetId: session.userId,
      metadata: { phoneNumber: clean },
      severity: 'info',
    });
    return NextResponse.json({ ok: true, number: clean });
  } catch (err: any) {
    console.error('[PHONES ADD]', err?.message || err);
    return new NextResponse('Failed to add phone', { status: 500 });
  }
}

// ─── DELETE /api/security/phones ─────────────────────────────
export async function phonesRemoveHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { number } = (await request.json()) as any;
    await prisma.user.update({
      where: { id: session.userId },
      data: { phoneNumber: null, phoneVerified: false },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'phone.removed',
      targetType: 'user',
      targetId: session.userId,
      metadata: { phoneNumber: number },
      severity: 'info',
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PHONES REMOVE]', err?.message || err);
    return new NextResponse('Failed to remove phone', { status: 500 });
  }
}

// ─── GET /api/security/events ────────────────────────────────
export async function securityEventsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

    const auditLogs = await prisma.auditEvent.findMany({
      where: { actorId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, action: true, targetType: true, targetId: true,
        metadata: true, severity: true, createdAt: true,
      },
    });

    // Filter out admin-only actions that shouldn't appear in user security events
    const adminOnlyActions = ['application.', 'oauth_client.', 'oauth.client.', 'user.ban', 'user.unban', 'user.suspend', 'user.role', 'config.', 'feature_flag.', 'setting.', 'theme.', 'route.'];
    const filteredLogs = auditLogs.filter(log => !adminOnlyActions.some(prefix => log.action.startsWith(prefix)));

    const events = filteredLogs.map((log) => {
      let type: 'sign_in' | 'password_change' | '2fa_enable' | '2fa_disable' | 'recovery_change' | 'session_revoke' | 'passkey_add' = 'sign_in';
      if (log.action.includes('password')) type = 'password_change';
      else if (log.action.includes('totp.enabled') || log.action.includes('2fa.enable')) type = '2fa_enable';
      else if (log.action.includes('totp.disabled') || log.action.includes('2fa.disable')) type = '2fa_disable';
      else if (log.action.includes('recovery')) type = 'recovery_change';
      else if (log.action.includes('session.revoked') || log.action.includes('sessions.revoked')) type = 'session_revoke';
      else if (log.action.includes('passkey')) type = 'passkey_add';
      else if (log.action.includes('login') || log.action.includes('phone.verified') || log.action.includes('backup_codes') || log.action.includes('recovery_email')) type = 'sign_in';

      const meta = (log.metadata as Record<string, any>) || {};
      return {
        id: log.id,
        type,
        description: formatAuditAction(log.action, meta),
        date: log.createdAt.toISOString(),
        location: meta.location || undefined,
        ip: meta.ip || undefined,
        userAgent: meta.userAgent || undefined,
      };
    });

    return NextResponse.json({ events });
  } catch (err: any) {
    console.error('[SECURITY EVENTS]', err?.message || err);
    return new NextResponse('Failed to fetch events', { status: 500 });
  }
}

function formatAuditAction(action: string, meta: Record<string, any>): string {
  if (action.includes('login')) return 'Signed in to your account';
  if (action.includes('phone.verified')) return 'Phone number verified';
  if (action.includes('phone.added')) return 'Phone number added';
  if (action.includes('phone.removed')) return 'Phone number removed';
  if (action.includes('totp.enabled')) return 'Two-factor authentication enabled';
  if (action.includes('totp.disabled')) return 'Two-factor authentication disabled';
  if (action.includes('backup_codes.regenerated')) return 'Backup codes regenerated';
  if (action.includes('recovery_email.verified')) return 'Recovery email verified';
  if (action.includes('recovery_email.updated')) return 'Recovery email updated';
  if (action.includes('session.revoked')) return 'A session was signed out';
  if (action.includes('sessions.revoked_all')) return 'All other sessions signed out';
  if (action.includes('password')) return 'Password was changed';
  if (action.includes('passkey')) return 'Passkey registered';
  return action.replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── POST /api/security/totp/setup ───────────────────────────
export async function totpSetupHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const secret = generateSecret();
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    const uri = generateTotpUri(secret, user?.email || 'user');
    // Save secret to DB immediately (is2FAEnabled stays false until verify)
    await prisma.user.update({ where: { id: session.userId }, data: { totpSecret: secret } });
    return NextResponse.json({ uri });
  } catch (err: any) {
    console.error('[TOTP SETUP]', err?.message || err);
    return new NextResponse('Failed to setup TOTP', { status: 500 });
  }
}

// ─── POST /api/security/totp/verify ──────────────────────────
export async function totpVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const body = (await request.json()) as any;
    const code = body?.code || body?.token;
    if (!code || typeof code !== 'string' || code.length !== 6) {
      return NextResponse.json({ error: 'Invalid code. Enter a 6-digit code.' }, { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { totpSecret: true },
    });
    const secretToVerify = user?.totpSecret;
    if (!secretToVerify) {
      return NextResponse.json({ error: 'TOTP not set up. Please start setup again.' }, { status: 400 });
    }
    const valid = await verifyTotp(code, secretToVerify);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid code. Please try again.' }, { status: 400 });
    }
    const recoveryCodes = generateRecoveryCodes(8);
    const backupCodesJson = recoveryCodes.map(rc => ({ code: hashRecoveryCode(rc), used: false }));
    await prisma.user.update({
      where: { id: session.userId },
      data: { totpSecret: secretToVerify, is2FAEnabled: true, backupCodes: backupCodesJson },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'totp.enabled',
      targetType: 'user',
      targetId: session.userId,
      severity: 'info',
    });
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.2fa_enabled', details: { method: 'totp' } }).catch(() => {});
    await notify(session.userId, 'Two-step verification enabled', 'Authenticator app two-factor is now active on your account.');

    const userEmail = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    if (userEmail?.email) {
      sendTemplateEmail(userEmail.email, 'login_alert', {
        name: userEmail.email.split('@')[0],
        location: 'Security Settings',
        device: request.headers.get('user-agent') || 'Unknown device',
        loginTime: new Date().toLocaleString(),
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, backupCodes: recoveryCodes });
  } catch (err: any) {
    console.error('[TOTP VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify TOTP', { status: 500 });
  }
}

// ─── DELETE /api/security/totp/disable ───────────────────────
export async function totpDisableHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { totpCode } = (await request.json()) as any;
    if (!totpCode || typeof totpCode !== 'string' || totpCode.length !== 6) {
      return NextResponse.json({ error: 'Invalid code. Enter a 6-digit code.' }, { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { totpSecret: true },
    });
    if (!user?.totpSecret) {
      return NextResponse.json({ error: 'TOTP not configured' }, { status: 400 });
    }
    const valid = await verifyTotp(totpCode, user.totpSecret);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid code. Please try again.' }, { status: 400 });
    }
    await prisma.user.update({
      where: { id: session.userId },
      data: { totpSecret: null, is2FAEnabled: false, backupCodes: [] },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'totp.disabled',
      targetType: 'user',
      targetId: session.userId,
      severity: 'warning',
    });
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.2fa_disabled', severity: 'warning' }).catch(() => {});
    await notify(session.userId, 'Two-step verification disabled', 'Two-factor authentication was turned off for your account.');

    const userEmail = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    if (userEmail?.email) {
      sendTemplateEmail(userEmail.email, 'suspicious_login', {
        name: userEmail.email.split('@')[0],
        location: 'Security Settings',
        device: request.headers.get('user-agent') || 'Unknown device',
        loginTime: new Date().toLocaleString(),
        ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown',
        dashboardUrl: 'https://tirbeo.app/dashboard',
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[TOTP DISABLE]', err?.message || err);
    return new NextResponse('Failed to disable TOTP', { status: 500 });
  }
}

// ─── GET /api/security/backup-codes ─────────────────────────
export async function backupCodesListHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { backupCodes: true } });
    const codes = Array.isArray((user as any)?.backupCodes) ? (user as any).backupCodes : [];
    const count = codes.length;
    return NextResponse.json({ codes: [], count, enabled: count > 0 });
  } catch (err: any) {
    console.error('[BACKUP CODES LIST]', err?.message || err);
    return new NextResponse('Failed to fetch backup codes', { status: 500 });
  }
}

// ─── POST /api/security/backup-codes/regenerate ──────────────
export async function backupCodesRegenerateHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const codes = generateRecoveryCodes(8);
    const backupCodesJson = codes.map(code => ({ code: hashRecoveryCode(code), used: false }));
    await prisma.user.update({
      where: { id: session.userId },
      data: { backupCodes: backupCodesJson },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'backup_codes.regenerated',
      targetType: 'user',
      targetId: session.userId,
      severity: 'info',
    });
    return NextResponse.json({ ok: true, codes });
  } catch (err: any) {
    console.error('[BACKUP CODES REGEN]', err?.message || err);
    return new NextResponse('Failed to regenerate codes', { status: 500 });
  }
}

// ─── PUT /api/security/recovery-email ────────────────────────
export async function recoveryEmailHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { email } = (await request.json()) as any;

    // Allow null to remove the recovery email
    if (email === null || email === undefined || email === '') {
      await prisma.user.update({
        where: { id: session.userId },
        data: { secondaryEmail: null, secondaryEmailVerified: false },
      });
      await createAuditEvent({
        actorId: session.userId,
        action: 'recovery_email.removed',
        targetType: 'user',
        targetId: session.userId,
        metadata: {},
        severity: 'info',
      });
      await notify(session.userId, 'Recovery email removed', 'Your recovery email has been removed from your account.');
      return NextResponse.json({ ok: true });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return new NextResponse('Valid email required', { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true, secondaryEmail: true, secondaryEmailVerified: true },
    });
    if (user?.email && user.email.toLowerCase() === email.toLowerCase()) {
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }
    const emailChanged = user?.secondaryEmail?.toLowerCase() !== email.toLowerCase();
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        secondaryEmail: email,
        // Only reset verification if the email actually changed
        secondaryEmailVerified: emailChanged ? false : (user?.secondaryEmailVerified ?? false),
      },
    });
    // If email hasn't changed and is already verified, return early
    if (!emailChanged && user?.secondaryEmailVerified) {
      return NextResponse.json({ ok: true, alreadyVerified: true });
    }
    await createAuditEvent({
      actorId: session.userId,
      action: 'recovery_email.updated',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email, verified: false },
      severity: 'info',
    });
    await notify(session.userId, 'Recovery email updated', `Your recovery email was changed to ${email}. Please verify it.`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL]', err?.message || err);
    return new NextResponse('Failed to update recovery email', { status: 500 });
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
      return new NextResponse('Valid email required', { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    if (user?.email && user.email.toLowerCase() === email.toLowerCase()) {
      console.warn('[RECOVERY EMAIL SEND] Rejected: same as primary');
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }
    const code = generateOtpCode();
    await storeOtp(session.userId, 'email', code);
    const { sendTemplateEmail } = await import('./email');
    const result = await sendTemplateEmail(email, 'verify_email', { otp: code });
    if (!result.success) {
      console.error(`[RECOVERY EMAIL SEND] Failed to deliver to ${email}: ${result.error}`);
      return NextResponse.json({ ok: true, message: 'Verification code sent', delivered: false, error: result.error });
    }
    return NextResponse.json({ ok: true, message: 'Verification code sent', delivered: true, messageId: result.messageId });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL SEND]', err?.message || err);
    return new NextResponse('Failed to send code', { status: 500 });
  }
}

// ─── POST /api/security/recovery-email/verify ────────────────
export async function recoveryEmailVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const { email, code } = (await request.json()) as any;
    if (!email || typeof email !== 'string' || !email.includes('@') || !code || typeof code !== 'string') {
      return new NextResponse('Email and code required', { status: 400 });
    }
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    if (user?.email && user.email.toLowerCase() === email.toLowerCase()) {
      return NextResponse.json({ error: 'Recovery email cannot be the same as your primary email' }, { status: 400 });
    }
    const ok = await verifyOtpCode(session.userId, 'email', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        secondaryEmail: email,
        secondaryEmailVerified: true,
      },
    });
    await createAuditEvent({
      actorId: session.userId,
      action: 'recovery_email.verified',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email, verified: true },
      severity: 'info',
    });
    // Surface the verified recovery email in the security event list.
    await createAuditEvent({
      actorId: session.userId,
      action: 'recovery_email.verified_toast',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email },
      severity: 'info',
    });
    await notify(session.userId, 'Recovery email verified', `Your recovery email (${email}) has been confirmed.`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify email', { status: 500 });
  }
}

// ─── POST /api/security/password-check ───────────────────────
export async function passwordCheckHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { passwordHash: true },
    });
    const hasPassword = !!user?.passwordHash && user.passwordHash.length > 0;
    return NextResponse.json({
      hasPassword,
      weak: !hasPassword ? 0 : 0,
      reused: 0,
      total: 1,
      score: hasPassword ? 'good' : 'no_password',
      label: hasPassword ? 'Password is set' : 'No password set',
      feedback: [],
    });
  } catch (err: any) {
    console.error('[PASSWORD CHECK]', err?.message || err);
    return new NextResponse('Failed to check password', { status: 500 });
  }
}

// ─── DELETE /api/security/sessions/revoke-all ────────────────
export async function sessionsRevokeAllHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const toRevoke = await prisma.session.findMany({
      where: { userId: session.userId, status: 'active', id: { not: session.sessionId } },
      select: { id: true },
    });
    await prisma.session.updateMany({
      where: { userId: session.userId, status: 'active', id: { not: session.sessionId } },
      data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null },
    });
    for (const s of toRevoke) {
      bustSessionCache(s.id);
      await revokeSessionState(s.id).catch(() => {});
    }
    await createAuditEvent({
      actorId: session.userId,
      action: 'sessions.revoked_all',
      targetType: 'user',
      targetId: session.userId,
      severity: 'warning',
    });
    await notify(session.userId, 'Sessions signed out', 'All other sessions were signed out for your account.');
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[SESSIONS REVOKE ALL]', err?.message || err);
    return new NextResponse('Failed to revoke sessions', { status: 500 });
  }
}

// ─── DELETE /api/security/sessions/[id] ──────────────────────
export async function sessionRevokeHandler(request: NextRequest, sessionId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    if (!sessionId) return new NextResponse('Session ID required', { status: 400 });
    await prisma.session.updateMany({
      where: { id: sessionId, userId: session.userId },
      data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null },
    });
    bustSessionCache(sessionId);
    await revokeSessionState(sessionId).catch(() => {});
    await createAuditEvent({
      actorId: session.userId,
      action: 'session.revoked',
      targetType: 'session',
      targetId: sessionId,
      severity: 'info',
    });
    await notify(session.userId, 'Session signed out', 'One of your sessions was signed out.');
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[SESSION REVOKE]', err?.message || err);
    return new NextResponse('Failed to revoke session', { status: 500 });
  }
}

// ─── GET /api/security/login-history ──────────────────────
export async function loginHistoryHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const logs = await trackQuery('login_history_by_user_created', () => prisma.login_history.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        email: true,
        ipAddress: true,
        userAgent: true,
        success: true,
        method: true,
        createdAt: true,
      },
    }));
    return NextResponse.json({ logs });
  } catch (err: any) {
    console.error('[LOGIN HISTORY]', err?.message || err);
    return new NextResponse('Failed to fetch login history', { status: 500 });
  }
}
