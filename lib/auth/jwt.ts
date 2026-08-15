import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return new TextEncoder().encode(secret);
}

const COOKIE_NAME = '__session';

interface SessionPayload extends JWTPayload {
  sub: string;
  sid: string;
  adminRole?: string;
}

export async function signToken(userId: string, sessionId: string, adminRole?: string): Promise<string> {
  const payload: Record<string, any> = { sub: userId, sid: sessionId };
  if (adminRole) payload.adminRole = adminRole;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
     .setExpirationTime('15m')
     .sign(getSecret());
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (!payload.sub || !payload.sid) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export async function signTemp2faToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: '2fa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(getSecret());
}

export async function verifyTemp2faToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === '2fa') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export async function signTempPasswordChangeToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'password-change' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());
}

export async function verifyTempPasswordChangeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'password-change') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export async function signPasswordResetToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'password-reset' })    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecret());
}

export async function verifyPasswordResetToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'password-reset') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export async function signRecoveryToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'account-recovery' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecret());
}

export async function verifyRecoveryToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'account-recovery') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export async function signSuspiciousLoginToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'suspicious-login' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecret());
}

export async function verifySuspiciousLoginToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'suspicious-login') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export { COOKIE_NAME };

export async function signSessionRevokeToken(sessionId: string): Promise<string> {
  return new SignJWT({ sub: sessionId, purpose: 'session-revoke' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret());
}

export async function verifySessionRevokeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'session-revoke') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export interface MagicLinkPayload {
  userId: string;
  jti: string;
  expiresAt: number;
}

export async function signMagicLinkToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'magic-link' })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecret());
}

export async function verifyMagicLinkToken(token: string): Promise<MagicLinkPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'magic-link' && payload.jti) {
      const exp = typeof payload.exp === 'number' ? payload.exp : 0;
      return { userId: payload.sub as string, jti: payload.jti as string, expiresAt: exp };
    }
    return null;
  } catch {
    return null;
  }
}

export async function signOauthStateToken(nonce: string, redirect?: string, link?: boolean): Promise<string> {
  return new SignJWT({ purpose: 'oauth-state', nonce, redirect: redirect || '', link: !!link })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());
}

export async function verifyOauthStateToken(
  token: string,
): Promise<{ nonce: string; redirect: string; link: boolean } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'oauth-state' || !payload.nonce) return null;
    return { nonce: payload.nonce as string, redirect: (payload.redirect as string) || '', link: !!payload.link };
  } catch {
    return null;
  }
}

export async function signMergeToken(data: {
  provider: string;
  providerId: string;
  email: string;
  name: string;
  photoUrl?: string;
  existingUserId: string;
}): Promise<string> {
  return new SignJWT({ purpose: 'merge-account', ...data })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());
}

export async function verifyMergeToken(
  token: string,
): Promise<{ provider: string; providerId: string; email: string; name: string; photoUrl?: string; existingUserId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'merge-account') return null;
    return {
      provider: payload.provider as string,
      providerId: payload.providerId as string,
      email: payload.email as string,
      name: payload.name as string,
      photoUrl: (payload.photoUrl as string) || undefined,
      existingUserId: payload.existingUserId as string,
    };
  } catch {
    return null;
  }
}
