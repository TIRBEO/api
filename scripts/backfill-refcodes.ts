/**
 * Backfill banRefCode / suspendRefCode to the canonical Block-Segment format.
 *
 *   Old formats:  SUS-7b9649e0 / BAN-3c1a55f2  (legacy prefixed)
 *                 4155-7b96-49e0               ("AU" — auth family, current)
 *
 * What it does, per row:
 *   - Rows currently banned/suspended with a legacy or missing code get a
 *     canonical `4155-xxxx-xxxx` code (preserving the legacy token's
 *     timestamp+random portion when one exists, so references already sent
 *     to users keep resolving).
 *   - Codes already in the segmented format are left untouched.
 *   - Suspended rows also get a banRefCode pre-assigned (and vice versa) is
 *     NOT done — only the code matching the row's current status, plus any
 *     legacy code is upgraded in place on its own column.
 *
 * Idempotent — safe to re-run. Batched — safe for large tables.
 *
 * Usage:
 *   npx tsx scripts/backfill-refcodes.ts [--dry-run]
 *   npx tsx scripts/backfill-refcodes.ts --user <userId>   # single row
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const userIdx = process.argv.indexOf('--user');
const ONLY_USER = userIdx > -1 ? process.argv[userIdx + 1] : null;

const BATCH = 200;

// Legacy shapes: "SUS-7b9649e0", "BAN-3c1a55f2", bare "7b9649e0".
const LEGACY_RE = /^(?:SUS|BAN)[\s_-]*([0-9a-fA-F]{4,12})$/;

function isSegmented(code: string | null | undefined): boolean {
  return !!code && /^4155-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code.trim());
}

function canonicalFromLegacy(legacy: string | null | undefined, fallbackToken: string): string {
  if (legacy) {
    const m = legacy.trim().match(LEGACY_RE);
    const token = m?.[1] ?? legacy.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).padStart(8, '0');
    const padded = token.length >= 8 ? token.slice(0, 8) : token.padStart(8, '0');
    return `4155-${padded.slice(0, 4)}-${padded.slice(4, 8)}`;
  }
  return `4155-${fallbackToken.slice(0, 4)}-${fallbackToken.slice(4, 8)}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(4);
  (globalThis.crypto || (globalThis as any).crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Row {
  id: string;
  email: string;
  isBanned: boolean;
  isSuspended: boolean;
  banRefCode: string | null;
  suspendRefCode: string | null;
}

function needsBackfill(row: Row): boolean {
  const banLegacy = !!row.banRefCode && !isSegmented(row.banRefCode);
  const susLegacy = !!row.suspendRefCode && !isSegmented(row.suspendRefCode);
  const missingBan = row.isBanned && !row.banRefCode;
  const missingSus = row.isSuspended && !row.suspendRefCode;
  return banLegacy || susLegacy || missingBan || missingSus;
}

async function processBatch(rows: Row[]): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!needsBackfill(row)) { skipped++; continue; }

    const data: { banRefCode?: string; suspendRefCode?: string } = {};

    if (row.isBanned && (!row.banRefCode || !isSegmented(row.banRefCode))) {
      data.banRefCode = canonicalFromLegacy(row.banRefCode, randomToken());
    }
    if (row.isSuspended && (!row.suspendRefCode || !isSegmented(row.suspendRefCode))) {
      data.suspendRefCode = canonicalFromLegacy(row.suspendRefCode, randomToken());
    }
    // Non-active rows with legacy codes: upgrade in place, keep the token.
    if (!row.isBanned && row.banRefCode && !isSegmented(row.banRefCode)) {
      data.banRefCode = canonicalFromLegacy(row.banRefCode, randomToken());
    }
    if (!row.isSuspended && row.suspendRefCode && !isSegmented(row.suspendRefCode)) {
      data.suspendRefCode = canonicalFromLegacy(row.suspendRefCode, randomToken());
    }

    if (!Object.keys(data).length) { skipped++; continue; }

    if (DRY_RUN) {
      console.log(`  [dry] ${row.email}: ${JSON.stringify(data)}`);
      updated++;
      continue;
    }

    await prisma.user.update({ where: { id: row.id }, data });
    updated++;
  }

  return { updated, skipped };
}

async function main() {
  console.log(`Backfill ref codes${DRY_RUN ? ' (DRY RUN)' : ''}${ONLY_USER ? ` — user ${ONLY_USER}` : ''}\n`);

  const where: any = ONLY_USER
    ? { id: ONLY_USER }
    : { OR: [{ banRefCode: { not: null } }, { suspendRefCode: { not: null } }, { isBanned: true }, { isSuspended: true }] };

  let cursor: string | undefined;
  let totalUpdated = 0;
  let totalScanned = 0;

  for (;;) {
    const rows: Row[] = await prisma.user.findMany({
      where,
      select: {
        id: true, email: true, isBanned: true, isSuspended: true,
        banRefCode: true, suspendRefCode: true,
      },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });

    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    totalScanned += rows.length;

    const { updated, skipped } = await processBatch(rows);
    totalUpdated += updated;
    process.stdout.write(`\rScanned ${totalScanned}, updated ${totalUpdated}, skipped ${skipped} (last batch)   `);
  }

  console.log(`\n\nDone. Scanned ${totalScanned} rows, updated ${totalUpdated}.${DRY_RUN ? ' Re-run without --dry-run to apply.' : ''}`);
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
