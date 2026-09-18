import { NextRequest, NextResponse } from 'next/server';
import { requireSession, getAdminRole } from '@/features/auth/http-guards';

export const runtime = 'nodejs';

/**
 * GET /api/cdn/me — signed-in member identity for the CDN app:
 *   id:   for building permanent public file URLs like /u/<ownerId>/...
 *   role: company role ('manager'|'admin'|'super_admin'|'member'|...) —
 *         drives the client-side gate for permanent deletes.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  const role = await getAdminRole(session.userId);
  return NextResponse.json({ id: session.userId, role: role ?? 'member' });
}
