import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/features/auth/http-guards';
import { getRateLimitMetrics, ROUTE_LIMITS, getRateLimitConfigForExport, getBlockRateAlerts } from '@/features/auth/rate-limit';
import { prisma } from '@/infrastructure/db/prisma';
import { unblockTarget } from '@/features/security/security';

// GET /api/admin/rate-limits - Get rate limit metrics
export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const metrics = getRateLimitMetrics();
  const config = await getRateLimitConfigForExport();
  const alerts = getBlockRateAlerts();
  
  return NextResponse.json({
    metrics,
    config: {
      routeLimits: ROUTE_LIMITS,
      rateLimitEnabled: config.rateLimitEnabled,
      rateLimitPerMinute: config.rateLimitPerMinute,
      adminRoleMultipliers: config.adminRoleMultipliers,
      blockRateAlertThreshold: config.blockRateAlertThreshold,
      blockRateAlertEnabled: config.blockRateAlertEnabled,
      blockRateAlertCooldown: config.blockRateAlertCooldown,
    },
    alerts,
  });
}

// POST /api/admin/rate-limits/clear - Reset attempts for email/ip (DB + Blocklist)
export async function POST(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;
  const body: any = await request.json().catch(()=> ({}));
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  const clearAll = !!body.clearAll;

  let deletedAttempts = 0;
  let unblocked = 0;
  try {
    if (clearAll) {
      const r = await prisma.securityEvent.deleteMany({ where: { eventType: 'auth.attempt' } });
      deletedAttempts = r.count;
      await prisma.blocklist.deleteMany({ where: { targetType: 'ip' } });
      unblocked = 1;
    } else {
      if (email) {
        const r = await prisma.securityEvent.deleteMany({ where: { eventType: 'auth.attempt', metadata: { path: ['email'], equals: email } as any } });
        deletedAttempts += r.count;
        // Also clear by key containing email
        const r2 = await prisma.securityEvent.deleteMany({ where: { eventType: 'auth.attempt', metadata: { path: ['key'], string_contains: email } as any } });
        deletedAttempts += r2.count;
      }
      if (ip) {
        const r = await prisma.securityEvent.deleteMany({ where: { eventType: 'auth.attempt', ipAddress: ip } });
        deletedAttempts += r.count;
        await unblockTarget('ip', ip).catch(()=>{});
        unblocked++;
      }
      if (!email && !ip) {
        return NextResponse.json({ error: 'Provide email or ip to clear' }, { status: 400 });
      }
    }
    // Clear in-memory windows
    const { clearRateLimitsByPattern } = await import('@/features/captcha/risk');
    if (email) clearRateLimitsByPattern(email);
    if (ip) clearRateLimitsByPattern(ip);
    if (clearAll) {
      const { clearRateLimits } = await import('@/features/captcha/risk');
      clearRateLimits();
    }
    return NextResponse.json({ ok: true, deletedAttempts, unblocked });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to clear' }, { status: 500 });
  }
}

// DELETE /api/admin/users/:id already handles delete user — no extra change needed
