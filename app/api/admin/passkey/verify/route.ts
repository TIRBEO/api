import { NextRequest } from 'next/server';
import { adminPasskeyVerifyHandler } from '@/features/admin/adminPasskeyHandlers';

export async function POST(request: NextRequest) {
  return adminPasskeyVerifyHandler(request);
}
