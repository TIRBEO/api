import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';
import { BRAND_CONFIG_KEY } from '@/features/branding/branding';

/* One place an installation changes how it describes itself.
 *
 * This door writes exactly one thing today: the branding record that
 * `getBranding()` reads for mail headers, security alerts and the public
 * `/api/public/branding` endpoint. It is here because those strings used to be
 * environment variables and a deploy, which is a long way round for renaming a
 * product's own tagline.
 *
 * It is deliberately not a general key-value editor. A settings screen that
 * accepts any key is a form that can be filled with something no code reads —
 * the "Personalization" toggle with no recommendation path, in table form. So
 * the list below is the whole surface, and a field is on it only because a
 * named consumer already reads it. To add a setting, add the reader first; the
 * `readBy` line is the review check that makes that order visible.
 */

type SettingField = {
  key: string;
  label: string;
  /** The code that acts on this value. Empty is not allowed, and this line is
   *  why: a field nobody reads belongs in the console's `UNBACKED` list, not in
   *  a form that implies saving it changes something. */
  readBy: string;
  max: number;
  hint: string;
};

const SECTIONS: Array<{ key: string; configKey: string; label: string; description: string; fields: SettingField[] }> = [
  {
    key: 'branding',
    configKey: BRAND_CONFIG_KEY,
    label: 'Organization',
    description: 'The name, words and address the platform sends as itself',
    fields: [
      { key: 'brandName', label: 'Product name', readBy: 'features/email/email.ts, features/security/security.ts', max: 80, hint: 'Used in mail subjects and the security alerts staff receive.' },
      { key: 'brandTagline', label: 'Tagline', readBy: 'app/api/public/branding/route.ts', max: 160, hint: 'The line under the name, wherever the product introduces itself.' },
      { key: 'emailFromName', label: 'Mail display name', readBy: 'features/email/email.ts', max: 80, hint: 'What a mailbox shows as the sender. The address it comes from is set on the senders screen.' },
      { key: 'emailFromAddress', label: 'Mail address', readBy: 'features/email/email.ts', max: 254, hint: 'Must be a domain the sending provider has verified, or the provider rewrites it.' },
      { key: 'logoUrl', label: 'Logo', readBy: 'app/api/public/app-config/route.ts', max: 500, hint: 'A full URL, or a path this API serves. Empty uses the built-in logo.' },
    ],
  },
];

const FIELD_KEYS = new Set(SECTIONS.flatMap((section) => section.fields.map((field) => field.key)));

// Keys are checked against the declared fields below rather than by the schema,
// because the schema cannot name a set that is derived from data — and a setting
// that validated only in the schema would still need this list to explain itself
// on a screen.
const patchSchema = z.object({
  branding: z.record(z.string(), z.string().trim().max(500)).optional(),
});

function blankToNull(value: string) {
  return value.trim() ? value.trim() : null;
}

/** What is stored and what it would fall back to, so the screen can say
 *  "inherited from the environment" beside a field nobody has set here. A
 *  settings page that shows an empty box for a value that is actually live is
 *  how an operator ends up typing the same thing twice. */
async function readSection(section: (typeof SECTIONS)[number]) {
  const row = await prisma.appConfig.findUnique({ where: { key: section.configKey }, select: { value: true, updatedAt: true } });
  const stored = row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
    ? row.value as Record<string, unknown>
    : {};
  return {
    stored,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

export async function getSettings(request: NextRequest) {
  const session = await requirePermission(request, 'settings.read');
  if (session instanceof NextResponse) return session;

  const branding = await readSection(SECTIONS[0]);
  const effective = await import('@/features/branding/branding').then((m) => m.getBranding());
  const fallbacks: Record<string, string> = { ...effective };

  return NextResponse.json({
    sections: SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      fields: section.fields.map((field) => ({
        key: field.key,
        label: field.label,
        hint: field.hint,
        max: field.max,
        readBy: field.readBy,
        value: typeof branding.stored[field.key] === 'string' ? branding.stored[field.key] : null,
        // The answer `getBranding()` would give with nothing stored, so the
        // screen can show what an empty box actually means.
        fallback: fallbacks[field.key] ?? null,
      })),
    })),
    updatedAt: branding.updatedAt,
    // Not a screen's guess: the console renders this so an operator can see
    // which settings are enforced somewhere and which are stored text.
    directoryNote: 'Directory rules — signup, naming, required profile fields — are not here: no code path reads a directory setting, so there is nothing to change yet.',
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function patchSettings(request: NextRequest) {
  const session = await requirePermission(request, 'settings.manage');
  if (session instanceof NextResponse) return session;

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success || !parsed.data.branding) {
    return NextResponse.json({ error: 'Send { branding: { … } } with the fields to change.' }, { status: 400 });
  }
  const incoming = parsed.data.branding as Record<string, string>;
  const unknown = Object.keys(incoming).filter((key) => !FIELD_KEYS.has(key));
  if (unknown.length) {
    return NextResponse.json({ error: `Not a setting this platform reads: ${unknown.join(', ')}` }, { status: 400 });
  }

  const tooLong = SECTIONS[0].fields
    .filter((field) => (incoming[field.key]?.length ?? 0) > field.max)
    .map((field) => field.label);
  if (tooLong.length) {
    return NextResponse.json({ error: `Too long: ${tooLong.join(', ')}.`, limit: tooLong.length }, { status: 400 });
  }

  if (incoming.emailFromAddress && !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(incoming.emailFromAddress.trim())) {
    return NextResponse.json({ error: 'That is not a mail address.' }, { status: 400 });
  }

  const section = SECTIONS[0];
  const changed: string[] = [];

  // Read-modify-write, inside one transaction. Two operators saving different
  // halves of the same record would otherwise be two writes of one whole blob,
  // and the later one would silently delete the earlier change.
  await prisma.$transaction(async (tx) => {
    const row = await tx.appConfig.findUnique({ where: { key: section.configKey }, select: { value: true } });
    const current = row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? row.value as Record<string, unknown>
      : {};

    // Only strings go in and only strings come out. This key has exactly one
    // writer, so a value of another type in the stored row is already inert to
    // every reader — carrying it forward to "preserve" it would preserve a row
    // no screen can render and no code acts on.
    const next: Record<string, string> = {};
    for (const [key, raw] of Object.entries(current)) {
      if (typeof raw === 'string' && raw.trim()) next[key] = raw;
    }
    for (const [key, raw] of Object.entries(incoming)) {
      const value = blankToNull(raw);
      const before = typeof current[key] === 'string' ? current[key] : null;
      if (value === before) continue;
      if (value === null) delete next[key];
      else next[key] = value;
      changed.push(key);
    }

    await tx.appConfig.upsert({
      where: { key: section.configKey },
      create: { key: section.configKey, value: next, description: 'How this installation describes itself' },
      update: { value: next },
    });
  });

  if (changed.length) {
    // The field names, never the old values: a product name in an audit row is
    // harmless, but the same column would happily hold whatever an operator
    // typed into a field that turns out to be a secret.
    await createAuditEvent({
      actorId: session.userId,
      action: 'admin.settings_updated',
      severity: 'warning',
      targetType: 'app_config',
      targetId: section.configKey,
      metadata: { fields: changed, actorEmail: session.email },
      ip: clientIpOrUnknown(request.headers),
      userAgent: request.headers.get('user-agent'),
    });
  }

  const effective = await import('@/features/branding/branding').then((m) => m.getBranding());
  return NextResponse.json({ ok: true, changed, effective });
}
