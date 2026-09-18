import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { getPoolStatus } from '@/infrastructure/db/prisma';

const dev = process.env.NODE_ENV !== 'production';
const isVercel = !!process.env.VERCEL;
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
// Dev default: embed the WebSocket server on :3001 so local apps get realtime
// without extra env setup. Set WS_PORT explicitly to override (0 disables).
const wsPort = process.env.WS_PORT !== undefined
  ? parseInt(process.env.WS_PORT || '', 10)
  : dev && !isVercel
    ? 3001
    : 0;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  server.listen(port, () => {
    console.log(`> Next.js ready on http://${hostname}:${port}`);

    // Log pool status after warm-up (1s delay)
    setTimeout(() => {
      const pool = getPoolStatus();
      if (pool) {
        console.log(`> DB pool: ${pool.totalCount} total, ${pool.idleCount} idle, ${pool.waitingCount} waiting`);
      }
    }, 1500);

    if (isVercel) {
      // ── Vercel Serverless: no setInterval jobs ──
      // Jobs run via /api/cron (Vercel Cron) and on-demand gate checks.
      console.log('[SERVER] Vercel mode — periodic jobs disabled (use /api/cron)');
    } else {
      // ── Local / self-hosted: start periodic jobs ──
      const { startPeriodicCleanup, startPeriodicDigests, startPeriodicDeletionSweep, startPeriodicPushPrune, startPeriodicReactivation } = require('@/jobs/jobs');
      const { startPeriodicTips } = require('@/features/users/tips');
      const { startEmailBrainWorkers } = require('@/features/email-brain/worker');

      startPeriodicCleanup();
      startPeriodicDigests();
      startPeriodicDeletionSweep();
      startPeriodicPushPrune();
      startPeriodicTips();
      startPeriodicReactivation();
      startEmailBrainWorkers();

      // Query performance alerts
      try {
        const { setupQueryAlerts } = require('@/infrastructure/observability/queryAlertSetup');
        setupQueryAlerts();
      } catch (e: any) {
        console.warn('[QUERY-ALERT] Setup skipped:', e?.message || e);
      }

      // Company CDN events on the WS channel "cdn" for other apps.
      try {
        const { startCdnWsBridge } = require('@/features/media/cdnWsBridge');
        startCdnWsBridge();
      } catch (e: any) {
        console.warn('[CDN-WS] Bridge skipped:', e?.message || e);
      }

      // CDN control plane follower: execute leader cache commands (warm/clear)
      // arriving on the CDN event bus, so every instance converges instantly.
      try {
        const { bindCdnControlFollower } = require('@/features/media/cdnControl');
        bindCdnControlFollower();
      } catch (e: any) {
        console.warn('[CDN-CTL] Follower binding skipped:', e?.message || e);
      }

      // WebSocket server
      if (wsPort && wsPort > 0) {
        try {
          const { startWsServer } = require('@/infrastructure/realtime/ws/server');
          startWsServer(wsPort);
          console.log(`> WebSocket server ready on ws://${hostname}:${wsPort}`);
        } catch (e: any) {
          console.warn(`[WS] Embedded WS server skipped: ${e?.message || e}`);
          console.log(`> WebSocket service: use external realtime server (ws.tirbeo.app)`);
        }
      } else {
        console.log(`> WebSocket service: external realtime server (ws.tirbeo.app)`);
      }
    }
  });
});
