import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../lib/session';
import { sendEmail } from '../../../../../lib/email';

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { to } = body;

  if (!to) return NextResponse.json({ error: 'Missing recipient email' }, { status: 400 });

  const result = await sendEmail(
    to,
    'Test Email from Tirbeo Admin',
    '<h2>Test Email</h2><p>If you\'re reading this, your email configuration works!</p><p>Sent from <strong>Tirbeo Admin</strong></p>'
  );

  if (result.success) return NextResponse.json({ ok: true, messageId: result.messageId });
  return NextResponse.json({ error: result.error }, { status: 500 });
}
