import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '../../../../lib/session';
import { getRateLimitMetrics, ROUTE_LIMITS, getRateLimitConfigForExport, getBlockRateAlerts } from '../../../../lib/auth/rate-limit';

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
