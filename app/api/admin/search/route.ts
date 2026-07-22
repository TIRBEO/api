import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/session';
import { prisma } from '../../../../lib/db/prisma';

const SEARCHABLE_PAGES = [
  { label: 'Dashboard', url: '/', category: 'Page' },
  { label: 'Routes', url: '/routes', category: 'Page' },
  { label: 'Monitor', url: '/monitor', category: 'Page' },
  { label: 'Users', url: '/users', category: 'Page' },
  { label: 'Workspaces', url: '/workspaces', category: 'Page' },
  { label: 'Roles', url: '/settings/roles', category: 'Page' },
  { label: 'Audit Trail', url: '/monitor/audit', category: 'Page' },
  { label: 'Email Config', url: '/settings/email', category: 'Page' },
  { label: 'Email Templates', url: '/settings/email/templates', category: 'Page' },
  { label: 'Notifications', url: '/settings/notifications', category: 'Page' },
  { label: 'Moderation', url: '/moderation', category: 'Page' },
  { label: 'Domains', url: '/settings/domains', category: 'Page' },
  { label: 'Landing Settings', url: '/settings/landing', category: 'Settings' },
  { label: 'Accounts Settings', url: '/settings/accounts', category: 'Settings' },
  { label: 'Dashboard Settings', url: '/settings/dashboard', category: 'Settings' },
  { label: 'Admin Settings', url: '/settings/admin', category: 'Settings' },
  { label: 'API Settings', url: '/settings/api', category: 'Settings' },
];

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const q = (request.nextUrl.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return NextResponse.json({ pages: [], users: [], routes: [] });

  const [users, routes] = await Promise.all([
    prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, name: true, adminRole: true },
      take: 5,
    }),
    prisma.route.findMany({
      where: {
        OR: [
          { path: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, path: true, method: true },
      take: 5,
    }),
  ]);

  const pages = SEARCHABLE_PAGES.filter(p =>
    p.label.toLowerCase().includes(q) || p.url.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
  );

  return NextResponse.json({ pages, users, routes });
}
