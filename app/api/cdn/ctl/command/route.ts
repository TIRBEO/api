import { NextRequest, NextResponse } from 'next/server';
import { requireSession, getAdminRole, roleAtLeast } from '@/features/auth/http-guards';
import { cdnCommand, CDN_COMMANDS, type CdnCommandName } from '@/features/media/cdnControl';
import { logCdnActivity } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cdn/ctl/command — issue a control command to the CDN cluster.
 *
 * This is the leader's command channel: the central API authenticates the
 * caller with the SAME session cookies as every other route, validates the
 * command, executes it locally, and re-publishes the outcome on the CDN event
 * bus so follower instances (and every connected realtime client) execute /
 * observe it instantly.
 *
 * Body: { command: 'cache.warm' | 'cache.clear' | 'stats.broadcast' | 'stats.reset', fileIds?: string[] }
 *
 * Role gate: cache.warm / cache.clear / stats.reset require manager+;
 * stats.broadcast is open to every authenticated member (read-only). Every
 * accepted command is actor-logged to the CDN audit trail.
 */
const MANAGER_COMMANDS = new Set<string>(['cache.warm', 'cache.clear', 'stats.reset']);

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  let body: { command?: string; fileIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const command = String(body.command || '') as CdnCommandName;
  if (!CDN_COMMANDS.some((c) => c.name === command)) {
    return NextResponse.json(
      {
        error: 'Unknown command',
        allowed: CDN_COMMANDS.map((c) => c.name),
      },
      { status: 400 },
    );
  }

  const role = (await getAdminRole(session.userId)) ?? 'member';
  if (MANAGER_COMMANDS.has(command) && !roleAtLeast(role, 'manager')) {
    return NextResponse.json(
      { error: 'Only managers and admins can run this command.' },
      { status: 403 },
    );
  }

  const fileIds = Array.isArray(body.fileIds)
    ? (body.fileIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;

  try {
    const result = await cdnCommand(command, { fileIds });
    // Audit: who ran what, with what outcome.
    logCdnActivity({
      userId: session.userId,
      type: `cdn.ctl.${command.replace('.', '_')}`,
      metadata: { command, fileIds: fileIds?.slice(0, 50) ?? [], ok: result.ok },
    }).catch(() => {});
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[CDN-CTL] Command failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Command failed' }, { status: 500 });
  }
}

/** GET /api/cdn/ctl/command — advertise the available commands (discovery). */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  return NextResponse.json(
    { commands: CDN_COMMANDS },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
