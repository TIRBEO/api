import { prisma } from './db/prisma';

export interface AccountTip {
  id: string;
  title: string;
  body: string;
  actionUrl: string;
  actionLabel: string;
}

const D = '/dashboard';

export async function computeTips(userId: string): Promise<AccountTip[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      emailVerified: true,
      is2FAEnabled: true,
      secondaryEmail: true,
      secondaryEmailVerified: true,
      phoneNumber: true,
      phoneVerified: true,
      photoUrl: true,
      username: true,
      bio: true,
      occupation: true,
      lastLoginAt: true,
      lastActiveAt: true,
      createdAt: true,
      googleId: true,
      githubId: true,
      discordId: true,
      notificationPreferences: true,
      _count: { select: { passkeys: true } },
    },
  });
  if (!user) return [];

  // Parallel counts for richer tips — all DB-connected
  const [formsCount, ticketsCount, apiKeysCount, sessionsCount] = await Promise.all([
    prisma.form.count({ where: { userId } }).catch(()=>0),
    prisma.ticket.count({ where: { customerId: userId } }).catch(()=>0),
    prisma.apiKey.count({ where: { userId } }).catch(()=>0),
    prisma.session.count({ where: { userId, status: 'active' } }).catch(()=>0),
  ]);

  const tips: AccountTip[] = [];

  if (!user.is2FAEnabled) {
    tips.push({
      id: 'enable-2fa',
      title: 'Add 2FA — 30 seconds, much safer',
      body: 'Two-factor keeps your account safe even if your password leaks. Use any authenticator app.',
      actionUrl: `${D}/account/security`,
      actionLabel: 'Enable 2FA',
    });
  }

  if (!user.secondaryEmail || !user.secondaryEmailVerified) {
    tips.push({
      id: 'recovery-email',
      title: 'Add a recovery email',
      body: 'A backup email lets you get back in if you lose your primary inbox.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Add recovery email',
    });
  }

  if (!user.phoneNumber) {
    tips.push({
      id: 'add-phone',
      title: 'Add a recovery phone',
      body: 'A phone gives you another way to verify it’s you — useful for lockouts.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Add phone',
    });
  }

  const hasLinked = !!(user.googleId || user.githubId || user.discordId);
  if (user._count.passkeys === 0 && !hasLinked) {
    tips.push({
      id: 'faster-signin',
      title: 'Sign in faster — passkey or Google',
      body: 'Skip passwords: use fingerprint/face or one-click Google/GitHub.',
      actionUrl: `${D}/account/security`,
      actionLabel: 'Set up passkey',
    });
  } else if (user._count.passkeys === 0 && hasLinked) {
    tips.push({
      id: 'add-passkey-anyway',
      title: 'Try a passkey for instant sign-in',
      body: 'You have Google/GitHub linked — a passkey is even faster and works offline.',
      actionUrl: `${D}/account/security`,
      actionLabel: 'Create passkey',
    });
  }

  if (!user.photoUrl || !user.username) {
    tips.push({
      id: 'complete-profile',
      title: 'Complete your profile',
      body: [!user.photoUrl ? 'Add a photo' : null, !user.username ? 'pick a username' : null].filter(Boolean).join(' and ') + ' so teammates recognize you.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Complete profile',
    });
  }

  if (!user.bio) {
    tips.push({
      id: 'add-bio',
      title: 'Add a short bio',
      body: 'A one-line bio helps collaborators understand your role. Takes 10 seconds.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Add bio',
    });
  }

  if (formsCount === 0) {
    tips.push({
      id: 'first-form',
      title: 'Create your first form',
      body: 'Forms are the fastest way to collect responses. Try a blank form or a template.',
      actionUrl: `${D}/forms`,
      actionLabel: 'Create form',
    });
  } else if (formsCount === 1) {
    tips.push({
      id: 'form-templates',
      title: 'Try a form template',
      body: 'You have 1 form — templates save time for contact, feedback, or sign-ups.',
      actionUrl: `${D}/forms`,
      actionLabel: 'Browse templates',
    });
  }

  if (ticketsCount === 0) {
    tips.push({
      id: 'know-support',
      title: 'Know where to get help',
      body: 'If something breaks, open a ticket — support replies in-app and by email.',
      actionUrl: `${D}/support/tickets`,
      actionLabel: 'Open support',
    });
  }

  if (apiKeysCount === 0 && formsCount > 0) {
    tips.push({
      id: 'try-api',
      title: 'Automate with an API key',
      body: 'You have forms — an API key lets you push submissions to your own app.',
      actionUrl: `${D}/account/apps`,
      actionLabel: 'Create API key',
    });
  }

  if (sessionsCount > 3) {
    tips.push({
      id: 'review-sessions',
      title: `You have ${sessionsCount} active sessions`,
      body: 'Review where you’re signed in and sign out old devices for safety.',
      actionUrl: `${D}/account/sessions`,
      actionLabel: 'Review sessions',
    });
  }

  const daysSinceActive = user.lastActiveAt ? Math.floor((Date.now() - new Date(user.lastActiveAt).getTime())/86400000) : 999;
  if (daysSinceActive > 14) {
    tips.push({
      id: 'welcome-back',
      title: 'Welcome back — pick up where you left off',
      body: `You haven’t been active for ${daysSinceActive} days. Check your inbox and recent activity.`,
      actionUrl: `${D}/home`,
      actionLabel: 'Go to overview',
    });
  } else if (daysSinceActive > 7) {
    tips.push({
      id: 'stay-active',
      title: 'Stay in the loop',
      body: 'Enable the daily digest to get a quick summary even when you don’t log in.',
      actionUrl: `${D}/account/notifications`,
      actionLabel: 'Enable digest',
    });
  }

  // Notifications not enabled for product
  const prefs: any = (user as any).notificationPreferences;
  if (prefs && prefs.product === false) {
    tips.push({
      id: 'enable-product-updates',
      title: 'Turn on product updates',
      body: 'Get notified about new features and improvements — low volume, useful.',
      actionUrl: `${D}/account/notifications`,
      actionLabel: 'Enable product updates',
    });
  }

  // Suspicious activity
  try {
    const since = new Date(Date.now() - 30*86400000);
    const failed = await prisma.securityEvent.count({ where: { userId, severity: { in: ['warning','error','critical'] }, createdAt: { gte: since } } });
    if (failed >= 3) {
      tips.unshift({
        id: 'review-security',
        title: `Review ${failed} security events`,
        body: 'We saw several security events recently — review them to be sure it’s you.',
        actionUrl: `${D}/activity/history`,
        actionLabel: 'Review activity',
      });
    }
  } catch {}

  // Ensure at least one tip for new users with nothing to do (onboarding)
  if (tips.length === 0) {
    tips.push({
      id: 'explore-overview',
      title: 'Explore your dashboard',
      body: 'Your overview shows recent activity, tickets, and quick actions — a good place to start.',
      actionUrl: `${D}/home`,
      actionLabel: 'Open overview',
    });
  }

  return tips;
}

