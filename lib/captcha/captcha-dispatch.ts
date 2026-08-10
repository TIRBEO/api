import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSession } from '@/lib/session';
import { generateChallenge, CHALLENGE_TYPES } from './challenges';
import { computeRiskScore, computeDeviceFingerprint } from './risk';

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

export async function captchaChallengeHandler(request: NextRequest) {
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
    const fingerprint = cookieFp && cookieFp.length >= 16 ? cookieFp : headerFp && headerFp.length >= 16 ? headerFp : computeDeviceFingerprint({ ua: userAgent });

    // Check if blocked
    const now = new Date();
    const block = await prisma.captchaBlock.findFirst({
      where: {
        AND: [
          {
            OR: [
              ...(userId ? [{ userId }] : []),
              ...(sessionId ? [{ sessionId }] : []),
              ...(ipAddress ? [{ ipAddress }] : []),
            ],
          },
          { blockedAt: { lte: now } },
          { unblockedAt: null },
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      orderBy: { blockedAt: 'desc' },
    });

    if (block) {
      const res = NextResponse.json({
        blocked: true,
        rayId: block.rayId,
        reason: block.reason,
        expiresAt: block.expiresAt,
        blockedAt: block.blockedAt,
      }, { status: 403 });
      res.cookies.set(CAPTCHA_SESSION_COOKIE, captchaSessionId, cookieOptions(60 * 60 * 24));
      return res;
    }

    // Compute risk
    const risk = await computeRiskScore({ ip: ipAddress, ua: userAgent, userId, sessionId, fingerprint, authPath: true });
    
    // Determine difficulty based on risk
    const difficulty = risk.score > 70 ? 'hard' : risk.score > 40 ? 'medium' : 'easy';
    
    // Pick random challenge type
    const challengeType = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
    
    // Generate challenge
    const challengeData = generateChallenge(challengeType, difficulty);
    
    // Store challenge in DB
    const challengeId = crypto.randomUUID();
    const rayId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await prisma.captchaChallenge.create({
      data: {
        id: challengeId,
        sessionId,
        userId,
        difficulty,
        challengeType,
        question: challengeData.question,
        answerHash: challengeData.answerHash,
        options: challengeData.data,
        ipAddress,
        userAgent,
        rayId,
        expiresAt,
      },
    });

    // Create signed token
    const token = signToken({
      id: challengeId,
      exp: Math.floor(expiresAt.getTime() / 1000),
      nonce: crypto.randomUUID(),
      ipHash: require('crypto').createHash('sha256').update(ipAddress || '').digest('hex'),
      uaHash: require('crypto').createHash('sha256').update(userAgent || '').digest('hex'),
      fpHash: require('crypto').createHash('sha256').update(fingerprint || '').digest('hex'),
    });

    const res = NextResponse.json({
      challenge: {
        id: challengeId,
        type: challengeType,
        difficulty,
        question: challengeData.question,
        data: challengeData.data,
        rayId,
        attempts: 0,
        token,
        expiresAt: expiresAt.toISOString(),
      },
      risk: { score: risk.score, level: risk.level, reasons: risk.reasons },
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

export async function captchaVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    const body: any = await request.json();
    const { challengeId, answer, token } = body;
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const userId = session?.userId;
    const captchaSessionId = request.cookies.get('__captcha_session')?.value;
    const sessionId = session?.sessionId || captchaSessionId || 'anonymous';
    const fingerprint = request.cookies.get('__dfp')?.value || '';

    // Verify token
    const tokenData = verifyToken(token);
    if (!tokenData.ok) {
      return NextResponse.json({ valid: false, reason: tokenData.reason }, { status: 400 });
    }

    // Find challenge
    const challenge = await prisma.captchaChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge) return NextResponse.json({ valid: false, reason: 'Challenge not found' }, { status: 400 });
    if (challenge.solved) return NextResponse.json({ valid: false, reason: 'Challenge already used' }, { status: 400 });
    if (challenge.expiresAt < new Date()) return NextResponse.json({ valid: false, reason: 'Challenge expired' }, { status: 400 });

    // Check answer
    const answerHash = require('crypto').createHash('sha256').update(String(answer).trim().toLowerCase()).digest('hex');
    const isValid = answerHash === challenge.answerHash;

    // Record attempt
    await prisma.captchaAttempt.create({
      data: {
        challengeId: challenge.id,
        userId: challenge.userId,
        sessionId: challenge.sessionId || sessionId,
        answer: String(answer),
        isCorrect: isValid,
        ipAddress,
        userAgent,
      },
    });

    // Update challenge
    await prisma.captchaChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 }, ...(isValid ? { solved: true, solvedAt: new Date() } : {}) },
    });

    if (!isValid) {
      const newAttempts = challenge.attempts + 1;
      if (newAttempts >= 3) {
        // Block user
        const blockedAt = new Date();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min block
        await prisma.captchaBlock.create({
          data: {
            userId: challenge.userId,
            sessionId: challenge.sessionId || sessionId,
            ipAddress,
            reason: 'too_many_captcha_attempts',
            difficulty: 'hard',
            expiresAt,
            rayId: challenge.rayId,
          },
        });
        return NextResponse.json(
          { valid: false, blocked: true, rayId: challenge.rayId, reason: 'Too many failed attempts', expiresAt: expiresAt.toISOString(), blockedAt: blockedAt.toISOString() },
          { status: 403 }
        );
      }
      return NextResponse.json({ valid: false, rayId: challenge.rayId });
    }

    return NextResponse.json({ valid: true, rayId: challenge.rayId });
  } catch (err: any) {
    console.error('[CAPTCHA] Verify error:', err?.message || err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

// Cache captcha status per IP for 30s to avoid hammering DB on every page load
const captchaStatusCache = new Map<string, { data: any; ts: number }>();
const CAPTCHA_STATUS_TTL = 30_000;

export async function captchaStatusHandler(request: NextRequest) {
  try {
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    
    // Fast path: return cached result if fresh
    const cached = captchaStatusCache.get(ipAddress);
    if (cached && Date.now() - cached.ts < CAPTCHA_STATUS_TTL) {
      return NextResponse.json(cached.data);
    }

    const session = await getSession(request);
    const captchaSessionId = request.cookies.get('__captcha_session')?.value;
    const sessionId = session?.sessionId || captchaSessionId || 'anonymous';
    const userAgent = request.headers.get('user-agent') || '';
    const fingerprint = request.cookies.get('__dfp')?.value || '';
    const userId = session?.userId;

    const risk = await computeRiskScore({ ip: ipAddress, ua: userAgent, userId, sessionId, fingerprint, authPath: true });

    const result = {
      blocked: false,
      requiredDifficulty: risk.score > 70 ? 'hard' : risk.score > 40 ? 'medium' : 'easy',
      level: risk.level,
      score: risk.score,
      requireCaptcha: risk.requireCaptcha,
      captchaEnabled: true,
    };
    
    // Cache the result
    captchaStatusCache.set(ipAddress, { data: result, ts: Date.now() });
    // Prune old entries periodically
    if (captchaStatusCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of captchaStatusCache) {
        if (now - v.ts > CAPTCHA_STATUS_TTL) captchaStatusCache.delete(k);
      }
    }
    
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to check status' }, { status: 500 });
  }
}

// Token functions
function signToken(fields: { id: string; exp: number; nonce: string; ipHash: string; uaHash: string; fpHash: string }): string {
  const payload = Buffer.from([fields.id, String(fields.exp), fields.nonce, fields.ipHash, fields.uaHash, fields.fpHash].join('.')).toString('base64url');
  const secret = process.env.CAPTCHA_TOKEN_SECRET || process.env.JWT_SECRET || 'secret';
  const sig = require('crypto').createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token: string): { ok: boolean; reason?: string } {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return { ok: false, reason: 'malformed' };
    const secret = process.env.CAPTCHA_TOKEN_SECRET || process.env.JWT_SECRET || 'secret';
    const expectedSig = require('crypto').createHmac('sha256', secret).update(payload).digest('base64url');
    if (sig.length !== expectedSig.length) return { ok: false, reason: 'bad_signature' };
    const [id, exp, nonce, ipHash, uaHash, fpHash] = Buffer.from(payload, 'base64url').toString().split('.');
    if (Number(exp) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export async function captchaImageHandler(request: NextRequest, id: string) {
  try {
    const challenge = await prisma.captchaChallenge.findUnique({ where: { id } });
    if (!challenge) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(challenge.options);
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function captchaAdminHandler(request: NextRequest) {
  return NextResponse.json({ ok: true });
}

export async function captchaAnalyticsHandler(request: NextRequest) {
  try {
    const [totalChallenges, totalAttempts, totalBlocks] = await Promise.all([
      prisma.captchaChallenge.count(),
      prisma.captchaAttempt.count(),
      prisma.captchaBlock.count(),
    ]);
    return NextResponse.json({ totalChallenges, totalAttempts, totalBlocks });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function captchaLogsHandler(request: NextRequest) {
  try {
    const logs = await prisma.captchaLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return NextResponse.json(logs);
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function captchaBlocksHandler(request: NextRequest) {
  try {
    const blocks = await prisma.captchaBlock.findMany({ orderBy: { blockedAt: 'desc' }, take: 50 });
    return NextResponse.json(blocks);
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function captchaUnblockHandler(request: NextRequest) {
  try {
    const body: any = await request.json();
    const { rayId } = body;
    await prisma.captchaBlock.updateMany({ where: { rayId }, data: { unblockedAt: new Date() } });
    return NextResponse.json({ success: true, rayId });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
