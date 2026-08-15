import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getNotificationPrefs, updateNotificationPrefs } from '@/lib/push-notifications';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const prefs = await getNotificationPrefs(session.userId);
    
    return NextResponse.json({
      email: prefs.email,
      push: prefs.push,
      inApp: prefs.inApp,
      security: prefs.security,
      product: prefs.product,
      support: prefs.support,
    });
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Get prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch preferences' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const body: any = await request.json();
    
    // Only update allowed fields
    const allowedFields = ['email', 'push', 'inApp', 'security', 'product', 'support'];
    const updateData: Record<string, boolean> = {};
    
    for (const field of allowedFields) {
      if (field in body && typeof body[field] === 'boolean') {
        updateData[field] = body[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const prefs = await updateNotificationPrefs(session.userId, updateData);
    
    return NextResponse.json({
      email: prefs.email,
      push: prefs.push,
      inApp: prefs.inApp,
      security: prefs.security,
      product: prefs.product,
      support: prefs.support,
    });
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Update prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}