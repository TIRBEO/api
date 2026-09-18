/**
 * Tirbeo CDN path security — PRD §4–5, §57, §97.
 *
 * Pipeline (never authorize-then-resolve):
 *   raw input → decode safely → normalize → validate → reject traversal
 *   → canonicalize → authorize → operate
 *
 * Canonical form: no leading slash internally (`avatars/u/x.webp`),
 * `/` separates components, UTF-8 allowed, `.`/`..`/null bytes/control
 * chars rejected, duplicate separators rejected (not silently merged —
 * callers must send clean paths), reserved system prefixes protected.
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_FILENAME_LENGTH = 255;

const RESERVED_PREFIXES = ['_system/', '_internal/', '_api/', '_health/'];

export type PathErrorCode =
  | 'PATH_EMPTY'
  | 'PATH_TOO_LONG'
  | 'PATH_TRAVERSAL'
  | 'PATH_NULL_BYTE'
  | 'PATH_CONTROL_CHARS'
  | 'PATH_BAD_ENCODING'
  | 'PATH_DUPLICATE_SEPARATORS'
  | 'PATH_RESERVED'
  | 'PATH_INVALID_SEGMENT';

export class PathError extends Error {
  readonly code: PathErrorCode;
  readonly status = 400;
  constructor(code: PathErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Decode percent-encoding once, safely. Double-encoding stays encoded (safe). */
function safeDecodeOnce(input: string): string {
  if (!input.includes('%')) return input;
  try {
    // Reject lone surrogates / malformed sequences by round-tripping.
    const decoded = decodeURIComponent(input);
    if (decoded.includes('\uFFFD')) throw new PathError('PATH_BAD_ENCODING', 'Invalid path encoding.');
    return decoded;
  } catch (e: any) {
    if (e instanceof PathError) throw e;
    throw new PathError('PATH_BAD_ENCODING', 'Invalid path encoding.');
  }
}

export interface CanonicalPath {
  /** No leading slash: `avatars/users/usr_123/profile.webp`. Empty = root. */
  path: string;
  /** Individual components. */
  segments: string[];
  /** Last component (file or folder name). */
  name: string;
  /** Parent prefix with trailing slash, or '' for root. */
  parent: string;
}

/**
 * Canonicalize a user-supplied path. Throws PathError on any violation.
 * Accepts with or without leading slash; folder paths may end with `/`.
 */
export function canonicalizePath(raw: string | null | undefined): CanonicalPath {
  if (raw == null) throw new PathError('PATH_EMPTY', 'Path is required.');
  const input = String(raw);
  if (input.length === 0) return { path: '', segments: [], name: '', parent: '' };

  // Null bytes (raw or encoded) — reject before decoding.
  if (input.includes('\0') || /%00/i.test(input)) {
    throw new PathError('PATH_NULL_BYTE', 'Null bytes are not allowed in paths.');
  }

  const decoded = safeDecodeOnce(input);

  // A second decode pass must not reveal anything new — blocks %252e%252e tricks.
  if (/%[0-9a-fA-F]{2}/.test(decoded)) {
    const redecoded = safeDecodeOnce(decoded);
    if (redecoded !== decoded) {
      throw new PathError('PATH_TRAVERSAL', 'Invalid path encoding.');
    }
  }
  if (decoded.includes('\0')) throw new PathError('PATH_NULL_BYTE', 'Null bytes are not allowed in paths.');

  // Control characters rejected.
   
  if (/[\x00-\x1F\x7F]/.test(decoded)) {
    throw new PathError('PATH_CONTROL_CHARS', 'Control characters are not allowed in paths.');
  }

  // Backslashes are never separators — reject (Windows-style traversal).
  if (decoded.includes('\\')) {
    throw new PathError('PATH_TRAVERSAL', 'Backslashes are not allowed in paths.');
  }

  // Duplicate separators rejected (callers must send clean paths).
  if (decoded.includes('//')) {
    throw new PathError('PATH_DUPLICATE_SEPARATORS', 'Duplicate separators (//) are not allowed.');
  }

  if (decoded.length > MAX_PATH_LENGTH + 1) {
    throw new PathError('PATH_TOO_LONG', `Path exceeds ${MAX_PATH_LENGTH} characters.`);
  }

  const isFolder = decoded.endsWith('/') && decoded.length > 1;
  const trimmed = decoded.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return { path: '', segments: [], name: '', parent: '' };

  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new PathError('PATH_TRAVERSAL', 'Dot segments (., ..) are not allowed.');
    }
    if (seg.length > MAX_FILENAME_LENGTH) {
      throw new PathError('PATH_TOO_LONG', `Name exceeds ${MAX_FILENAME_LENGTH} characters.`);
    }
  }

  const path = segments.join('/');
  const lowered = path.toLowerCase();
  for (const reserved of RESERVED_PREFIXES) {
    if (lowered === reserved.slice(0, -1) || lowered.startsWith(reserved)) {
      throw new PathError('PATH_RESERVED', 'This path prefix is reserved.');
    }
  }

  const name = segments[segments.length - 1];
  const parent = segments.length > 1 ? `${segments.slice(0, -1).join('/')}/` : '';
  return { path: isFolder ? `${path}/` : path, segments, name, parent };
}

/**
 * Component-aware scope check: `/avatars/*` matches `/avatars/x.webp` but
 * NOT `/avatars-private/x.webp`. `*` alone (or empty scope) matches all.
 * Never use naive string prefix matching for authorization.
 */
export function pathInScope(requestPath: string, scope: string | null | undefined): boolean {
  if (!scope || scope.trim() === '' || scope.trim() === '/*' || scope.trim() === '*') return true;
  const clean = scope.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const req = requestPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean.endsWith('/*')) {
    const prefix = clean.slice(0, -2);
    if (prefix === '') return true;
    return req === prefix || req.startsWith(`${prefix}/`);
  }
  return req === clean || req.startsWith(`${clean}/`);
}

/** Normalize a scope for storage (`/avatars/*`, `/`, …). */
export function normalizeScope(scope: string | null | undefined): string {
  if (!scope || scope.trim() === '') return '/*';
  const s = scope.trim();
  if (s === '*' || s === '/*' || s === '/') return '/*';
  const inner = s.replace(/^\/+/, '').replace(/\/+$/, '');
  return `/${inner}/*`;
}

/** Split a canonical path into parent prefix + name. */
export function splitParent(path: string): { parent: string; name: string } {
  const c = canonicalizePath(path);
  return { parent: c.parent.replace(/\/$/, ''), name: c.name };
}
