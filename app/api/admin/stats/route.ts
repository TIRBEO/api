import { NextRequest } from 'next/server';
import { getStats } from '../../../../lib/adminHandlers';

export async function GET(request: NextRequest) {
  return getStats(request);
}
