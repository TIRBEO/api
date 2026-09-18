import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';

// ─── Public form wire types ─────────────────────────────────────────────
// Mirrors the shapes the forms app's PublicFormFill component consumes
// (apps/forms/app/components/public-form.tsx) and @tirbeo/types FormField.

interface PublicFieldOption {
  label: string;
  value: string;
}

interface PublicField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  order: number;
  placeholder?: string;
  description?: string;
  options?: PublicFieldOption[];
  config?: Record<string, unknown>;
}

// ─── GET /api/forms/public/:publicId — Public form definition ────────────
// Serves the fill page. Public by design: no auth, no CSRF (proxy-exempt),
// never leaks owner info or unpublished forms. Addressed by the form's id
// (publicId is the id — see POST /api/forms which generates UUID ids); the
// slug is accepted as a fallback so /f/<slug> links keep working.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;

    const form = await prisma.form.findFirst({
      where: { OR: [{ id: publicId }, { slug: publicId }] },
      include: { fields: { orderBy: { order: 'asc' } } },
    });

    if (!form) {
      return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    }

    const closed = form.status !== 'published';

    const fields: PublicField[] = form.fields
      .filter(f => !f.hidden && f.type !== 'hidden')
      .map(f => {
        const options = Array.isArray(f.options) ? (f.options as unknown[]) : undefined;
        return {
          id: f.id,
          type: f.type,
          label: f.label,
          required: f.required,
          order: f.order,
          placeholder: f.placeholder || undefined,
          description: f.helpText || undefined,
          options: options?.length
            ? options.map(o =>
                typeof o === 'string'
                  ? { label: o, value: o }
                  : { label: String((o as any)?.label ?? (o as any)?.value ?? ''), value: String((o as any)?.value ?? (o as any)?.label ?? '') },
              )
            : undefined,
          config: (f.validation as Record<string, unknown>) || undefined,
        };
      });

    return NextResponse.json({
      id: form.id,
      title: form.name,
      description: form.description || undefined,
      status: form.status,
      fields,
      confirmBeforeSubmit: false,
      showProgressBar: false,
      captchaEnabled: false,
      requireName: false,
      loginRequired: false,
      responseLimit: null,
      thankYouMessage: form.successMessage || undefined,
      closed,
      closeMessage: closed ? 'This form is no longer accepting responses.' : undefined,
      source: 'user' as const,
    });
  } catch (error: any) {
    console.error('[FORMS PUBLIC] GET error:', error?.message);
    return NextResponse.json({ error: 'Failed to load form' }, { status: 500 });
  }
}
