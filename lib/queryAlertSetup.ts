/**
 * Query Performance Alert Setup
 * 
 * Wires the query monitor's latency alerts to the existing admin
 * notification system. When a query's P95 exceeds the configured
 * threshold, admins receive:
 *   - An in-app notification (via WebSocket)
 *   - An email alert (throttled to once per query per 5 min)
 * 
 * Import this module once at app startup to enable alerts.
 */

import { onLatencyAlert } from './queryMonitor';
import type { LatencyAlert } from './queryMonitor';

let initialized = false;

export function setupQueryAlerts() {
  if (initialized) return;
  initialized = true;

  onLatencyAlert(async (alert: LatencyAlert) => {
    try {
      // Dynamic imports to avoid circular dependencies
      const { notifyAdmins } = await import('./security');
      const { getApiOrigin } = await import('./branding');

      const dashboardUrl = `${getApiOrigin().replace('api.', 'admin.')}`;
      const severityIcon = alert.severity === 'critical' ? '🔴' : '🟡';
      const severityLabel = alert.severity.toUpperCase();

      await notifyAdmins({
        subject: `${severityIcon} Query Performance ${severityLabel}: ${alert.queryName}`,
        message: `Query "${alert.queryName}" has a P95 latency of ${alert.p95Ms}ms, exceeding the ${alert.severity} threshold of ${alert.thresholdMs}ms. This may indicate a slow query that needs optimization.`,
        details: [
          `Query: ${alert.queryName}`,
          `P95 Latency: ${alert.p95Ms}ms`,
          `Threshold: ${alert.thresholdMs}ms (${alert.severity})`,
          `Time: ${new Date(alert.firedAt).toISOString()}`,
          `Dashboard: ${dashboardUrl}/admin/developer/query-performance`,
        ].join('\n'),
        severity: alert.severity === 'critical' ? 'critical' : 'warning',
      });

      console.log(`[QUERY-ALERT] Admin notification sent for ${alert.severity} alert on ${alert.queryName}`);
    } catch (err: any) {
      console.error('[QUERY-ALERT] Failed to send admin notification:', err?.message || err);
    }
  });

  console.log('[QUERY-ALERT] Latency alert system initialized');
}
