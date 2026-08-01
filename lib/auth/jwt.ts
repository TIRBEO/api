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
    .setExpirationTime('7d')
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

export async function signPasswordResetToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'password-reset' })
    .setProtectedHeader({ alg: 'HS256' })
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

export async function signMagicLinkToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'magic-link' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecret());
}

export async function verifyMagicLinkToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.sub && payload.purpose === 'magic-link') return payload.sub as string;
    return null;
  } catch {
    return null;
  }
}

export async function signOauthStateToken(nonce: string, redirect?: string): Promise<string> {
  return new SignJWT({ purpose: 'oauth-state', nonce, redirect: redirect || '' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());
}

export async function verifyOauthStateToken(
  token: string,
): Promise<{ nonce: string; redirect: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'oauth-state' || !payload.nonce) return null;
    return { nonce: payload.nonce as string, redirect: (payload.redirect as string) || '' };
  } catch {
    return null;
  }
}
