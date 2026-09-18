import { NextRequest } from 'next/server';
import { adminPasskeyOptionsHandler } from '@/features/admin/adminPasskeyHandlers';

export async function POST(request: NextRequest) {
  return adminPasskeyOptionsHandler(request);
}
