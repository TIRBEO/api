/**
 * Email Brain — Digest Engine.
 *
 * Deterministic aggregation: items grouped by category/entity, deduped
 * (unique index), ranked by importance, rendered from a deterministic
 * template. AI enhancement is OFF by default and only ever rewrites ONE
 * summary line per digest when enabled. Docs: docs/email-brain/01-architecture.md
 */
import { prisma } from '@/infrastructure/db/prisma';
import { sendEmail } from '@/features/email/email';
import { renderEmail } from '@/features/email-brain/render';
import type { EmailContent } from '@/features/email-brain/ai';

const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

const CATEGORY_LABELS: Record<string, string> = {
  activity: 'Activity',
  product: 'Product',
  transactional: 'Updates',
};

interface DigestUser {
  id: string;
  email: string;
  frequency: string;
}

/** Users with unconsumed digest items whose cadence is due. */
async function findDueUsers(cadence: 'daily' | 'weekly' | 'monthly'): Promise<DigestUser[]> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string; email: string; frequency: string }>>`
    SELECT p.user_id, u.email, p.frequency
    FROM email_preferences p
    JOIN users u ON u.id = p.user_id
    WHERE u.deleted_at IS NULL AND u.is_banned = false
      AND p.frequency = ${cadence}
      AND EXISTS (
        SELECT 1 FROM email_digest_items i
        WHERE i.user_id = p.user_id AND i.consumed = false
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_digests d
        WHERE d.user_id = p.user_id AND d.cadence = ${cadence}
          AND d.created_at > NOW() - (${CADENCE_MS[cadence]} || ' milliseconds')::interval
      )
    LIMIT 1000`;
  return rows.map((r) => ({ id: r.user_id, email: r.email, frequency: r.frequency }));
}

function buildDigestContent(
  items: Array<{ title: string; body: string | null; category: string; importance: number }>,
  cadence: string,
  itemCount: number,
): EmailContent {
  // Rank: importance desc, newest first. Group by category label.
  const sorted = [...items].sort((a, b) => b.importance - a.importance);
  const byCategory = new Map<string, string[]>();
  for (const item of sorted.slice(0, 20)) {
    const label = CATEGORY_LABELS[item.category] || 'Updates';
    const line = item.body ? `${item.title} — ${item.body}` : item.title;
    if (!byCategory.has(label)) byCategory.set(label, []);
    byCategory.get(label)!.push(line);
  }

  const blocks: EmailContent['blocks'] = [
    { type: 'heading', text: `Your ${cadence} Tirbeo summary` },
    { type: 'paragraph', text: `You have ${itemCount} new ${itemCount === 1 ? 'update' : 'updates'}.` },
  ];
  for (const [label, lines] of byCategory) {
    blocks.push({ type: 'heading', text: label });
    blocks.push({ type: 'list', items: lines.map((l) => l.slice(0, 300)) });
  }
  blocks.push({ type: 'button', label: 'View activity', url: '{{dashboardUrl}}' });
  return { subject: `Your ${cadence} Tirbeo summary (${itemCount})`, blocks };
}

export async function processDigests(cadence: 'daily' | 'weekly' | 'monthly'): Promise<{ digests: number }> {
  const users = await findDueUsers(cadence);
  let digests = 0;

  for (const user of users) {
    const items = await prisma.email_digest_items.findMany({
      where: { userId: user.id, consumed: false },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    if (items.length === 0) continue;

    const rangeStart = items.reduce(
      (min, i) => (i.createdAt < min ? i.createdAt : min),
      new Date(),
    );
    const now = new Date();

    const content = buildDigestContent(
      items.map((i) => ({
        title: i.title,
        body: i.body,
        category: i.category,
        importance: i.importance,
      })),
      cadence,
      items.length,
    );

    const { html } = renderEmail(content, {
      dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app',
    }, { footerNote: `${cadence} digest` });

    try {
      const result = await sendEmail(user.email, content.subject, html, {
        templateName: `brain:digest_${cadence}`,
        metadata: { digest: true, cadence, itemCount: items.length },
      });

      await prisma.$transaction([
        // Mark items consumed only when sent (or suppressed-as-success).
        prisma.email_digest_items.updateMany({
          where: { userId: user.id, id: { in: items.map((i) => i.id) } },
          data: { consumed: true },
        }),
        prisma.email_digests.create({
          data: {
            userId: user.id,
            cadence,
            itemCount: items.length,
            rangeStart,
            rangeEnd: now,
          },
        }),
      ]);
      if (result.success) digests++;
    } catch (e) {
      console.error('[EMAIL_BRAIN][DIGEST] send failed for user', user.id, e);
    }
  }
  return { digests };
}
