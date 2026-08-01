import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonUnauthorized, jsonError, jsonForbidden } from './response';

const PROVIDER_CONFIG: Record<string, { name: string; authUrl: string; icon?: string }> = {
  google: { name: 'Google', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' },
  github: { name: 'GitHub', authUrl: 'https://github.com/login/oauth/authorize' },
  discord: { name: 'Discord', authUrl: 'https://discord.com/api/oauth2/authorize' },
};

export async function connectedAccountsListHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const accounts = await prisma.linkedAccount.findMany({
    where: { userId: session.userId },
    select: {
      id: true,
      provider: true,
      providerId: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    accounts,
    availableProviders: Object.entries(PROVIDER_CONFIG).map(([key, cfg]) => ({
      id: key,
      name: cfg.name,
      connected: accounts.some(a => a.provider === key),
    })),
  });
}

export async function connectedAccountsLinkHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  let body: any;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON body'); }

  const { provider } = body || {};
  if (!provider || !PROVIDER_CONFIG[provider]) {
    return jsonError(`Invalid provider. Supported: ${Object.keys(PROVIDER_CONFIG).join(', ')}`);
  }

  const existing = await prisma.linkedAccount.findUnique({
    where: { provider_providerId: { provider, providerId: 'pending' } },
  }).catch(() => null);

  const callbackUrl = `${process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app'}/api/auth/${provider}/callback?link=1`;

  let authUrl = PROVIDER_CONFIG[provider].authUrl;
  const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  if (!clientId) {
    return jsonError(`${provider} OAuth is not configured`);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: provider === 'google' ? 'openid email profile' :
           provider === 'github' ? 'read:user user:email' :
           'identify email',
    state: JSON.stringify({ userId: session.userId, action: 'link' }),
  });

  authUrl += `?${params.toString()}`;

  return NextResponse.json({ authUrl, provider });
}

export async function connectedAccountsDeleteHandler(request: NextRequest, accountId: string) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const account = await prisma.linkedAccount.findUnique({
    where: { id: accountId },
    select: { userId: true, provider: true },
  });

  if (!account) return jsonError('Account not found', 404);
  if (account.userId !== session.userId) return jsonForbidden('Not your account');

  await prisma.linkedAccount.delete({ where: { id: accountId } });

  return NextResponse.json({ success: true, unlinked: account.provider });
}
