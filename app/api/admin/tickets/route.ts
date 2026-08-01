import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { createAuditEvent } from '@/lib/audit';
import { sendTemplateEmail } from '@/lib/email';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || '';
  const priority = searchParams.get('priority') || '';
  const assigned = searchParams.get('assigned') || '';
  const search = searchParams.get('search') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const skip = (page - 1) * limit;

  const where: any = {};
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (assigned) where.assignedId = assigned;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { customer: { email: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        customer: { select: { id: true, name: true, email: true, photoUrl: true } },
        assigned: { select: { id: true, name: true, email: true } },
        queue: { select: { id: true, name: true } },
        messages: { take: 1, orderBy: { createdAt: 'desc' } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);

  return NextResponse.json({ tickets, total, page, limit });
}
