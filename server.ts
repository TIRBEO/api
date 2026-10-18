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

// This process is the long-lived one: on a self-host box it also hosts the
// periodic jobs and the WebSocket server, so a stray rejection must not be
// allowed to take all of that down. Node >=15 exits on an unhandled rejection,
// and the floating promises here are deliberate — fire-and-forget logging,
// cache busts, `.catch()`-ed writes that occasionally reject after their guard
// was attached. Surfacing them loudly is the right response; killing realtime
// and the deletion sweep for one is not.
process.on('unhandledRejection', (reason: any) => {
  console.error('[PROCESS] unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (e: any) => {
  console.error('[PROCESS] uncaught exception:', e?.stack || e?.message || e);
});

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    // A handler that rejects must close the socket, not unwind into the
    // process — an uncaught throw here used to take the whole server with it.
    Promise.resolve(handle(req, res, parsedUrl)).catch((e: any) => {
      console.error('[SERVER] request failed:', e?.message || e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"Internal server error"}');
    });
  });

  server.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`> Port ${port} is already in use — stop whatever holds it, or start with PORT=<other port>`);
    } else {
      console.error('[SERVER] listen failed:', e?.message || e);
    }
    process.exit(1);
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
      const { startPeriodicCleanup, startPeriodicSummaries, startPeriodicDeletionSweep, startPeriodicPushPrune, startPeriodicReactivation } = require('@/jobs/jobs');
      const { startPeriodicTips } = require('@/features/users/tips');

      startPeriodicCleanup();
      startPeriodicSummaries();
      startPeriodicDeletionSweep();
      startPeriodicPushPrune();
      startPeriodicTips();
      startPeriodicReactivation();
      // Email Brain is retired: its queue worker polled deleted tables
      // (email_jobs.dedupe_key, email_events) and spammed errors every tick.
      // Transactional + digest email still runs through features/email.

      // Query performance alerts
      try {
        const { setupQueryAlerts } = require('@/infrastructure/observability/queryAlertSetup');
        setupQueryAlerts();
      } catch (e: any) {
        console.warn('[QUERY-ALERT] Setup skipped:', e?.message || e);
      }

      // WebSocket server
      if (wsPort && wsPort > 0) {
        try {
          const { startWsServer } = require('@/infrastructure/realtime/ws/server');
          startWsServer(wsPort);
          console.log(`> WebSocket server ready on ws://${hostname}:${wsPort}`);
        } catch (e: any) {
          console.warn(`[WS] Embedded WS server skipped: ${e?.message || e}`);
          console.log(`> WebSocket service: use external realtime server (ws.tirbeo.com)`);
        }
      } else {
        console.log(`> WebSocket service: external realtime server (ws.tirbeo.com)`);
      }
    }
  });
}).catch((e: any) => {
  // Nothing listens if Next never prepared, so staying up would only hide the
  // failure behind a port that answers nothing.
  console.error('[SERVER] failed to prepare Next app:', e?.stack || e?.message || e);
  process.exit(1);
});
