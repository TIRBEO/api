import { NextResponse } from 'next/server';
import { cachedJson } from '../../../../lib/response';

export async function GET() {
  return cachedJson({}, { ttl: 30, swr: 300 });
}
