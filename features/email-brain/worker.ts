/**
 * Email Brain — Worker bootstrap.
 *
 * Called once from server.ts alongside the other periodic workers. Drains the
 * email job queue every 15s and runs digest sweeps on their cadences.
 */
import { processEmailJobs } from '@/features/email-brain/queue';
import { processDigests } from '@/features/email-brain/digests';

let started = false;

export function startEmailBrainWorkers(): void {
  if (started) return;
  started = true;

  // Queue drain — short interval, small batches.
  setInterval(() => {
    processEmailJobs().catch((e) =>
      console.error('[EMAIL_BRAIN][QUEUE]', e?.message || e),
    );
  }, 15_000);

  // Digest sweeps — hourly check; the engine decides per-user due-ness.
  setInterval(() => {
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      processDigests(cadence).catch((e) =>
        console.error('[EMAIL_BRAIN][DIGEST]', cadence, e?.message || e),
      );
    }
  }, 60 * 60_000);
}