export async function nextUnsentTip(userId: string): Promise<AccountTip | null> {
  const tips = await computeTips(userId);
  if (tips.length === 0) return null;
  const sent = await prisma.userTipLog.findMany({ where: { userId }, select: { tipId: true } });
  const sentIds = new Set(sent.map((s) => s.tipId));
  return tips.find((t) => !sentIds.has(t.id)) ?? null;
}

export async function sendNextTipForUser(userId: string): Promise<boolean> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } }).catch(()=>null);
    const prefs: any = (u as any)?.notificationPreferences;
    if (prefs && typeof prefs === 'object') {
      if (prefs.email === false) return false;
      const tipsOn = prefs.tips !== undefined ? prefs.tips !== false : true;
      const tipsEmailOn = prefs.tipsEmail !== undefined ? prefs.tipsEmail !== false : (prefs.productEmail !== false);
      if (!tipsOn || !tipsEmailOn) return false;
    }
    const tip = await nextUnsentTip(userId);
    if (!tip) return false;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return false;
    const { sendTemplateEmail } = await import('./email');
    const { getDashboardBaseUrl } = await import('./app-urls');
    const dashboardUrl = getDashboardBaseUrl();
    const result = await sendTemplateEmail(user.email, 'account_tip', {
      name: user.name || user.email,
      tipTitle: tip.title,
      tipBody: tip.body,
      actionUrl: `${dashboardUrl}${tip.actionUrl.replace(/^\/dashboard/, '')}`,
      actionLabel: tip.actionLabel,
      dashboardUrl,
    }).catch(()=>({ success:false }));
    if (!result.success) return false;
    await prisma.userTipLog.create({ data: { userId, tipId: tip.id } }).catch(()=>{});
    console.log(`[TIPS] Sent '${tip.id}' to ${user.email}`);
    return true;
  } catch (err:any) {
    console.error('[TIPS] sendNextTipForUser failed:', err?.message);
    return false;
  }
}

/**
 * Dynamic per-user tip interval based on user profile and activity.
 * Active/new users get tips more frequently (1-2 days).
 * Inactive/established users get tips less frequently (3-7 days).
 * The interval is deterministic for the same user data so it stays
 * consistent across sweep runs, but changes if the user's profile changes.
 */
