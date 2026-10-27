import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withPermission } from '@/features/auth/permission-guard';

/* The provider row holds live credentials, and this response is rendered into a
   browser. So the secrets are answered as *presence* — "a key is set" — and never
   as the key. Nothing on the mail-config screen needs to see the value: it shows a
   filled dot, and the operator who wants to change the credential types a new one.

   PUT keeps the same rule from the other side. A blank secret means "leave what is
   stored alone", not "erase it" — the form cannot prefill what it was never shown,
   so erasing on blank would delete a working key the moment anybody saved an
   unrelated field. Clearing a credential is done by setting `enabled` false or
   replacing the provider, not by leaving a box empty. */

/** Every field the screen is allowed to see, plus the two secrets as booleans. */
function present(config: any) {
  const { resendApiKey, smtpPass, ...safe } = config;
  return {
    ...safe,
    resendApiKeySet: !!resendApiKey,
    smtpPassSet: !!smtpPass,
    fromEmail: config.defaultFromEmail,
    fromName: config.defaultFromName,
    enabled: true,
  };
}

const NEVER_CONFIGURED = {
  provider: 'resend',
  fromEmail: 'noreply@tirbeo.com',
  fromName: 'Tirbeo',
  enabled: false,
  resendApiKeySet: false,
  smtpPassSet: false,
};

/* The mail transport is a connection the server makes on somebody else's say-so.
   `email.configure` is an owner-level permission, so this is an insider check
   rather than an outside one — but the shape it accepts is still worth bounding:
   a `smtpPort` that isn't a number used to reach the database as NaN (a 500 with
   a half-saved config), and a host of `169.254.169.254` makes the mailer a probe
   for the cloud metadata service. A private VPC relay on 10.x stays allowed: that
   is a legitimate postmark/SMTP gateway, and the operator who sets it is the same
   person who owns the network. */

const PROVIDERS = new Set(['resend', 'smtp']);
const LOOPBACK_AND_METADATA = /^(127\.|0\.0\.0\.0|\[?::1\]?|169\.254\.169\.254|metadata\.google\.internal$|localhost$|.*\.local$|.*\.internal$)/i;

/** Bare hostname or IPv6 literal — no scheme, no credentials, no port suffix. */
function isBareHostname(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const h = raw.trim();
  if (!h || h.length > 253) return false;
  if (h.includes('://') || h.includes('@') || h.includes('/') || h.includes(' ') || h.includes(':') && !h.startsWith('[')) return false;
  if (/^\[?[a-f0-9:]+\]?$/i.test(h.replace(/[[\]]/g, '')) && h.includes(':')) return true; // IPv6 literal
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

function invalidSmtpField(body: any): string | null {
  const { provider, smtpHost, smtpPort } = body;
  if (provider !== undefined && !PROVIDERS.has(String(provider))) return "provider must be 'resend' or 'smtp'";
  if (smtpHost !== undefined && smtpHost !== null && smtpHost !== '') {
    if (!isBareHostname(smtpHost)) return 'smtpHost must be a bare hostname with no scheme, port, or credentials';
    if (LOOPBACK_AND_METADATA.test(String(smtpHost).trim())) return 'smtpHost must not be a loopback or cloud-metadata address';
  }
  if (smtpPort !== undefined && smtpPort !== null && smtpPort !== '') {
    const port = Number(smtpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'smtpPort must be an integer between 1 and 65535';
  }
  return null;
}

export const GET = withPermission('email.read', async (_request, _session) => {

  const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!config) return NextResponse.json(NEVER_CONFIGURED);
  return NextResponse.json(present(config));
});

export const PUT = withPermission('email.configure', async (request, _session) => {

  const body: any = await request.json();
  const { provider, apiKey, smtpUser, smtpPass, fromEmail, fromName } = body;

  const refusal = invalidSmtpField(body);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
  const smtpHost = typeof body.smtpHost === 'string' ? body.smtpHost.trim() : body.smtpHost;
  const smtpPort = body.smtpPort === undefined || body.smtpPort === null || body.smtpPort === ''
    ? body.smtpPort
    : Number(body.smtpPort);

  const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  const secret = (incoming: unknown, stored: string | null | undefined) => {
    const value = typeof incoming === 'string' ? incoming.trim() : '';
    return value || stored || null;
  };

  const data = {
    provider,
    resendApiKey: secret(apiKey, config?.resendApiKey),
    smtpHost: smtpHost || null,
    smtpPort: smtpPort || null,
    smtpUser: smtpUser || null,
    smtpPass: secret(smtpPass, config?.smtpPass),
    defaultFromEmail: fromEmail || 'noreply@tirbeo.com',
    defaultFromName: fromName || 'Tirbeo' };

  const saved = config
    ? await prisma.emailConfig.update({ where: { id: config.id }, data })
    : await prisma.emailConfig.create({ data });

  return NextResponse.json(present(saved));
});
