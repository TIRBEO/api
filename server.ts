import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { getPoolStatus } from './lib/db/prisma';
import { startPeriodicCleanup, startPeriodicDigests, startPeriodicDeletionSweep } from './lib/jobs';
import { startPeriodicTips } from './lib/tips';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const wsPort = parseInt(process.env.WS_PORT || '', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  server.listen(port, () => {
    console.log(`> Next.js ready on http://${hostname}:${port}`);

    // Log pool status after warm-up completes (1s delay to let async warm-up finish)
    setTimeout(() => {
      const pool = getPoolStatus();
      if (pool) {
        console.log(`> DB pool: ${pool.totalCount} total, ${pool.idleCount} idle, ${pool.waitingCount} waiting`);
      }
    }, 1500);

    // Start periodic notification cleanup (hourly)
    startPeriodicCleanup();
    // Start periodic email digests (hourly)
    startPeriodicDigests();
    startPeriodicDeletionSweep();
    startPeriodicTips();

    // Enable query performance latency alerts
    try {
      const { setupQueryAlerts } = require('./lib/queryAlertSetup');
      setupQueryAlerts();
    } catch (e: any) {
      console.warn('[QUERY-ALERT] Setup skipped:', e?.message || e);
    }

    // Start embedded WS server only if WS_PORT is set and port is available.
    // In production the realtime service runs separately at ws.tirbeo.app.
    if (wsPort && wsPort > 0) {
      try {
        const { startWsServer } = require('./lib/ws/server');
        startWsServer(wsPort);
        console.log(`> WebSocket server ready on ws://${hostname}:${wsPort}`);
      } catch (e: any) {
        console.warn(`[WS] Embedded WS server skipped: ${e?.message || e}`);
        console.log(`> WebSocket service: use external realtime server (ws.tirbeo.app)`);
      }
    } else {
      console.log(`> WebSocket service: external realtime server (ws.tirbeo.app)`);
    }
  });
});
