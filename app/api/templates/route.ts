import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/features/auth/session';
import { listTemplates } from '@/features/forms/formTemplates';

// GET /api/templates — template catalog for the forms app (auth required).
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json(listTemplates());
  } catch (error: any) {
    console.error('[TEMPLATES] GET error:', error?.message);
    return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 });
  }
}
