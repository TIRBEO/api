import type { NextRequest } from 'next/server';
import { changeAnswerHandler } from '@/features/users/userHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return changeAnswerHandler(req, id);
}
