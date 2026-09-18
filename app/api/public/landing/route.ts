import { NextResponse } from 'next/server';
import { cachedJson } from '@/shared/response';

export async function GET() {
  return cachedJson({}, { ttl: 30, swr: 300 });
}
