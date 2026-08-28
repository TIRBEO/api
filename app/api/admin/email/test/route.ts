import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../lib/session';
import { sendTemplateEmail } from '../../../../../lib/email';

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const { to } = body;

  if (!to) return NextResponse.json({ error: 'Missing recipient email' }, { status: 400 });

  const result = await sendTemplateEmail(to, 'admin_test', { sentFor: 'Tirbeo Admin' });

  if (result.success) return NextResponse.json({ ok: true, messageId: result.messageId });
  return NextResponse.json({ error: result.error }, { status: 500 });
}
