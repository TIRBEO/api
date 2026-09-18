import { NextRequest } from 'next/server';
import { getStats } from '@/features/admin/adminHandlers';

export async function GET(request: NextRequest) {
  return getStats(request);
}
