import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { createAuditEvent } from './audit';
import { v4 as uuidv4 } from 'uuid';

function getFileExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  return map[mime] || '.bin';
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function getFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export async function listMediaHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const url = request.nextUrl;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(50, Number(url.searchParams.get('limit')) || 24);
  const folder = url.searchParams.get('folder') || undefined;
  const mimeType = url.searchParams.get('type') || undefined;
  const search = url.searchParams.get('q') || undefined;

  const where: Record<string, unknown> = {};
  if (folder) where.folder = folder;
  if (mimeType) where.mimeType = { startsWith: mimeType };
  if (search) where.OR = [
    { fileName: { contains: search } },
    { altText: { contains: search } },
  ];

  const [items, total] = await Promise.all([
    prisma.media.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { uploadedBy: { select: { id: true, email: true, name: true } } },
    }),
    prisma.media.count({ where: where as any }),
  ]);

  return NextResponse.json({ items, total, page, limit });
}

export async function uploadMediaHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return new NextResponse('No file uploaded', { status: 400 });

  if (file.size > 50 * 1024 * 1024) {
    return new NextResponse('File too large. Max 50MB', { status: 400 });
  }

  const folder = (formData.get('folder') as string) || 'general';
  const altText = (formData.get('altText') as string) || '';
  const tags = formData.get('tags') as string || '[]';

  const ext = getFileExt(file.type);
  const fileName = `${uuidv4()}${ext}`;
  const r2Key = `media/${folder}/${fileName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  let url: string;

  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKey = process.env.R2_ACCESS_KEY;
  const r2SecretKey = process.env.R2_SECRET_KEY;
  const r2Bucket = process.env.R2_BUCKET;
  const r2PublicUrl = process.env.R2_PUBLIC_URL;

  if (r2Endpoint && r2AccessKey && r2SecretKey && r2Bucket && r2PublicUrl) {
    const { putObject } = await import('./storage');
    await putObject({
      endpoint: r2Endpoint,
      accessKey: r2AccessKey,
      secretKey: r2SecretKey,
      bucket: r2Bucket,
      key: r2Key,
      body: buffer,
      contentType: file.type,
    });
    url = `${r2PublicUrl}/${r2Key}`;
  } else {
    return new NextResponse('File storage not configured. Contact admin.', { status: 503 });
  }
  let width: number | null = null;
  let height: number | null = null;

  if (isImage(file.type)) {
    const size = await getImageSize(buffer, file.type);
    width = size.width;
    height = size.height;
  }

  const media = await prisma.media.create({
    data: {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      url,
      thumbnail: isImage(file.type) ? url : null,
      altText: altText || file.name,
      width,
      height,
      uploadedById: session.userId,
      folder,
      tags: JSON.parse(tags) as any,
    },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'media.uploaded',
    targetType: 'media',
    targetId: media.id,
    metadata: { fileName: file.name, fileSize: file.size, mimeType: file.type, folder },
  });

  return NextResponse.json(media, { status: 201 });
}

async function getImageSize(buffer: Buffer, mimeType: string): Promise<{ width: number; height: number }> {
  // Use a simple approach for common formats
  if (mimeType === 'image/png') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 0;
    while (offset < buffer.length - 1) {
      if (buffer[offset] === 0xFF && buffer[offset + 1] === 0xC0) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset++;
    }
  }
  if (mimeType === 'image/gif') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/webp') {
    if (buffer[12] === 0x56 && buffer[13] === 0x50) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  return { width: 0, height: 0 };
}

export async function getMediaHandler(request: NextRequest, id: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const media = await prisma.media.findUnique({
    where: { id },
    include: { uploadedBy: { select: { id: true, email: true, name: true } } },
  });
  if (!media) return new NextResponse('Media not found', { status: 404 });

  return NextResponse.json(media);
}

export async function updateMediaHandler(request: NextRequest, id: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { altText, folder, tags } = body;

  const existing = await prisma.media.findUnique({ where: { id } });
  if (!existing) return new NextResponse('Media not found', { status: 404 });

  const data: Record<string, unknown> = {};
  if (altText !== undefined) data.altText = altText;
  if (folder !== undefined) data.folder = folder;
  if (tags !== undefined) data.tags = tags;

  const updated = await prisma.media.update({
    where: { id },
    data: data as any,
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'media.updated',
    targetType: 'media',
    targetId: id,
    metadata: { changes: data },
  });

  return NextResponse.json(updated);
}

export async function deleteMediaHandler(request: NextRequest, id: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const media = await prisma.media.findUnique({ where: { id } });
  if (!media) return new NextResponse('Media not found', { status: 404 });

  await prisma.media.delete({ where: { id } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'media.deleted',
    targetType: 'media',
    targetId: id,
    severity: 'warning',
    metadata: { fileName: media.fileName },
  });

  return NextResponse.json({ ok: true });
}

export { getFileSize };
