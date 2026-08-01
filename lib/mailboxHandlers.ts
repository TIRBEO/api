import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { cfCreateForwardRule, cfDeleteForwardRule, cfUpdateForwardRule, cfIsConfigured } from './cloudflare';
import { isReservedAddress } from './reservedCache';
import { jsonUnauthorized } from './response';

const VALID_ADDRESS = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

function resolveForwardDomain(): string {
  return process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
}

export async function mailboxGetHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) return jsonUnauthorized();

    const mailbox = await prisma.user_mailboxes.findUnique({
      where: { userId: session.userId },
      select: { id: true, address: true, forwardTo: true, isActive: true, verified: true, createdAt: true },
    });

    if (!mailbox) {
      return NextResponse.json({ configured: false, cloudflareConfigured: cfIsConfigured() });
    }

    const domain = resolveForwardDomain();
    return NextResponse.json({
      configured: true,
      ...mailbox,
      fullAddress: `${mailbox.address}#${domain}`,
      cloudflareConfigured: cfIsConfigured(),
    });
  } catch (err: any) {
    console.error('[MAILBOX GET]', err?.message || err);
    return new NextResponse('Failed to load mailbox', { status: 500 });
  }
}

export async function mailboxCreateHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) return jsonUnauthorized();

    const existing = await prisma.user_mailboxes.findUnique({ where: { userId: session.userId } });
    if (existing) return new NextResponse('Mailbox already configured. Update or delete it first.', { status: 409 });

    const body = await request.json();
    const { address, forwardTo } = body;

    if (!address || typeof address !== 'string') {
      return new NextResponse('Address is required', { status: 400 });
    }
    if (!forwardTo || typeof forwardTo !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardTo)) {
      return new NextResponse('A valid forwarding email is required', { status: 400 });
    }

    const clean = address.toLowerCase().trim().replace(/[#@\s]/g, '');
    if (!VALID_ADDRESS.test(clean)) {
      return new NextResponse('Address must be 3-32 chars: lowercase letters, numbers, dots, hyphens, underscores', { status: 400 });
    }
    const reserved = await isReservedAddress(clean);
    if (reserved.blocked) {
      return new NextResponse(reserved.reason || 'This address is reserved', { status: 409 });
    }
    if (clean.startsWith('.') || clean.endsWith('.') || clean.includes('..')) {
      return new NextResponse('Address cannot start/end with dots or have consecutive dots', { status: 400 });
    }

    const taken = await prisma.user_mailboxes.findUnique({ where: { address: clean } });
    if (taken) return new NextResponse('Address already taken', { status: 409 });

    const domain = resolveForwardDomain();
    let cfStatus = 'not_configured';

    const mailbox = await prisma.user_mailboxes.create({
      data: { userId: session.userId, address: clean, forwardTo, isActive: true },
      select: { id: true, address: true, forwardTo: true, isActive: true, verified: true, createdAt: true },
    });

    if (cfIsConfigured()) {
      const cfResult = await cfCreateForwardRule(clean, domain, forwardTo);
      cfStatus = cfResult.ok ? 'created' : 'failed';
      if (!cfResult.ok) {
        console.warn('[MAILBOX] Cloudflare auto-config failed:', cfResult.error);
      }
    }

    return NextResponse.json({
      ...mailbox,
      fullAddress: `${clean}#${domain}`,
      cloudflareStatus: cfStatus,
      message: cfStatus === 'created'
        ? 'Mailbox created and forwarding configured automatically.'
        : cfStatus === 'failed'
          ? 'Mailbox created. Cloudflare auto-config failed — set up manually.'
          : 'Mailbox created. Set up Cloudflare Email Routing to activate forwarding.',
    }, { status: 201 });
  } catch (err: any) {
    console.error('[MAILBOX CREATE]', err?.message || err);
    return new NextResponse('Failed to create mailbox', { status: 500 });
  }
}

