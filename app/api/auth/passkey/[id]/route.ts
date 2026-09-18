import type { NextRequest } from 'next/server';
import { passkeyDeleteHandler, passkeyUpdateHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return passkeyDeleteHandler(req, id);
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return passkeyUpdateHandler(req, id);
}
