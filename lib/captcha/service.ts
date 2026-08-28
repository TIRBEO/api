import { prisma } from '../db/prisma';
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'crypto';
import {
  BehaviorData,
  RiskResult,
  computeRiskScore,
  computeDeviceFingerprint,
  recordDeviceSeen,
  riskLevelFromScore,
  hasRecentLoginSuccess,
} from './risk';

export type CaptchaDifficulty = 'easy' | 'medium' | 'hard';
export type CaptchaType = 'math' | 'word' | 'count' | 'shape' | 'direction';

export interface CaptchaChallenge {
  id: string;
  sessionId: string;
  userId?: string;
  difficulty: CaptchaDifficulty;
  challengeType: CaptchaType;
  question: string;
  answerHash: string;
  options?: any;
  imageUrl?: string;
  expiresAt: Date;
  attempts: number;
  solved: boolean;
  rayId: string;
}

export interface CaptchaSettings {
  enabled: boolean;
  autoEnforce: boolean;
  riskEnabled: boolean;
  standardScore: number;
  strongScore: number;
  multiAccountThreshold: number;
  easyThreshold: number;
  mediumThreshold: number;
  hardThreshold: number;
  blockThreshold: number;
  sessionDuration: number;
  challengeExpiry: number;
  maxAttemptsPerChallenge: number;
  cooldownMinutes: number;
  adminNotifyThreshold: number;
}

const DEFAULT_SETTINGS: CaptchaSettings = {
  enabled: true,
  autoEnforce: true,
  riskEnabled: true,
  standardScore: 51,
  strongScore: 81,
  multiAccountThreshold: 3,
  easyThreshold: 2,
  mediumThreshold: 4,
  hardThreshold: 6,
  blockThreshold: 8,
  sessionDuration: 60,
  challengeExpiry: 2,
  maxAttemptsPerChallenge: 3,
  cooldownMinutes: 10,
  adminNotifyThreshold: 5,
};

// ─── Signed challenge tokens (forgery + replay protection) ───

import { getCachedRedisClient } from '../db/redis';

let _redis: any = null;

function getRedis(): any {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!_redis) {
    _redis = getCachedRedisClient('captcha', {
      url,
      enableKeepAlive: false, // Captcha doesn't need keep-alive
    });
  }
  return _redis;
}

async function checkAndMarkNonce(nonce: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    const mem = (globalThis as any).__captchaUsedNonces as Set<string> || new Set<string>();
    (globalThis as any).__captchaUsedNonces = mem;
    if (mem.has(nonce)) return false;
    mem.add(nonce);
    if (mem.size > 5000) mem.clear();
    return true;
  }
  const key = `captcha:nonce:${nonce}`;
  const exists = await redis.set(key, '1', 'EX', 3600, 'NX');
  return exists === 'OK';
}

function captchaSecret(): string {
  const secret = process.env.CAPTCHA_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('CAPTCHA_TOKEN_SECRET or JWT_SECRET environment variable is required');
  }
  return secret;
}

