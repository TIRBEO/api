import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/features/auth/http-guards';
import { getOrCreatePrefs, updatePrefs } from '@/features/notifications/notifications';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const prefs = await getOrCreatePrefs(session.userId);
  return NextResponse.json(prefs);
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const prefs = await updatePrefs(session.userId, body);
  return NextResponse.json(prefs);
}
