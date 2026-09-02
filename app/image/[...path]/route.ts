import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { validateImageFile } from '@/lib/imageSecurity';

export const runtime = 'nodejs';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const ALLOWED_SEGMENTS = /^[a-z0-9][a-z0-9-]*$/;

function sanitizeSegments(segments: string[]): string | null {
  const clean: string[] = [];
  for (const raw of segments) {
    const segment = decodeURIComponent(raw).replace(/\.(png|jpe?g|gif|webp|svg|ico)$/i, '');
    if (!ALLOWED_SEGMENTS.test(segment)) return null;
    clean.push(segment);
  }
  return clean.join('/');
}

function resolveImagePath(relativePath: string): { filePath: string; contentType: string } | null {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) return null;
  const full = path.join(process.cwd(), 'image', relativePath);
  const ext = path.extname(relativePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (contentType) {
    return { filePath: full, contentType };
  }
  return { filePath: `${full}.png`, contentType: 'image/png' };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: pathSegments } = await params;
  if (!pathSegments || pathSegments.length === 0) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

  const relative = sanitizeSegments(pathSegments);
  if (!relative) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

  const resolved = resolveImagePath(relative);
  if (!resolved) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

  try {
    const isValid = await validateImageFile(resolved.filePath, resolved.contentType);
    if (!isValid) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

    const data = await readFile(resolved.filePath);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': resolved.contentType,
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'",
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
}
