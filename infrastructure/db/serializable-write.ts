import { prisma } from '@/infrastructure/db/prisma';
import type { Prisma } from '@prisma/client';

/**
 * One read-modify-write pass over a JSON column, serialised.
 *
 * Several stores on an account are whole JSON blobs — `preferences.misc`,
 * `preferences.appearance`, the notification bag. The cheap way to change one key
 * is: read the row, edit it in JS, write the blob back. Two requests doing that
 * at the same moment both start from the same snapshot, and whichever commits
 * second silently deletes whatever the first one wrote.
 *
 * Serializable isolation makes Postgres detect exactly that overlap and abort the
 * later transaction with 40001; retrying the whole pass is then safe, because the
 * retry re-reads the row the other writer just changed.
 */
export async function serializableWrite<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === '40001' || code === 'P2034') { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}
