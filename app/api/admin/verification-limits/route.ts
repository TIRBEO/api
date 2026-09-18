import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;
  const limits = await (prisma as any).verificationLimit.findMany().catch(()=>[]);
  return NextResponse.json({ limits });
}

export async function PUT(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;
  const body:any = await request.json().catch(()=>({}));
  const { method, max, windowMs } = body;
  if (!method || typeof max !== 'number') return NextResponse.json({ error: 'method and max required' }, { status: 400 });
  const row = await (prisma as any).verificationLimit.upsert({
    where: { method },
    update: { max, windowMs: windowMs || 15*60*1000 },
    create: { method, max, windowMs: windowMs || 15*60*1000 },
  });
  return NextResponse.json({ ok: true, limit: row });
}
