import sharp from 'sharp';

/**
 * Real server-side image thumbnails for CDN grid/filmstrip views.
 *
 * `?thumb=1` used to stream the FULL-SIZE bytes — a 20-megapixel photo cost
 * megabytes per grid cell and made preview walls crawl. Now thumbs are true
 * WebP derivatives: ~10-30KB, generated once per (file, version) and cached
 * in-memory (LRU). A wall of 50 thumbnails drops from ~50×2MB to ~50×20KB.
 */

const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 480;
const THUMB_WEBP_QUALITY = 72;

/** 48MB of thumb cache ≈ hundreds of derivatives per instance. */
const LRU_MAX_BYTES = 48 * 1024 * 1024;

const thumbCache = new Map<string, { bytes: Buffer; at: number; size: number }>();
let cacheBytes = 0;

function cachePut(key: string, bytes: Buffer): void {
  const existing = thumbCache.get(key);
  if (existing) {
    cacheBytes -= existing.size;
    thumbCache.delete(key);
  }
  thumbCache.set(key, { bytes, at: Date.now(), size: bytes.length });
  cacheBytes += bytes.length;
  // LRU evict (oldest `at` first) until under budget.
  if (cacheBytes > LRU_MAX_BYTES) {
    const entries = [...thumbCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of entries) {
      if (cacheBytes <= LRU_MAX_BYTES * 0.8) break;
      thumbCache.delete(k);
      cacheBytes -= v.size;
    }
  }
}

export function cacheGet(key: string): Buffer | null {
  const hit = thumbCache.get(key);
  if (!hit) return null;
  // Touch: refresh recency + timestamp.
  thumbCache.delete(key);
  hit.at = Date.now();
  thumbCache.set(key, hit);
  return hit.bytes;
}

export function invalidateThumbCache(fileId: string): void {
  const prefix = `${fileId}:`;
  for (const key of [...thumbCache.keys()]) {
    if (key.startsWith(prefix)) {
      cacheBytes -= thumbCache.get(key)!.size;
      thumbCache.delete(key);
    }
  }
}

export interface ThumbResult {
  bytes: Buffer;
  contentType: string;
  width: number;
  height: number;
  cached: boolean;
}

/**
 * Generate (or fetch cached) WebP thumbnail for an image.
 * Falls back to the original bytes when the input can't be thumbnailed
 * (corrupt file, unsupported format) — the caller then serves those bytes.
 */
export async function getImageThumbnail(
  fileId: string,
  version: string,
  source: Buffer,
): Promise<ThumbResult> {
  const key = `${fileId}:${version}`;
  const cached = cacheGet(key);
  if (cached) {
    return { bytes: cached, contentType: 'image/webp', width: THUMB_WIDTH, height: THUMB_HEIGHT, cached: true };
  }

  const out = await sharp(source, { failOn: 'none' })
    .rotate() // respect EXIF orientation before resizing
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'cover', position: 'centre', withoutEnlargement: true })
    .webp({ quality: THUMB_WEBP_QUALITY, effort: 3 })
    .toBuffer();

  cachePut(key, out);
  return { bytes: out, contentType: 'image/webp', width: THUMB_WIDTH, height: THUMB_HEIGHT, cached: false };
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith('image/');
}
