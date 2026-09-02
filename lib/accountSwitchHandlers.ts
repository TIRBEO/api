import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession, validateCsrf } from './session';
import { createSession, setSessionCookie } from './auth/session';
import {
  listDeviceAccounts,
  removeDeviceAccount,
  isKnownDeviceAccount,
} from './auth/device-accounts';
import { jsonUnauthorized, jsonForbidden } from './response';

/**
 * Multi-account switching — Google-style.
 *
 * - GET  /api/auth/accounts        → accounts remembered on this device (+ current session user)
 * - POST /api/auth/switch-account  → issue a session for another remembered account on this device
 * - POST /api/auth/accounts/remove → forget an account on this device
 *
 * The security boundary is the device: switching is only allowed to accounts
 * that previously authenticated on this exact device (unguessable httpOnly
 * `__device` cookie), and the POST endpoints additionally require the CSRF
 * token. The previous session is left alive but its cookies are replaced on
 * this browser — switching back works the same way.
 */

export async function knownAccountsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accounts = await listDeviceAccounts(request);

    let current: { id: string; email: string; name: string | null; photoUrl: string | null } | null = null;
    if (session) {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, name: true, photoUrl: true },
      });
      if (user) current = user;
    }

    return NextResponse.json({ accounts, current });
  } catch (err: any) {
    console.error('[AUTH/ACCOUNTS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to list accounts' }, { status: 500 });
  }
}

export async function switchAccountHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    if (!validateCsrf(request)) return jsonForbidden('Invalid security token');

    let userId = '';
    try {
      const body: any = await request.json();
      userId = String(body?.userId || '');
    } catch {
      return NextResponse.json({ error: 'userId required' }, { status: 400 });
    }
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    // Only accounts previously authenticated on THIS device can be switched to.
    if (!(await isKnownDeviceAccount(request, userId))) {
      return jsonForbidden('This account is not recognized on this device');
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, photoUrl: true, isBanned: true, isSuspended: true },
    });
    if (!target) return jsonUnauthorized();
    if (target.isBanned || target.isSuspended) {
      return jsonForbidden('This account is currently unavailable');
    }

    // Already on this account — no-op.
    if (session.userId === target.id) {
      return NextResponse.json({
        user: { id: target.id, email: target.email, name: target.name, photoUrl: target.photoUrl },
        switched: false,
      });
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      undefined;
    const userAgent = request.headers.get('user-agent') || undefined;

    const { token, refreshToken } = await createSession(target.id, userAgent, ip);
    const res = NextResponse.json({
      user: { id: target.id, email: target.email, name: target.name, photoUrl: target.photoUrl },
      switched: true,
    });
    setSessionCookie(res, token, refreshToken, request);
    return res;
  } catch (err: any) {
    console.error('[SWITCH-ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to switch account' }, { status: 500 });
  }
}

export async function removeKnownAccountHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    if (!validateCsrf(request)) return jsonForbidden('Invalid security token');

    const body: any = await request.json().catch(() => ({}));
    const userId = String(body?.userId || '');
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    await removeDeviceAccount(request, userId);
    return NextResponse.json({ removed: true });
  } catch (err: any) {
    console.error('[REMOVE-ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to remove account' }, { status: 500 });
  }
}
