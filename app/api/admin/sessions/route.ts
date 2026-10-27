import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listSessions, revokeSessionById } from '@/features/admin/devices';
import { clientIpOrUnknown } from '@/shared/client-ip';

/* /api/admin/sessions — who is signed in right now, and the one button that
 * ends it.
 *
 *   GET  → the sessions, newest activity first. `live=1` asks for the ones that
 *          would still let someone in; `live=0` for the ones that would not.
 *   POST → { sessionId } ends exactly one session.
 *
 * The read needs `security.read`; the write needs `people.manage`. Those are
 * different keys on purpose — reading the fact that a device is signed in is
 * watching, and cutting it off is changing somebody's account, which is the
 * power the directory screens already hand out. */

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const live = p.get('live');
  const { rows, total, page, limit } = await listSessions({
    page: Number(p.get('page')) || 1,
    limit: Number(p.get('limit')) || 50,
    q: p.get('q') || undefined,
    userId: p.get('userId') || undefined,
    liveOnly: live === '1' || live === 'true' ? true : live === '0' || live === 'false' ? false : undefined,
  });

  return NextResponse.json({ rows, total, page, limit }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: NextRequest) {
  const operator = await requirePermission(request, 'people.manage');
  if (operator instanceof NextResponse) return operator;

  const body = await request.json().catch(() => ({} as any));
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const ip = clientIpOrUnknown(request.headers);
  const { checkWindowLimitDB } = await import('@/features/captcha/risk');
  /* A ceiling on the ending of sessions, not on reading them. An operator
     working a stolen-account report revokes a handful in a row; a script
     pounding this endpoint with other people's session ids is the thing that
     must not be cheap, and the audit row says who tried. */
  if (!(await checkWindowLimitDB(`admin:session-revoke:${operator.userId}`, 30, 15 * 60 * 1000, ip))) {
    return NextResponse.json(
      { error: 'Too many sessions ended just now. Wait a few minutes before ending another.' },
      { status: 429 },
    );
  }

  const result = await revokeSessionById(sessionId, { id: operator.userId, email: operator.email });
  if (!result.ok) {
    const message =
      result.reason === 'already_revoked'
        ? 'That session was already ended — nobody is using it.'
        : 'There is no session with that id. It has probably expired and been cleaned up.';
    return NextResponse.json({ error: message, reason: result.reason }, { status: 409 });
  }

  return NextResponse.json({ ok: true, sessionId });
}
