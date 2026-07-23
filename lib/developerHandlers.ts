import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { createHash, randomBytes } from 'crypto';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateKey(): string {
  const bytes = randomBytes(32);
  return 'tb_' + bytes.toString('base64url');
}

export async function apiKeysHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (request.method === 'GET') {
    const keys = await prisma.apiKey.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, active: true, lastUsedAt: true, createdAt: true },
    });
    return NextResponse.json(keys);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const name = (body.name || '').trim();
    if (!name || name.length > 100) {
      return NextResponse.json({ error: 'Invalid key name' }, { status: 400 });
    }

    const rawKey = generateKey();
    const keyHash = hashKey(rawKey);
    const prefix = rawKey.slice(0, 11);

    const key = await prisma.apiKey.create({
      data: { userId: session.userId, name, keyHash, prefix },
    });

    return NextResponse.json({ id: key.id, name: key.name, key: rawKey, prefix, createdAt: key.createdAt });
  }

  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function apiKeyDeleteHandler(request: NextRequest, keyId: string) {
  const session = await getSession(request);
  if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const key = await prisma.apiKey.findFirst({ where: { id: keyId, userId: session.userId } });
  if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 });

  await prisma.apiKey.delete({ where: { id: keyId } });
  return NextResponse.json({ ok: true });
}