function signToken(fields: { id: string; exp: number; nonce: string; ipHash: string; uaHash: string; fpHash: string }): string {
  const payload = Buffer.from([fields.id, String(fields.exp), fields.nonce, fields.ipHash, fields.uaHash, fields.fpHash].join('.')).toString('base64url');
  const sig = createHmac('sha256', captchaSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function signImageToken(challengeId: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(`${challengeId}.${exp}`).toString('base64url');
  const sig = createHmac('sha256', captchaSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyImageToken(token: string, challengeId: string): boolean {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = createHmac('sha256', captchaSecret()).update(payload).digest('base64url');
    if (sig.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const [id, exp] = Buffer.from(payload, 'base64url').toString().split('.');
    return id === challengeId && Number(exp) * 1000 >= Date.now();
  } catch {
    return false;
  }
}

export async function verifyChallengeToken(
  token: string,
  expected: { id: string; ipHash: string; uaHash: string; fpHash: string }
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return { ok: false, reason: 'malformed' };
    const expectedSig = createHmac('sha256', captchaSecret()).update(payload).digest('base64url');
    if (sig.length !== expectedSig.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return { ok: false, reason: 'bad_signature' };
    }
    const [id, exp, nonce, ipHash, uaHash, fpHash] = Buffer.from(payload, 'base64url').toString().split('.');
    if (id !== expected.id) return { ok: false, reason: 'id_mismatch' };
    if (Number(exp) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
    if (ipHash && expected.ipHash && ipHash !== expected.ipHash) return { ok: false, reason: 'ip_mismatch' };
    if (uaHash && expected.uaHash && uaHash !== expected.uaHash) return { ok: false, reason: 'ua_mismatch' };
    if (fpHash && expected.fpHash && fpHash !== expected.fpHash) return { ok: false, reason: 'device_mismatch' };
    const nonceOk = await checkAndMarkNonce(nonce);
    if (!nonceOk) return { ok: false, reason: 'replayed' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

// ─── Seeded PRNG (deterministic challenge rendering from id) ───
function seededRng(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPES = ['circle', 'square', 'triangle', 'star', 'diamond'] as const;
const DIRECTIONS = ['Up', 'Right', 'Down', 'Left'] as const;

interface DerivedChallenge {
  render: { type: string; params: Record<string, unknown> };
  answer: string;
  question: string;
  options: string[];
}

function deriveParams(challengeType: CaptchaType, id: string): DerivedChallenge {
  const rand = seededRng(id);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  switch (challengeType) {
    case 'count': {
      const n = int(3, 9);
      const answer = String(n);
      const wrong = new Set<string>();
      while (wrong.size < 3) {
        const v = n + int(-2, 2);
        if (v > 0 && v !== n) wrong.add(String(v));
      }
      const options = [answer, ...wrong];
      const shuffle = options.sort(() => rand() - 0.5);
      const color = pick(['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d00']);
      const shape = pick(['circle', 'square'] as const);
      return {
        render: { type: 'count', params: { n, color, shape, seed: Math.floor(rand() * 100000) } },
        answer,
        question: `How many ${shape === 'circle' ? 'circles' : 'squares'} do you see?`,
        options: shuffle,
      };
    }
    case 'shape': {
      const target = pick(SHAPES);
      const options = SHAPES.map(s => s.charAt(0).toUpperCase() + s.slice(1));
      return {
        render: { type: 'shape', params: { shape: target, color: pick(['#4285f4', '#ea4335', '#34a853', '#fbbc04']) } },
        answer: target,
        question: 'Which shape is shown?',
        options: [...options].sort(() => rand() - 0.5),
      };
    }
    case 'direction': {
      const target = pick(DIRECTIONS);
      return {
        render: { type: 'direction', params: { direction: target, color: pick(['#4285f4', '#ea4335', '#34a853', '#fbbc04']) } },
        answer: target,
        question: 'Which direction is the arrow pointing?',
        options: [...DIRECTIONS],
      };
    }
    default:
      return { render: { type: 'none', params: {} }, answer: '', question: '', options: [] };
  }
}

export function renderCaptchaSvg(challengeType: CaptchaType, id: string, seed?: string): string | null {
  const { render } = deriveParams(challengeType, id);
  if (render.type === 'none') return null;
  const r = render.params as any;

  const W = 280;
  const H = 120;
  let body = '';

  if (render.type === 'count') {
    const rand = seededRng(`${id}:${r.seed}`);
    const n = r.n as number;
    const rows = Math.ceil(n / 4);
    const positions: { x: number; y: number; s: number }[] = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const cols = Math.min(4, n - row * 4);
      const x = (W / (cols + 1)) * (col + 1) + (rand() * 6 - 3);
      const y = (H / (rows + 1)) * (row + 1) + (rand() * 6 - 3);
      const s = 10 + rand() * 8;
      positions.push({ x, y, s });
    }
    if (r.shape === 'circle') {
      for (const p of positions) body += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.s.toFixed(1)}" fill="${r.color}" opacity="0.9"/>`;
    } else {
      for (const p of positions) {
        const half = p.s * 0.75;
        body += `<rect x="${(p.x - half).toFixed(1)}" y="${(p.y - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" fill="${r.color}" opacity="0.9"/>`;
      }
    }
  }

  if (render.type === 'shape') {
    const cx = W / 2;
    const cy = H / 2;
    const color = r.color as string;
    if (r.shape === 'circle') body += `<circle cx="${cx}" cy="${cy}" r="38" fill="${color}"/>`;
    if (r.shape === 'square') body += `<rect x="${cx - 32}" y="${cy - 32}" width="64" height="64" fill="${color}"/>`;
    if (r.shape === 'triangle') body += `<polygon points="${cx},${cy - 40} ${cx - 42},${cy + 30} ${cx + 42},${cy + 30}" fill="${color}"/>`;
    if (r.shape === 'star') {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? 42 : 18;
        const ang = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
      }
      body += `<polygon points="${pts.join(' ')}" fill="${color}"/>`;
    }
    if (r.shape === 'diamond') body += `<polygon points="${cx},${cy - 40} ${cx + 34},${cy} ${cx},${cy + 40} ${cx - 34},${cy}" fill="${color}"/>`;
  }

  if (render.type === 'direction') {
    const cx = W / 2;
    const cy = H / 2;
    const dir = r.direction as string;
    const ang = dir === 'Up' ? -90 : dir === 'Down' ? 90 : dir === 'Right' ? 0 : 180;
    const rad = (ang * Math.PI) / 180;
    const tipX = cx + 44 * Math.cos(rad);
    const tipY = cy + 44 * Math.sin(rad);
    const leftX = cx + 34 * Math.cos(rad + 2.5);
    const leftY = cy + 34 * Math.sin(rad + 2.5);
    const rightX = cx + 34 * Math.cos(rad - 2.5);
    const rightY = cy + 34 * Math.sin(rad - 2.5);
    const baseLeftX = cx + 34 * Math.cos(rad + Math.PI * 0.78);
    const baseLeftY = cy + 34 * Math.sin(rad + Math.PI * 0.78);
    const baseRightX = cx + 34 * Math.cos(rad - Math.PI * 0.78);
    const baseRightY = cy + 34 * Math.sin(rad - Math.PI * 0.78);
    body += `<polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${leftX.toFixed(1)},${leftY.toFixed(1)} ${baseLeftX.toFixed(1)},${baseLeftY.toFixed(1)} ${baseRightX.toFixed(1)},${baseRightY.toFixed(1)} ${rightX.toFixed(1)},${rightY.toFixed(1)}" fill="${r.color}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="captcha"><rect width="${W}" height="${H}" rx="10" fill="#f8f9fa"/>${body}</svg>`;
}

// ─── Settings ───
let cachedCaptchaSettings: CaptchaSettings | null = null;
let cachedCaptchaSettingsAt = 0;
const CAPTCHA_SETTINGS_TTL = 15_000;

export async function getCaptchaSettings(): Promise<CaptchaSettings> {
  if (cachedCaptchaSettings && Date.now() - cachedCaptchaSettingsAt < CAPTCHA_SETTINGS_TTL) {
    return cachedCaptchaSettings!;
  }
  try {
    const record = await prisma.captchaSettings.findFirst({ where: { key: 'global', isActive: true } });
    cachedCaptchaSettings = record ? { ...DEFAULT_SETTINGS, ...record.value as any } : DEFAULT_SETTINGS;
    cachedCaptchaSettingsAt = Date.now();
    return cachedCaptchaSettings!;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function updateCaptchaSettings(settings: Partial<CaptchaSettings>): Promise<CaptchaSettings> {
  const current = await getCaptchaSettings();
  const updated = { ...current, ...settings };
  await prisma.captchaSettings.upsert({
    where: { key: 'global' },
    update: { value: updated as any, updatedAt: new Date() },
    create: { key: 'global', value: updated as any, description: 'Global CAPTCHA settings' },
  });
  cachedCaptchaSettings = updated;
  cachedCaptchaSettingsAt = Date.now();
  return updated;
}

// ─── Warning counts / blocks (existing behavior preserved) ───
// Cache for getUserWarningCount — DB counts are expensive and this is called on every login.
const warningCountCache = new Map<string, { count: number; recentBlocks: number; at: number }>();
const WARNING_CACHE_TTL = 30_000; // 30s TTL — stale data acceptable for security checks

export async function getUserWarningCount(userId: string, ipAddress?: string): Promise<{ count: number; recentBlocks: number }> {
  const cacheKey = `${userId}:${ipAddress || ''}`;
  const cached = warningCountCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WARNING_CACHE_TTL) {
    return { count: cached.count, recentBlocks: cached.recentBlocks };
  }
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [warningCount, recentBlocks] = await Promise.all([
      prisma.captchaLog.count({
        where: { userId, eventType: { in: ['attempt_failed', 'blocked'] }, createdAt: { gte: dayAgo } },
      }),
      prisma.captchaBlock.count({
        where: { userId, blockedAt: { gte: dayAgo }, unblockedAt: null },
      }),
    ]);
    warningCountCache.set(cacheKey, { count: warningCount, recentBlocks, at: Date.now() });
    // Evict old entries
    if (warningCountCache.size > 5000) {
      const cutoff = Date.now() - WARNING_CACHE_TTL;
      for (const [k, v] of warningCountCache) {
        if (v.at < cutoff) warningCountCache.delete(k);
      }
    }
    return { count: warningCount, recentBlocks };
  } catch {
    return { count: 0, recentBlocks: 0 };
  }
}

export function bustWarningCountCache(userId: string) {
  // Evict all entries for this user (different IPs)
  for (const [k] of warningCountCache) {
    if (k.startsWith(userId + ':')) warningCountCache.delete(k);
  }
}

export async function getSessionWarningCount(sessionId: string): Promise<{ count: number; recentBlocks: number }> {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const warningCount = await prisma.captchaLog.count({
      where: { sessionId, eventType: { in: ['attempt_failed', 'blocked'] }, createdAt: { gte: dayAgo } },
    });
    const recentBlocks = await prisma.captchaBlock.count({
      where: { sessionId, blockedAt: { gte: dayAgo }, unblockedAt: null },
    });
    return { count: warningCount, recentBlocks };
  } catch {
    return { count: 0, recentBlocks: 0 };
  }
}

const blockedCache = new Map<string, { blocked: boolean; rayId?: string; reason?: string; expiresAt?: Date; at: number }>();
const BLOCKED_CACHE_TTL = 5_000;

function blockedCacheKey(userId?: string, sessionId?: string, ipAddress?: string): string {
  return [userId || '', sessionId || '', ipAddress || ''].join('|');
}

function invalidateBlockedCache(identifiers: Array<string | undefined>) {
  const key = blockedCacheKey(identifiers[0], identifiers[1], identifiers[2]);
  blockedCache.delete(key);
}

export async function isBlocked(userId?: string, sessionId?: string, ipAddress?: string): Promise<{ blocked: boolean; rayId?: string; reason?: string; expiresAt?: Date }> {
  try {
    const settings = await getCaptchaSettings();
    if (!settings.enabled) return { blocked: false };

    const cacheKey = blockedCacheKey(userId, sessionId, ipAddress);
    const hit = blockedCache.get(cacheKey);
    if (hit && Date.now() - hit.at < BLOCKED_CACHE_TTL) {
      return { blocked: hit.blocked, rayId: hit.rayId, reason: hit.reason, expiresAt: hit.expiresAt };
    }

    const now = new Date();

    for (const where of [
      userId ? { userId } : null,
      sessionId ? { sessionId } : null,
      ipAddress ? { ipAddress } : null,
    ].filter(Boolean)) {
      const block = await prisma.captchaBlock.findFirst({
        where: {
          ...(where as any),
          blockedAt: { lte: now },
          unblockedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        orderBy: { blockedAt: 'desc' },
      });
      if (block) {
        blockedCache.set(cacheKey, { blocked: true, rayId: block.rayId, reason: block.reason, expiresAt: block.expiresAt || undefined, at: Date.now() });
        return { blocked: true, rayId: block.rayId, reason: block.reason, expiresAt: block.expiresAt || undefined };
      }
    }
    blockedCache.set(cacheKey, { blocked: false, at: Date.now() });
    if (blockedCache.size > 5000) {
      const cutoff = Date.now() - BLOCKED_CACHE_TTL;
      for (const [k, v] of blockedCache) {
        if (v.at < cutoff) blockedCache.delete(k);
      }
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

export function riskLevelToDifficulty(level: string, settings: CaptchaSettings): CaptchaDifficulty {
  if (level === 'strong') return 'hard';
  if (level === 'standard') return 'medium';
  return 'easy';
}

export async function getRequiredDifficulty(userId?: string, sessionId?: string, ipAddress?: string, risk?: RiskResult | null): Promise<CaptchaDifficulty> {
  const settings = await getCaptchaSettings();
  if (!settings.autoEnforce) return 'easy';

  const userWarnings = userId ? (await getUserWarningCount(userId, ipAddress)).count : 0;
  const sessionWarnings = sessionId ? (await getSessionWarningCount(sessionId)).count : 0;
  const totalWarnings = Math.max(userWarnings, sessionWarnings);

  let fromRisk: CaptchaDifficulty | null = null;
  if (settings.riskEnabled && risk) {
    fromRisk = riskLevelToDifficulty(risk.level, settings);
  }

  const warningDifficulty: CaptchaDifficulty =
    totalWarnings >= settings.blockThreshold || totalWarnings >= settings.hardThreshold
      ? 'hard'
      : totalWarnings >= settings.mediumThreshold
        ? 'medium'
        : 'easy';

  const rank: Record<CaptchaDifficulty, number> = { easy: 0, medium: 1, hard: 2 };
  if (fromRisk && rank[fromRisk] > rank[warningDifficulty]) return fromRisk;
  return warningDifficulty;
}

// ─── Challenge generation ───
export async function generateChallenge(difficulty: CaptchaDifficulty, sessionId: string, userId?: string, ipAddress?: string, userAgent?: string): Promise<CaptchaChallenge> {
  const settings = await getCaptchaSettings();
  const expiresAt = new Date(Date.now() + settings.challengeExpiry * 60 * 1000);

  const typePool: CaptchaType[] = difficulty === 'easy' ? ['math', 'word'] : ['count', 'shape', 'direction', 'math'];
  const challengeType = typePool[(randomInt as Function)(0, typePool.length)];
  const id = Buffer.from(randomBytes(16)).toString('hex');
  const rayId = Buffer.from(randomBytes(8)).toString('hex');

  let question: string;
  let answerHash: string;
  let options: any;
  let imageUrl: string | null = null;

  const derived = deriveParams(challengeType, id);
  if (derived.render.type !== 'none') {
    question = derived.question;
    answerHash = await hashAnswer(derived.answer);
    options = derived.options;
    imageUrl = `/api/captcha/image/${id}?token=${signImageToken(id)}`;
  } else if (challengeType === 'math') {
    const a = (randomInt as Function)(1, 10);
    const b = (randomInt as Function)(1, 10);
    const answer = (a + b).toString();
    question = `What is ${a} + ${b}?`;
    answerHash = await hashAnswer(answer);
    options = shuffleArray([answer, (randomInt as Function)(1, 20).toString(), (randomInt as Function)(1, 20).toString(), (randomInt as Function)(1, 20).toString()]);
  } else {
    const words = ['apple', 'banana', 'cherry', 'grape', 'lemon', 'peach', 'plum', 'melon'];
    const target = words[(randomInt as Function)(0, words.length)];
    question = `Select the word: ${target.charAt(0).toUpperCase() + target.slice(1)}`;
    answerHash = await hashAnswer(target);
    const distractors = words.filter(w => w !== target).slice(0, 3);
    options = shuffleArray([target, ...distractors]);
  }

  return prisma.captchaChallenge.create({
    data: {
      id,
      sessionId,
      userId,
      difficulty,
      challengeType,
      question,
      answerHash,
      options,
      imageUrl,
      ipAddress,
      userAgent,
      rayId,
      expiresAt,
    },
  }) as unknown as CaptchaChallenge;
}

export function issueChallengeToken(challenge: { id: string; expiresAt: Date }, ipHash: string, uaHash: string, fpHash: string): string {
  return signToken({
    id: challenge.id,
    exp: Math.floor(challenge.expiresAt.getTime() / 1000),
    nonce: Buffer.from(randomBytes(8)).toString('hex'),
    ipHash,
    uaHash,
    fpHash,
  });
}

export interface VerifyResult {
  valid: boolean;
  rayId?: string;
  blocked?: boolean;
  reason?: string;
  nextRequired?: boolean;
  risk?: RiskResult;
}

export async function verifyChallenge(input: {
  challengeId: string;
  answer: string;
  token: string;
  ipAddress: string;
  userAgent: string;
  sessionId: string;
  fingerprint?: string;
  behavior?: BehaviorData;
}): Promise<VerifyResult> {
  const settings = await getCaptchaSettings();
  const ipHash = createHash('sha256').update(input.ipAddress || '').digest('hex');
  const uaHash = createHash('sha256').update(input.userAgent || '').digest('hex');
  const fpHash = createHash('sha256').update(input.fingerprint || '').digest('hex');

  const tokenCheck = await verifyChallengeToken(input.token, { id: input.challengeId, ipHash, uaHash, fpHash });
  if (!tokenCheck.ok) {
    await logCaptchaEvent(undefined, input.sessionId, input.ipAddress, 'verify_rejected', undefined, undefined, { reason: tokenCheck.reason });
    return { valid: false, reason: tokenCheck.reason === 'expired' ? 'Challenge expired. Please try again.' : 'Invalid challenge token' };
  }

  const challenge = await prisma.captchaChallenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge) return { valid: false, reason: 'Challenge not found' };
  if (challenge.solved) return { valid: false, reason: 'Challenge already used' };
  if (challenge.expiresAt < new Date()) return { valid: false, reason: 'Challenge expired' };
  if (challenge.sessionId && challenge.sessionId !== input.sessionId) return { valid: false, reason: 'Session mismatch' };
  if (challenge.ipAddress && challenge.ipAddress !== 'unknown' && challenge.ipAddress !== input.ipAddress) {
    return { valid: false, reason: 'Network mismatch' };
  }

  const answerHash = await hashAnswer(input.answer.trim().toLowerCase());
  const isValid = answerHash === challenge.answerHash;

  await prisma.captchaAttempt.create({
    data: {
      challengeId: challenge.id,
      userId: challenge.userId,
      sessionId: challenge.sessionId || input.sessionId,
      answer: input.answer.trim(),
      isCorrect: isValid,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });

  await prisma.captchaChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 }, ...(isValid ? { solved: true, solvedAt: new Date() } : {}) },
  });

  if (!isValid) {
    await logCaptchaEvent(challenge.userId ?? undefined, challenge.sessionId ?? input.sessionId, input.ipAddress ?? undefined, 'attempt_failed', challenge.difficulty, challenge.rayId);
    if (challenge.attempts + 1 >= settings.maxAttemptsPerChallenge) {
      await recordBlock(challenge.userId ?? undefined, challenge.sessionId ?? input.sessionId, input.ipAddress ?? undefined, 'too_many_attempts', {
        challengeId: challenge.id,
        attempts: challenge.attempts,
        rayId: challenge.rayId,
      });
      return { valid: false, blocked: true, rayId: challenge.rayId, reason: 'Too many failed attempts. Access temporarily blocked.' };
    }
    return { valid: false, rayId: challenge.rayId };
  }

  await recordDeviceSeen({
    fingerprint: input.fingerprint,
    userId: challenge.userId ?? undefined,
    ip: input.ipAddress,
    ua: input.userAgent,
    sessionId: input.sessionId,
  });

  const solveMs = input.behavior?.startedAt && input.behavior?.submittedAt
    ? Math.max(0, input.behavior.submittedAt - input.behavior.startedAt)
    : undefined;

  await logCaptchaEvent(
    challenge.userId ?? undefined,
    challenge.sessionId ?? input.sessionId,
    input.ipAddress ?? undefined,
    'challenge_solved',
    challenge.difficulty,
    challenge.rayId,
    solveMs !== undefined ? { solveMs, challengeType: challenge.challengeType } : { challengeType: challenge.challengeType }
  );

  let risk: RiskResult | undefined;
  if (settings.riskEnabled) {
    risk = await computeRiskScore({
      ip: input.ipAddress,
      ua: input.userAgent,
      userId: challenge.userId || undefined,
      sessionId: input.sessionId,
      fingerprint: input.fingerprint,
      behavior: input.behavior,
    });
    if (risk.requireCaptcha) {
      return { valid: true, rayId: challenge.rayId, nextRequired: true, risk };
    }
  }

  return { valid: true, rayId: challenge.rayId, risk };
}

// ─── Blocks ───
export async function recordBlock(userId: string | undefined, sessionId: string | undefined, ipAddress: string | undefined, reason: string, metadata?: any): Promise<string> {
  const rayId = Buffer.from(randomBytes(16)).toString('hex');
  const settings = await getCaptchaSettings();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.captchaBlock.create({
    data: { userId: userId ?? null, sessionId: sessionId || '', ipAddress: ipAddress || 'unknown', reason, rayId, expiresAt, metadata },
  });
  invalidateBlockedCache([userId, sessionId, ipAddress || 'unknown']);
  await logCaptchaEvent(userId, sessionId, ipAddress ?? undefined, 'blocked', 'hard', rayId, metadata);

  const warningCount = userId ? (await getUserWarningCount(userId, ipAddress)).count : 0;
  if (warningCount >= settings.adminNotifyThreshold) {
    await notifyAdminOfBlock(userId, sessionId, ipAddress, reason, rayId, warningCount);
  }
  return rayId;
}

export async function unblockUser(rayId: string, adminId?: string): Promise<boolean> {
  const block = await prisma.captchaBlock.findUnique({ where: { rayId } });
  if (!block) return false;
  await prisma.captchaBlock.update({
    where: { rayId },
    data: { unblockedAt: new Date(), unblockedBy: adminId },
  });
  invalidateBlockedCache([block.userId ?? undefined, block.sessionId ?? undefined, block.ipAddress ?? undefined]);
  await logCaptchaEvent(block.userId ?? undefined, block.sessionId ?? undefined, block.ipAddress ?? undefined, 'unblocked', undefined, rayId);
  return true;
}

export async function logCaptchaEvent(userId: string | undefined, sessionId: string | undefined, ipAddress: string | undefined, eventType: string, difficulty?: string, rayId?: string, metadata?: any): Promise<void> {
  try {
    await prisma.captchaLog.create({
      data: {
        userId,
        sessionId: sessionId || 'anonymous',
        ipAddress: ipAddress || 'unknown',
        eventType,
        difficulty,
        rayId,
        metadata,
      },
    });
  } catch {
    // Best-effort logging
  }
}

// ─── Analytics ───
export async function getCaptchaAnalytics(timeRange: '24h' | '7d' | '30d' = '24h') {
  const now = new Date();
  const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720;
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const [totalChallenges, totalAttempts, totalCorrect, totalBlocks, activeBlocks, solvedLogs, failedByIp, recentLogs] = await Promise.all([
    prisma.captchaChallenge.count({ where: { createdAt: { gte: start } } }),
    prisma.captchaAttempt.count({ where: { createdAt: { gte: start } } }),
    prisma.captchaAttempt.count({ where: { createdAt: { gte: start }, isCorrect: true } }),
    prisma.captchaBlock.count({ where: { blockedAt: { gte: start } } }),
    prisma.captchaBlock.count({ where: { blockedAt: { lte: now }, unblockedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] } }),
    prisma.captchaLog.findMany({
      where: { eventType: 'challenge_solved', createdAt: { gte: start } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.captchaLog.groupBy({
      by: ['ipAddress'],
      where: { eventType: 'attempt_failed', createdAt: { gte: start } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.captchaLog.findMany({ where: { createdAt: { gte: start } }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);

  const solveTimes = solvedLogs
    .map(l => (l.metadata as any)?.solveMs)
    .filter((v: any): v is number => typeof v === 'number');
  const avgSolveMs = solveTimes.length
    ? Math.round(solveTimes.reduce((a: number, b: number) => a + b, 0) / solveTimes.length)
    : null;

  const difficultyDistribution = await prisma.captchaChallenge.groupBy({
    by: ['difficulty'],
    where: { createdAt: { gte: start } },
    _count: { id: true },
  });

  return {
    range: timeRange,
    totalChallenges,
    totalAttempts,
    totalCorrect,
    passRate: totalAttempts > 0 ? Number(((totalCorrect / totalAttempts) * 100).toFixed(1)) : null,
    failRate: totalAttempts > 0 ? Number((((totalAttempts - totalCorrect) / totalAttempts) * 100).toFixed(1)) : null,
    totalBlocks,
    activeBlocks,
    avgSolveMs,
    difficultyDistribution,
    topFailedIps: failedByIp.map(x => ({ ip: x.ipAddress, count: x._count.id })),
    recentLogs,
  };
}

export async function getBlockedUsers(page: number = 1, limit: number = 50) {
  const skip = (page - 1) * limit;
  const [blocks, total] = await Promise.all([
    prisma.captchaBlock.findMany({
      where: { blockedAt: { lte: new Date() }, unblockedAt: null },
      orderBy: { blockedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.captchaBlock.count({ where: { blockedAt: { lte: new Date() }, unblockedAt: null } }),
  ]);
  return { blocks, total, page, limit };
}

export async function getCaptchaLogs(page: number = 1, limit: number = 100, filters?: { userId?: string; ipAddress?: string; eventType?: string; rayId?: string }) {
  const skip = (page - 1) * limit;
  const where: any = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.ipAddress) where.ipAddress = filters.ipAddress;
  if (filters?.eventType) where.eventType = filters.eventType;
  if (filters?.rayId) where.rayId = filters.rayId;
  const [logs, total] = await Promise.all([
    prisma.captchaLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.captchaLog.count({ where }),
  ]);
  return { logs, total, page, limit };
}

// ─── Validating a solved captcha presented to a protected handler ───
export async function assertCaptchaSatisfied(opts: {
  rayId?: string;
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  fingerprint?: string;
  requiredDifficulty: CaptchaDifficulty;
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.rayId) {
    return { ok: false, error: 'CAPTCHA verification required. Please complete the challenge.' };
  }
  const solved = await prisma.captchaChallenge.findFirst({
    where: {
      rayId: opts.rayId,
      solved: true,
      solvedAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
    },
  });
  if (!solved) {
    return { ok: false, error: 'CAPTCHA verification failed. Please try again.' };
  }
  if (solved.sessionId && solved.sessionId !== opts.sessionId) {
    return { ok: false, error: 'CAPTCHA verification failed. Please try again.' };
  }
  const rank: Record<CaptchaDifficulty, number> = { easy: 0, medium: 1, hard: 2 };
  if (rank[solved.difficulty as CaptchaDifficulty] < rank[opts.requiredDifficulty]) {
    return { ok: false, error: 'A stronger verification is required. Please complete the challenge again.' };
  }
  return { ok: true };
}

function hashAnswer(answer: string): Promise<string> {
  return Promise.resolve(createHash('sha256').update(answer).digest('hex'));
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (randomInt as Function)(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function notifyAdminOfBlock(userId: string | undefined, sessionId: string | undefined, ipAddress: string | undefined, reason: string, rayId: string, warningCount: number): Promise<void> {
  try {
    const { notifyAdmins } = await import('../security');
    await notifyAdmins({
      subject: 'Captcha block threshold exceeded',
      message: `A user was blocked after triggering the captcha threshold (${warningCount} warnings).`,
      details: [
        `reason: ${reason}`,
        `rayId: ${rayId}`,
        `userId: ${userId || 'anonymous'}`,
        `sessionId: ${sessionId || 'none'}`,
        `ip: ${ipAddress || 'unknown'}`,
        `warnings: ${warningCount}`,
      ].join('\n'),
      severity: 'warning',
    });
  } catch (e) {
    console.error('[CAPTCHA] Admin notification failed:', e instanceof Error ? e.message : e);
  }
}

export async function cleanupExpiredChallenges(): Promise<void> {
  await prisma.captchaChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() }, solved: false },
  });
}

export { computeDeviceFingerprint, hasRecentLoginSuccess };
