import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // Delegate to the existing security/delete-account endpoint
  const base = new URL(req.url).origin;
  const forwarded = new Request(`${base}/api/security/delete-account`, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
    // @ts-expectable — duplex needed for streaming body forwarding
    duplex: 'half',
  } as RequestInit);

  return fetch(forwarded);
}
