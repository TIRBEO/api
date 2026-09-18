import { NextRequest } from 'next/server';
import { resetUserPassword } from '@/features/admin/adminHandlers';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return resetUserPassword(request, id);
}