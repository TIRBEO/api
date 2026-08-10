import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { storeMediaFile } from '@/lib/mediaStorage';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return new NextResponse('No file uploaded', { status: 400 });

  if (file.size > 10 * 1024 * 1024) {
    return new NextResponse('File too large. Max 10MB', { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return new NextResponse('Only image files are allowed (JPEG, PNG, GIF, WebP)', { status: 400 });
  }

  const fileName = `${uuidv4()}${EXT_MAP[file.type]}`;
  const r2Key = `media/chat/${fileName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { url } = await storeMediaFile({
    key: r2Key,
    body: buffer,
    contentType: file.type,
  });

  const media = await prisma.media.create({
    data: {
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
      url,
      altText: file.name,
      uploadedBy: session.userId,
      metadata: { folder: 'chat' },
    },
  });

  return NextResponse.json(media, { status: 201 });
}
