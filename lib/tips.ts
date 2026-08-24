import { prisma } from './db/prisma';

/**
 * Auto-generated account tips.
 * Each tip is derived from the user's actual account state — we only
 * suggest things the user has NOT done yet. Sent via email only when
 * the user opted in (notification_preferences.tips_email) and the tip
 * hasn't been sent before (user_tip_logs dedup table).
 */

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
      photoUrl: true,
      username: true,
      lastLoginAt: true,
      _count: { select: { passkeys: true, integrations: true } },
    },
  });
  if (!user) return [];

  const tips: AccountTip[] = [];

  if (!user.is2FAEnabled) {
    tips.push({
      id: 'enable-2fa',
      title: 'Add an extra layer of security with 2FA',
      body: 'Two-factor authentication protects your account even if your password leaks. It takes less than a minute to set up with any authenticator app.',
      actionUrl: `${D}/account/security`,
      actionLabel: 'Enable Two-Factor Authentication',
    });
  }

  if (!user.secondaryEmail || !user.secondaryEmailVerified) {
    tips.push({
      id: 'recovery-email',
      title: 'Add a recovery email',
      body: 'A secondary email gives you a backup way to regain access if you ever lose your primary inbox or get locked out.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Add Recovery Email',
    });
  }

  if (user._count.passkeys === 0 && user._count.integrations === 0) {
    tips.push({
      id: 'faster-signin',
      title: 'Sign in faster with a passkey or connected account',
      body: 'Passkeys let you sign in with your fingerprint or face — no password needed. You can also connect Google, GitHub, or Discord for one-click sign-in.',
      actionUrl: `${D}/account/passkeys`,
      actionLabel: 'Set Up Passkeys',
    });
  }

  if (!user.photoUrl || !user.username) {
    tips.push({
      id: 'complete-profile',
      title: 'Complete your profile',
      body: [
        !user.photoUrl ? 'Add a profile photo' : null,
        !user.username ? 'pick a unique username' : null,
      ].filter(Boolean).join(' and ') + ' so teammates can recognize you across Tirbeo apps.',
      actionUrl: `${D}/account/profile`,
      actionLabel: 'Complete Profile',
    });
  }

  // Suspicious activity check — repeated failed logins in the last 30 days.
  try {
    const since = new Date(Date.now() - 30 * 86400000);
    const failed = await prisma.securityEvent.count({
      where: { userId, severity: { in: ['warning', 'error', 'critical'] }, createdAt: { gte: since } },
    });
    if (failed >= 3) {
      tips.unshift({
        id: 'review-security',
        title: `Review ${failed} recent security events`,
        body: 'We noticed some security events on your account recently — like failed sign-in attempts. Take a moment to review them and make sure everything looks familiar.',
        actionUrl: `${D}/activity/history`,
        actionLabel: 'Review Activity',
      });
    }
  } catch { /* non-fatal */ }

  return tips;
}

/** Highest-priority tip the user hasn't received yet. */
export async function nextUnsentTip(userId: string): Promise<AccountTip | null> {
  const tips = await computeTips(userId);
  if (tips.length === 0) return null;
  const sent = await prisma.userTipLog.findMany({
    where: { userId },
    select: { tipId: true },
  });
  const sentIds = new Set(sent.map((s) => s.tipId));
  return tips.find((t) => !sentIds.has(t.id)) ?? null;
}

/**
 * Send the next applicable tip to one user (event-triggered, e.g. after login).
 * Fire-and-forget safe: never throws, silently skips when disabled/already sent.
 */
export async function sendNextTipForUser(userId: string): Promise<boolean> {
  try {
    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId },
      select: { email: true, tipsEmail: true },
    }).catch(() => null);
    // Default ON when prefs row doesn't exist yet; respect explicit opt-outs.
    if (prefs && (prefs.email === false || prefs.tipsEmail === false)) return false;

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
    }).catch(() => ({ success: false }));

    if (!result.success) return false;

    await prisma.userTipLog.create({ data: { userId, tipId: tip.id } }).catch(() => {});
    console.log(`[TIPS] Sent '${tip.id}' to ${user.email}`);
    return true;
  } catch (err: any) {
    console.error('[TIPS] sendNextTipForUser failed:', err?.message);
    return false;
  }
}

/**
 * Daily sweep — sends at most one tip per user per 3 days so it stays helpful, not spammy.
 */
export async function runAutoTipsSweep() {
  try {
    const cutoff = new Date(Date.now() - 3 * 86400000);
    const eligible = await prisma.notificationPreference.findMany({
      where: { email: true, tipsEmail: true },
      select: { userId: true },
      take: 5000,
    });

    let sentCount = 0;
    for (const p of eligible) {
      const last = await prisma.userTipLog.findFirst({
        where: { userId: p.userId },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      });
      // Skip users who got a tip very recently (unless they have NO tips logged yet)
      if (last && last.sentAt > cutoff) continue;
      const ok = await sendNextTipForUser(p.userId);
      if (ok) sentCount++;
    }
    if (sentCount > 0) console.log(`[TIPS] Sweep complete — ${sentCount} tips sent`);
  } catch (err: any) {
    console.error('[TIPS] Sweep error:', err?.message);
  }
}

let tipsInterval: ReturnType<typeof setInterval> | null = null;
export function startPeriodicTips() {
  if (tipsInterval) return;
  setTimeout(() => { runAutoTipsSweep().catch(() => {}); }, 5 * 60_000); // first run 5 min after boot
  tipsInterval = setInterval(() => { runAutoTipsSweep().catch(() => {}); }, 24 * 3_600_000); // daily
  console.log('[TIPS] Periodic auto-tips started (daily)');
}
