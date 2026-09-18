import { NextRequest } from 'next/server';
import { seedAdminHandler } from '@/features/admin/adminHandlers';

export async function POST(request: NextRequest) {
  return seedAdminHandler(request);
}