export async function mailboxUpdateHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) return jsonUnauthorized();

    const mailbox = await prisma.user_mailboxes.findUnique({ where: { userId: session.userId } });
    if (!mailbox) return new NextResponse('No mailbox configured', { status: 404 });

    const body = await request.json();
    const data: Record<string, any> = {};

    if (body.forwardTo !== undefined) {
      if (typeof body.forwardTo !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.forwardTo)) {
        return new NextResponse('Invalid forwarding email', { status: 400 });
      }
      data.forwardTo = body.forwardTo;
      data.verified = false;
    }

    if (body.isActive !== undefined) {
      data.isActive = !!body.isActive;
    }

    if (Object.keys(data).length === 0) {
      return new NextResponse('Nothing to update', { status: 400 });
    }

    const updated = await prisma.user_mailboxes.update({
      where: { userId: session.userId },
      data,
      select: { id: true, address: true, forwardTo: true, isActive: true, verified: true, createdAt: true },
    });

    const domain = resolveForwardDomain();

    if (cfIsConfigured() && data.forwardTo) {
      const cfResult = await cfUpdateForwardRule(mailbox.address, domain, data.forwardTo);
      if (!cfResult.ok) {
        console.warn('[MAILBOX] Cloudflare update failed:', cfResult.error);
      }
    }

    return NextResponse.json({ ...updated, fullAddress: `${updated.address}#${domain}` });
  } catch (err: any) {
    console.error('[MAILBOX UPDATE]', err?.message || err);
    return new NextResponse('Failed to update mailbox', { status: 500 });
  }
}

export async function mailboxDeleteHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) return jsonUnauthorized();

    const mailbox = await prisma.user_mailboxes.findUnique({ where: { userId: session.userId } });
    if (!mailbox) return new NextResponse('No mailbox configured', { status: 404 });

    const domain = resolveForwardDomain();
    if (cfIsConfigured()) {
      await cfDeleteForwardRule(mailbox.address, domain);
    }

    await prisma.user_mailboxes.delete({ where: { userId: session.userId } });
    return new NextResponse('Mailbox released', { status: 200 });
  } catch (err: any) {
    console.error('[MAILBOX DELETE]', err?.message || err);
    return new NextResponse('Failed to delete mailbox', { status: 500 });
  }
}

export async function mailboxCheckHandler(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const address = sp.get('address');
    if (!address || typeof address !== 'string') {
      return new NextResponse('address query param required', { status: 400 });
    }
    const clean = address.toLowerCase().trim().replace(/[#@\s]/g, '');
    if (!VALID_ADDRESS.test(clean)) {
      return NextResponse.json({ available: false, reason: 'Invalid format' });
    }
    const reserved = await isReservedAddress(clean);
    if (reserved.blocked) {
      return NextResponse.json({ available: false, reason: reserved.reason || 'Reserved address' });
    }
    const taken = await prisma.user_mailboxes.findUnique({ where: { address: clean } });
    return NextResponse.json({ available: !taken, address: clean });
  } catch (err: any) {
    console.error('[MAILBOX CHECK]', err?.message || err);
    return new NextResponse('Failed to check address', { status: 500 });
  }
}

export async function mailboxDnsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) return jsonUnauthorized();

    const mailbox = await prisma.user_mailboxes.findUnique({ where: { userId: session.userId } });
    if (!mailbox) return new NextResponse('No mailbox configured', { status: 404 });

    const domain = resolveForwardDomain();

    return NextResponse.json({
      address: `${mailbox.address}#${domain}`,
      forwardTo: mailbox.forwardTo,
      cloudflareConfigured: cfIsConfigured(),
      instructions: {
        provider: 'cloudflare',
        steps: [
          '1. Go to Cloudflare Dashboard -> Email -> Email Routing',
          `2. Create a forwarding rule for ${domain}`,
          `3. Add catch-all or specific rule:`,
        ],
        mxRecord: { type: 'MX', name: domain, value: 'route1.mx.cloudflare.net', priority: 65 },
        routingRule: `${mailbox.address}@${domain} -> ${mailbox.forwardTo}`,
        note: 'DNS propagation may take up to 24 hours. Cloudflare Email Routing is free.',
      },
    });
  } catch (err: any) {
    console.error('[MAILBOX DNS]', err?.message || err);
    return new NextResponse('Failed to load DNS info', { status: 500 });
  }
}
