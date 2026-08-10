import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { withAdmin } from '@/lib/role-guard';
import { getBranding, clearBrandingCache, normalizeLogoUrl, getApiOrigin } from '../../../../lib/branding';
import { createAuditEvent } from '../../../../lib/audit';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { writeFile, mkdir } from 'fs/promises';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
]);

const MAGIC_NUMBERS: Record<string, number[][]> = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'image/svg+xml': [[0x3C, 0x3F, 0x78, 0x6D, 0x6C], [0x3C, 0x73, 0x76, 0x67]],
};

function validateMagicNumber(buffer: Buffer, mimeType: string): boolean {
  const patterns = MAGIC_NUMBERS[mimeType];
  if (!patterns || patterns.length === 0) return true;
  const header = Array.from(buffer.slice(0, 12));
  return patterns.some(pattern => pattern.every((byte, i) => header[i] === byte));
}

export const runtime = 'nodejs';

function allowedLogoFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const text = (key: string, max = 200) => {
    if (body[key] !== undefined) {
      out[key] = String(body[key]).trim().slice(0, max);
    }
  };
  text('logoUrl', 500);
  text('brandName', 80);
  text('brandTagline', 160);
  text('emailFromName', 80);
  text('emailFromAddress', 120);
  return out;
}

export const GET = withAdmin(async (request, session) => {  const branding = await getBranding(true);
  return NextResponse.json({ branding,
    imageOrigin: branding.logoUrl ? undefined : '',
  });
});

export const PUT = withAdmin(async (request, session) => {

  const body: any = await request.json();
  const fields = allowedLogoFields(body as Record<string, unknown>);
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'No valid branding fields provided' }, { status: 400 });
  }

  if (fields.logoUrl !== undefined) {
    fields.logoUrl = normalizeLogoUrl(fields.logoUrl as string);
  }

  const existing = await prisma.siteConfig.findUnique({ where: { app: 'brand' } });
  const current = (existing?.config as Record<string, unknown>) || {};
  const mergedConfig = { ...current, ...fields };

  const config = await prisma.siteConfig.upsert({
    where: { app: 'brand' },
    create: {
      app: 'brand',
      config: mergedConfig as any,
      updatedBy: session.userId,
    },
    update: {
      config: mergedConfig as any,
      updatedBy: session.userId,
    },
  });

  clearBrandingCache();

  await createAuditEvent({
    actorId: session.userId,
    action: 'branding.updated',
    targetType: 'site_config',
    targetId: config.id,
    metadata: { fields: Object.keys(fields) },
  });

  const branding = await getBranding(true);
  return NextResponse.json({ config, branding });
});

export const POST = withAdmin(async (request, session) => {

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });

  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'Logo too large. Max 5MB' }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'Only image files are allowed' }, { status: 400 });
  }
  const extMap: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  };
  const ext = extMap[file.type] || '.png';
  const fileName = `logo-${uuidv4().slice(0, 8)}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  if (!validateMagicNumber(buffer, file.type)) {
    return NextResponse.json({ error: 'Invalid file format' }, { status: 400 });
  }

  let url: string;

  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKey = process.env.R2_ACCESS_KEY;
  const r2SecretKey = process.env.R2_SECRET_KEY;
  const r2Bucket = process.env.R2_BUCKET;
  const r2PublicUrl = process.env.R2_PUBLIC_URL;

  if (r2Endpoint && r2AccessKey && r2SecretKey && r2Bucket && r2PublicUrl) {
    const { putObject } = await import('../../../../lib/storage');
    await putObject({
      endpoint: r2Endpoint,
      accessKey: r2AccessKey,
      secretKey: r2SecretKey,
      bucket: r2Bucket,
      key: `branding/${fileName}`,
      body: buffer,
      contentType: file.type,
    });
    url = `${r2PublicUrl}/branding/${fileName}`;
  } else {
    const imageDir = path.join(process.cwd(), 'image');
    try {
      await mkdir(imageDir, { recursive: true });
      await writeFile(path.join(imageDir, fileName), buffer);
    } catch (err) {
      console.error('[BRANDING] Failed to write logo to disk:', err);
      return NextResponse.json({ error: 'Could not persist logo file' }, { status: 500 });
    }
    const base = getApiOrigin();
    url = `${base.replace(/\/$/, '')}/image/${fileName}`;
  }

  const existing = await prisma.siteConfig.findUnique({ where: { app: 'brand' } });
  const current = (existing?.config as Record<string, unknown>) || {};
  const config = await prisma.siteConfig.upsert({
    where: { app: 'brand' },
    create: { app: 'brand', config: { ...current, logoUrl: url } as any, updatedBy: session.userId },
    update: { config: { ...current, logoUrl: url } as any, updatedBy: session.userId },
  });

  clearBrandingCache();

  await createAuditEvent({
    actorId: session.userId,
    action: 'branding.logo_uploaded',
    targetType: 'site_config',
    targetId: config.id,
    severity: 'info',
    metadata: { fileName, mimeType: file.type, sizeBytes: file.size },
  });

  const branding = await getBranding(true);
  return NextResponse.json({ config, branding, url }, { status: 201 });
});
