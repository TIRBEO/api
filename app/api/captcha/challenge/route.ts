import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSession } from '@/lib/session';
import {
  generateChallenge,
  getRequiredDifficulty,
  isBlocked,
  getCaptchaSettings,
  issueChallengeToken,
  logCaptchaEvent,
} from '@/lib/captcha/service';
import { computeRiskScore, computeDeviceFingerprint } from '@/lib/captcha/risk';

export const runtime = 'nodejs';

const CAPTCHA_SESSION_COOKIE = '__captcha_session';
const DEVICE_FP_COOKIE = '__dfp';

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';

    const userId = session?.userId;

    let captchaSessionId = request.cookies.get(CAPTCHA_SESSION_COOKIE)?.value;
    if (!captchaSessionId) captchaSessionId = crypto.randomUUID();
    const sessionId = session?.sessionId || captchaSessionId;

    const cookieFp = request.cookies.get(DEVICE_FP_COOKIE)?.value;
    const headerFp = request.headers.get('x-device-fingerprint') || '';
    const fingerprint = cookieFp && cookieFp.length >= 16
      ? cookieFp
      : headerFp && headerFp.length >= 16
        ? headerFp
        : computeDeviceFingerprint({ ua: userAgent });

    const blockStatus = await isBlocked(userId, sessionId, ipAddress);
    if (blockStatus.blocked) {
      const res = NextResponse.json({
        blocked: true,
        rayId: blockStatus.rayId,
        reason: blockStatus.reason,
        expiresAt: blockStatus.expiresAt,
      }, { status: 403 });
      res.cookies.set(CAPTCHA_SESSION_COOKIE, captchaSessionId, cookieOptions(60 * 60 * 24));
      return res;
    }

    const settings = await getCaptchaSettings();
    const risk = settings.riskEnabled
      ? await computeRiskScore({ ip: ipAddress, ua: userAgent, userId, sessionId, fingerprint, authPath: true })
      : null;

    // A caller may request a minimum difficulty (e.g. forms require medium).
    // We take the stricter of the requested floor and the risk-derived difficulty.
    const requestedFloor = (request.nextUrl.searchParams.get('difficulty') || '').toLowerCase();
    let difficulty = await getRequiredDifficulty(userId, sessionId, ipAddress, risk);
    const rank: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
    if (requestedFloor && rank[requestedFloor] !== undefined && rank[requestedFloor] > rank[difficulty]) {
      difficulty = requestedFloor as 'easy' | 'medium' | 'hard';
    }

    // Reuse an unsolved, non-expired challenge for this session — but never one
    // below the requested difficulty floor (a stale easy challenge must not be
    // handed out when the caller requires medium, or the consuming handler would
    // reject the solved challenge and falsely flag a legitimate user).
    const existingChallenge = await prisma.captchaChallenge.findFirst({
      where: {
        sessionId,
        solved: false,
        attempts: { lt: settings.maxAttemptsPerChallenge },
        expiresAt: { gte: new Date() },
        ...(requestedFloor && rank[requestedFloor] !== undefined
          ? { NOT: { difficulty: { in: ['easy', 'medium', 'hard'].filter(d => rank[d] < rank[requestedFloor]) } } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    let challenge;
    if (existingChallenge) {
      challenge = existingChallenge;
    } else {
      challenge = await generateChallenge(difficulty, sessionId, userId, ipAddress, userAgent);
      await logCaptchaEvent(userId, sessionId, ipAddress, 'challenge_shown', difficulty, challenge.rayId, { risk: risk?.score });
    }

    const ipHash = require('crypto').createHash('sha256').update(ipAddress || '').digest('hex');
    const uaHash = require('crypto').createHash('sha256').update(userAgent || '').digest('hex');
    const fpHash = require('crypto').createHash('sha256').update(fingerprint || '').digest('hex');
    const token = issueChallengeToken(challenge, ipHash, uaHash, fpHash);

    const res = NextResponse.json({
      challenge: {
        id: challenge.id,
        difficulty: challenge.difficulty,
        challengeType: challenge.challengeType,
        question: challenge.question,
        options: challenge.options,
        imageUrl: challenge.imageUrl,
        rayId: challenge.rayId,
        attempts: challenge.attempts,
        token,
      },
      risk: risk ? { score: risk.score, level: risk.level, reasons: risk.reasons } : null,
    });
    res.cookies.set(CAPTCHA_SESSION_COOKIE, captchaSessionId, cookieOptions(60 * 60 * 24));
    if (fingerprint && fingerprint.length >= 16) {
      res.cookies.set(DEVICE_FP_COOKIE, fingerprint, cookieOptions(60 * 60 * 24 * 30));
    }
    return res;
  } catch (err: any) {
    console.error('[CAPTCHA] Challenge error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to generate CAPTCHA' }, { status: 500 });
  }
}
