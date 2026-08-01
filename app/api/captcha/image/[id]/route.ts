import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyImageToken, renderCaptchaSvg } from '@/lib/captcha/service';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get('token') || '';

  if (!id || !token || !verifyImageToken(token, id)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  try {
    const challenge = await prisma.captchaChallenge.findUnique({ where: { id } });
    if (!challenge || !challenge.imageUrl) return new NextResponse('Not Found', { status: 404 });

    const svg = renderCaptchaSvg(challenge.challengeType as 'count' | 'shape' | 'direction', challenge.id);
    if (!svg) return new NextResponse('Not Found', { status: 404 });

    return new NextResponse(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  } catch {
    return new NextResponse('Not Found', { status: 404 });
  }
}
