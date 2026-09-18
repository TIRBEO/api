/**
 * Email Brain — Event Registry (single source of truth).
 *
 * Every email-producing application event is declared here. The registry is
 * code-first (typed, reviewable, versioned with the app) and mirrored into the
 * `email_events` table for admin visibility/configuration. Docs:
 * docs/email-brain/01-architecture.md
 */
import { prisma } from '@/infrastructure/db/prisma';

export type EmailCategory = 'security' | 'transactional' | 'activity' | 'product' | 'marketing';
export type DeliveryMode = 'immediate' | 'digest' | 'manual';

export interface EmailEventDef {
  eventKey: string;
  category: EmailCategory;
  delivery: DeliveryMode;
  /** true → user preferences/frequency CANNOT suppress (security/account). */
  mandatory: boolean;
  description: string;
  /** Variable keys this event provides (resolved server-side at send time). */
  variables: string[];
  enabled: boolean;
}

/**
 * Default policy. Ships with "fewer useful emails over more emails":
 * activity → digest, product → digest/weekly, security → immediate + mandatory.
 */
export const EMAIL_EVENTS: EmailEventDef[] = [
  // ── Security (immediate, mandatory) ──────────────────────────────────
  { eventKey: 'auth.signup', category: 'security', delivery: 'immediate', mandatory: true, description: 'New account created — welcome + verification.', variables: ['user.name', 'verificationUrl'], enabled: true },
  { eventKey: 'auth.email_verification', category: 'security', delivery: 'immediate', mandatory: true, description: 'Email address verification request.', variables: ['user.name', 'verificationUrl'], enabled: true },
  { eventKey: 'auth.password_reset', category: 'security', delivery: 'immediate', mandatory: true, description: 'Password reset requested.', variables: ['user.name', 'resetUrl', 'reset.code'], enabled: true },
  { eventKey: 'auth.password_changed', category: 'security', delivery: 'immediate', mandatory: true, description: 'Password was changed — confirmation notice.', variables: ['user.name', 'changedAt'], enabled: true },
  { eventKey: 'auth.login_alert', category: 'security', delivery: 'immediate', mandatory: true, description: 'New sign-in from an unrecognized device.', variables: ['user.name', 'device', 'location', 'when'], enabled: true },
  { eventKey: 'auth.account_recovery', category: 'security', delivery: 'immediate', mandatory: true, description: 'Account recovery flow started.', variables: ['user.name', 'recoveryUrl'], enabled: true },
  { eventKey: 'auth.account_suspended', category: 'security', delivery: 'immediate', mandatory: true, description: 'Account suspension notice.', variables: ['user.name', 'reason'], enabled: true },
  { eventKey: 'auth.account_deleted', category: 'security', delivery: 'immediate', mandatory: true, description: 'Account deletion confirmation.', variables: ['user.name'], enabled: true },

  // ── Transactional ────────────────────────────────────────────────────
  { eventKey: 'billing.subscription_expired', category: 'transactional', delivery: 'immediate', mandatory: false, description: 'Subscription expired — what happens next.', variables: ['user.name', 'plan', 'expiredAt', 'renewUrl'], enabled: true },
  { eventKey: 'billing.invoice_created', category: 'transactional', delivery: 'immediate', mandatory: false, description: 'Invoice issued.', variables: ['user.name', 'invoiceId', 'amount', 'invoiceUrl'], enabled: true },
  { eventKey: 'billing.payment_failed', category: 'transactional', delivery: 'immediate', mandatory: false, description: 'Payment method declined.', variables: ['user.name', 'amount', 'updateUrl'], enabled: true },
  { eventKey: 'data.export_ready', category: 'transactional', delivery: 'immediate', mandatory: false, description: 'Requested data export is ready to download.', variables: ['user.name', 'downloadUrl', 'expiresAt'], enabled: true },

  // ── Activity (digest by default — anti-spam) ─────────────────────────
  { eventKey: 'activity.mention', category: 'activity', delivery: 'digest', mandatory: false, description: 'Someone mentioned the user.', variables: ['actor.name', 'context.url'], enabled: true },
  { eventKey: 'activity.comment', category: 'activity', delivery: 'digest', mandatory: false, description: 'Comment on the user\u2019s content.', variables: ['actor.name', 'context.url'], enabled: true },
  { eventKey: 'activity.collaboration', category: 'activity', delivery: 'digest', mandatory: false, description: 'Collaborator / sharing activity.', variables: ['actor.name', 'entity.name'], enabled: true },
  { eventKey: 'activity.project_update', category: 'activity', delivery: 'digest', mandatory: false, description: 'Project the user follows changed.', variables: ['entity.name', 'summary'], enabled: true },
  { eventKey: 'activity.team_invitation', category: 'activity', delivery: 'immediate', mandatory: false, description: 'Invited to join a team/workspace.', variables: ['actor.name', 'team.name', 'inviteUrl'], enabled: true },

  // ── Product (digest, weekly default) ─────────────────────────────────
  { eventKey: 'product.update', category: 'product', delivery: 'digest', mandatory: false, description: 'Feature announcements and product news.', variables: ['title', 'summary', 'link'], enabled: true },
  { eventKey: 'product.usage_summary', category: 'product', delivery: 'digest', mandatory: false, description: 'Periodic usage/productivity summary.', variables: ['period', 'stats'], enabled: true },
];

