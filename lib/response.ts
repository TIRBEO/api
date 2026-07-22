import { NextResponse } from 'next/server';

export function cachedJson(data: unknown, init?: { status?: number; ttl?: number; swr?: number }) {
  const ttl = init?.ttl ?? 10;
  const swr = init?.swr ?? 60;
  return NextResponse.json(data, {
    status: init?.status,
    headers: {
      'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
    },
  });
}
