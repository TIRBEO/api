/**
 * The ledger behind "download my data".
 *
 * The person chooses a format before the file is made, so the choice has to be
 * written down with the request — not only handed to the browser — because the
 * history list has to say which format each download was and re-serving one has
 * to produce the same format again. That record lives in
 * `activity.data_export_requests` (Prisma: `DataExportRequest`).
 *
 * What is *not* here: the archive. Tirbeo writes the file at the moment it is
 * asked for and keeps no copy, so a row describes a request and what came out of
 * it (bytes, per-part counts, which parts were missing), not a stored file. That
 * is also why a row can be `pending`: the request was made and the file has not
 * been produced yet. Nothing about that state is faked — it changes only when a
 * build actually finishes or throws.
 */
import { prisma } from '@/infrastructure/db/prisma';
import { renderAccountExportHtml, type AccountExportArchive } from './accountExportHtml';

/** The two answers the download sheet offers. */
export const EXPORT_FORMATS = ['json', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * One row of the ledger, with the two loose edges of the column already closed:
 * `format` and `status` are TEXT in the database, so they come back as strings
 * and are normalised here rather than at every use.
 */
export type ExportRequestRecord = {
  id: string;
  format: ExportFormat;
  status: ExportRequestStatus;
  fileName: string;
  bytes: number | null;
  counts: Record<string, number> | null;
  missing: string[];
  truncated: string[];
  requestedAt: Date;
  builtAt: Date | null;
};

export const EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type ExportRequestStatus = (typeof EXPORT_STATUSES)[number];

/**
 * The single place a stored format is read.
 *
 * Rows written before the person had a choice carry no format at all — and could
 * not, since there was nothing to choose — so an absent or unrecognised value
 * means JSON, which is the only thing the builder ever produced back then. Fixing
 * this in one function is what keeps an old row downloadable instead of crashing
 * on `null`.
 */
export function readStoredExportFormat(value: unknown): ExportFormat {
  return typeof value === 'string' && value.trim().toLowerCase() === 'html' ? 'html' : 'json';
}

/**
 * The format a caller asked for, or `null` when the answer isn't one of the two
 * the sheet offers. Unlike the read above this refuses rather than guesses: a
 * request for a format that can't be built should be an error the person sees,
 * not a silently different file.
 */
export function parseRequestedExportFormat(value: unknown): ExportFormat | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return (EXPORT_FORMATS as readonly string[]).includes(text) ? (text as ExportFormat) : null;
}

function readStatus(value: unknown): ExportRequestStatus {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'ready' || text === 'failed' ? (text as ExportRequestStatus) : 'pending';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function readCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) counts[key] = n;
  }
  return counts;
}

function toRecord(row: {
  id: string;
  format: string;
  status: string;
  fileName: string;
  bytes: number | null;
  counts: unknown;
  missing: unknown;
  truncated: unknown;
  requestedAt: Date;
  builtAt: Date | null;
}): ExportRequestRecord {
  return {
    id: row.id,
    format: readStoredExportFormat(row.format),
    status: readStatus(row.status),
    fileName: row.fileName,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    counts: readCounts(row.counts),
    missing: readStringArray(row.missing),
    truncated: readStringArray(row.truncated),
    requestedAt: row.requestedAt,
    builtAt: row.builtAt,
  };
}

/**
 * The bytes a request comes out as, in the format stored with it.
 *
 * One function decides both the body and the media type, so a row that says
 * `html` can never be served as JSON, and the two builders can't drift apart on
 * what a format means. The archive is the same object either way — the format
 * changes how it is written down, never what is in it.
 */
export function renderExportArchive(
  archive: AccountExportArchive,
  format: ExportFormat,
): { body: string; contentType: string } {
  return format === 'html'
    ? { body: renderAccountExportHtml(archive), contentType: 'text/html; charset=utf-8' }
    : { body: JSON.stringify(archive, null, 2), contentType: 'application/json; charset=utf-8' };
}

/**
 * The name the browser saves the file under. The extension follows the format,
 * so an HTML report doesn't arrive as a `.json` the person has to guess about.
 */
export function exportFileName(stem: string, when: Date, format: ExportFormat): string {
  const safe = String(stem || 'account').replace(/[^A-Za-z0-9._-]/g, '');
  return `tirbeo-account-${safe || 'account'}-${when.toISOString().slice(0, 10)}.${format === 'html' ? 'html' : 'json'}`;
}

/**
 * Write the request, before anything is built.
 *
 * This is the moment the sheet's "Confirm" leaves a trace — closing the sheet
 * without confirming never calls it, so a cancelled choice records nothing.
 */
export async function createExportRequest(
  userId: string,
  format: ExportFormat,
  fileName: string,
): Promise<ExportRequestRecord> {
  const created = await prisma.dataExportRequest.create({
    data: { userId, format, status: 'pending', fileName },
  });
  return toRecord(created);
}

/** A request belonging to this account. Someone else's id reads as not-found. */
export async function loadExportRequest(userId: string, id: string): Promise<ExportRequestRecord | null> {
  const row = await prisma.dataExportRequest.findFirst({ where: { id, userId } });
  return row ? toRecord(row) : null;
}

/** The account's most recent requests, newest first — what the list shows. */
export async function listExportRequests(userId: string, take = 10): Promise<ExportRequestRecord[]> {
  const rows = await prisma.dataExportRequest.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take,
  });
  return rows.map(toRecord);
}

/**
 * The file was written: record its size and what it was made of.
 *
 * Best effort on purpose. A ledger write that fails must not cost the person the
 * archive they asked for, so the download still goes out and the miss is logged.
 */
export async function completeExportRequest(
  id: string,
  result: { bytes: number; counts: Record<string, number>; missing: string[]; truncated: string[] },
): Promise<void> {
  try {
    await prisma.dataExportRequest.update({
      where: { id },
      data: {
        status: 'ready',
        bytes: result.bytes,
        counts: result.counts as never,
        missing: result.missing as never,
        truncated: result.truncated as never,
        builtAt: new Date(),
        error: null,
      },
    });
  } catch (err: any) {
    console.error('[EXPORT LEDGER READY]', err?.message || err);
  }
}

/** The build threw: say so, with the reason, instead of leaving a fake pending row. */
export async function failExportRequest(id: string, error: string): Promise<void> {
  try {
    await prisma.dataExportRequest.update({
      where: { id },
      data: { status: 'failed', error: String(error || 'Export failed').slice(0, 500) },
    });
  } catch (err: any) {
    console.error('[EXPORT LEDGER FAIL]', err?.message || err);
  }
}