function userTipIntervalMs(userId: string, user?: {
  createdAt?: Date | null;
  lastActiveAt?: Date | null;
  tipCount?: number;
}): number {
  const DAY = 86_400_000;
  const MIN = 1;   // minimum days
  const MAX = 7;   // maximum days

  // Base: deterministic hash of userId (stable per user)
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  const baseDays = MIN + (hash % ((MAX - MIN) * 1000 + 1)) / 1000; // 1.000 – 7.000

  if (!user) return Math.floor(baseDays * DAY);

  // ── Adjust based on user signals ──
  let multiplier = 1.0;

  // 1. New users (< 7 days old) → tip faster to onboard
  if (user.createdAt) {
    const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / DAY;
    if (ageDays < 1) multiplier *= 0.3;       // first day: very frequent
    else if (ageDays < 3) multiplier *= 0.5;   // first 3 days
    else if (ageDays < 7) multiplier *= 0.7;   // first week
  }

  // 2. Active users (logged in within 3 days) → tip faster
  if (user.lastActiveAt) {
    const inactiveDays = (Date.now() - new Date(user.lastActiveAt).getTime()) / DAY;
    if (inactiveDays <= 1) multiplier *= 0.6;      // active today: faster
    else if (inactiveDays <= 3) multiplier *= 0.8;  // active this week
    else if (inactiveDays <= 7) multiplier *= 1.0;  // normal
    else if (inactiveDays <= 14) multiplier *= 1.3; // 1-2 weeks idle: slower
    else multiplier *= 1.8;                         // 2+ weeks idle: much slower
  }

  // 3. Users with many tips already → slow down to avoid fatigue
  const tipCount = user.tipCount ?? 0;
  if (tipCount >= 8) multiplier *= 1.5;
  else if (tipCount >= 5) multiplier *= 1.2;
  else if (tipCount <= 1) multiplier *= 0.7; // new user, few tips sent: tip faster

  const adjustedDays = Math.max(MIN, Math.min(MAX, baseDays * multiplier));
  return Math.floor(adjustedDays * DAY);
}

export async function runAutoTipsSweep() {
  try {
    // Fetch eligible users with profile data for dynamic interval calculation.
    type EligibleRow = { id: string; createdAt: Date | null; lastActiveAt: Date | null; tipCount: number };
    const eligible = await prisma.$queryRaw<EligibleRow[]>`
      SELECT
        u."id",
        u."created_at" AS "createdAt",
        u."last_active_at" AS "lastActiveAt",
        COALESCE((SELECT COUNT(*) FROM "user_tip_logs" WHERE "user_id" = u."id"), 0)::int AS "tipCount"
      FROM "users" u
      WHERE u."deleted_at" IS NULL AND u."is_banned" = false
        AND (u."notification_preferences"->>'email')::boolean IS NOT FALSE
        AND COALESCE((u."notification_preferences"->>'tipsEmail')::boolean, (u."notification_preferences"->>'productEmail')::boolean, true) IS NOT FALSE
        AND COALESCE((u."notification_preferences"->>'tips')::boolean, (u."notification_preferences"->>'product')::boolean, true) IS NOT FALSE
      LIMIT 5000`;
    if (eligible.length === 0) return;

    const userIds = eligible.map(u => u.id);

    // Get the most recent tip log for each eligible user
    const recentLogs = await prisma.$queryRaw<Array<{ userId: string; lastSentAt: Date }>>`
      SELECT "user_id" AS "userId", MAX("sent_at") AS "lastSentAt"
      FROM "user_tip_logs"
      WHERE "user_id" = ANY(${userIds})
      GROUP BY "user_id"
    `;
    const lastSentMap = new Map(recentLogs.map(r => [r.userId, new Date(r.lastSentAt).getTime()]));

    const now = Date.now();
    let sentCount = 0;

    for (const u of eligible) {
      const lastSent = lastSentMap.get(u.id) || 0;
      const interval = userTipIntervalMs(u.id, {
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        tipCount: u.tipCount,
      });

      // Only send if enough time has passed since the user's last tip
      if (now - lastSent < interval) continue;

      const ok = await sendNextTipForUser(u.id);
      if (ok) sentCount++;
    }

    if (sentCount > 0) console.log(`[TIPS] Sweep complete — ${sentCount} tips sent`);
  } catch (err: any) {
    console.error('[TIPS] Sweep error:', err?.message);
  }
}

let tipsTimeout: ReturnType<typeof setTimeout> | null = null;
function scheduleNextSweep() {
  if (tipsTimeout) clearTimeout(tipsTimeout);
  // Sweep every hour — individual user intervals determine who actually gets a tip
  const delay = 3_600_000; // 1 hour
  const nextAt = new Date(Date.now() + delay);
  console.log(`[TIPS] Next sweep at ${nextAt.toISOString()} (in 60min)`);
  tipsTimeout = setTimeout(() => { runAutoTipsSweep().catch(() => {}).finally(() => scheduleNextSweep()); }, delay);
}

export function startPeriodicTips() {
  if (tipsTimeout) return;
  // First sweep after 2 minutes, then hourly
  setTimeout(() => { runAutoTipsSweep().catch(() => {}); }, 2 * 60_000);
  scheduleNextSweep();
  console.log('[TIPS] Periodic auto-tips started (dynamic per-user intervals based on activity, hourly sweep)');
}