/** In-code lookup. */
const BY_KEY = new Map(EMAIL_EVENTS.map((e) => [e.eventKey, e]));

export function getEventDef(eventKey: string): EmailEventDef | undefined {
  return BY_KEY.get(eventKey);
}

/**
 * Sync registry into the DB (create missing, update policy fields).
 * Admin-side overrides (enabled/delivery) win for fields admins can change;
 * `mandatory`/`category` are code-owned and always realigned.
 */
export async function syncRegistry(): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const def of EMAIL_EVENTS) {
    const existing = await prisma.email_events.findUnique({ where: { eventKey: def.eventKey } });
    if (!existing) {
      await prisma.email_events.create({
        data: {
          eventKey: def.eventKey,
          category: def.category,
          delivery: def.delivery,
          mandatory: def.mandatory,
          description: def.description,
          defaultVars: def.variables as any,
          enabled: def.enabled,
        },
      });
      created++;
    } else if (
      existing.mandatory !== def.mandatory ||
      existing.category !== def.category ||
      existing.delivery !== def.delivery
    ) {
      await prisma.email_events.update({
        where: { eventKey: def.eventKey },
        data: { category: def.category, delivery: def.delivery, mandatory: def.mandatory },
      });
      updated++;
    }
  }
  return { created, updated };
}

/**
 * Missing-email detection — inspects the registry vs. configured definitions
 * and surfaces communication gaps for admin review (never auto-activates).
 */
export async function detectGaps(): Promise<Array<{ eventKey: string; severity: 'warning' | 'info' | 'ok'; message: string }>> {
  const definitions = await prisma.email_definitions.findMany({
    where: { status: { in: ['active', 'approved'] } },
    select: { eventKey: true, status: true },
  });
  const covered = new Set(definitions.filter((d) => d.status === 'active').map((d) => d.eventKey));

  const gaps: Array<{ eventKey: string; severity: 'warning' | 'info' | 'ok'; message: string }> = [];
  for (const def of EMAIL_EVENTS) {
    if (!def.enabled) continue;
    if (covered.has(def.eventKey)) {
      gaps.push({ eventKey: def.eventKey, severity: 'ok', message: 'Active content configured.' });
    } else if (def.mandatory) {
      // Mandatory security events fall back to built-in templates — informational.
      gaps.push({ eventKey: def.eventKey, severity: 'info', message: 'No active definition — falls back to built-in template.' });
    } else {
      gaps.push({ eventKey: def.eventKey, severity: 'warning', message: 'No active content configured for this event.' });
    }
  }
  return gaps;
}
