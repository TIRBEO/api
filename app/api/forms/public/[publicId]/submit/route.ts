import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';

// ─── POST /api/forms/public/:publicId/submit — Public form submission ────
// Paired with GET /api/forms/public/:publicId (the fill page's definition
// endpoint). Public by design — no auth, no CSRF (proxy-exempt). Accepts the
// app client's JSON body { answers: { [fieldId]: value } } and also the
// plain key/value shape used by embedded/link forms ({ fieldName: value }).
//
// Server-side validation re-implements the client rules for the core field
// types (required / email / minLength / maxLength / pattern) so the two can
// never drift on the security-critical checks. Turnstile is honored when the
// owner configured it; the in-app captcha flow is client-driven.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;

    const form = await prisma.form.findFirst({
      where: { OR: [{ id: publicId }, { slug: publicId }] },
      include: { fields: { orderBy: { order: 'asc' } } },
    });

    if (!form) {
      return NextResponse.json({ success: false, message: 'Form not found' }, { status: 404 });
    }
    if (form.status !== 'published') {
      return NextResponse.json({ success: false, message: 'This form is no longer accepting responses' }, { status: 403 });
    }

    let body: Record<string, any> = {};
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await req.json().catch(() => ({}));
    } else if (contentType.includes('form')) {
      const fd = await req.formData();
      fd.forEach((v, k) => { body[k] = typeof v === 'string' ? v : v.name; });
    } else {
      body = await req.json().catch(() => ({}));
    }

    // Honeypot: pretend success so bots don't learn they were caught.
    if (body.honeypot_field) {
      return NextResponse.json({ success: true, message: 'Submission received' });
    }

    // Turnstile (owner-configured spam protection).
    if (form.spamProtection === 'turnstile' && form.turnstileKey) {
      const token = body['cf-turnstile-response'] || body.turnstile_token || '';
      delete body['cf-turnstile-response'];
      delete body.turnstile_token;
      if (!token) {
        return NextResponse.json({ success: false, message: 'Captcha verification required' }, { status: 403 });
      }
      try {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY || '', response: token }),
        });
        const verifyData: { success?: boolean } = await verifyRes.json();
        if (!verifyData.success) {
          return NextResponse.json({ success: false, message: 'Captcha verification failed' }, { status: 403 });
        }
      } catch (e: any) {
        console.error('[FORMS PUBLIC] Turnstile error:', e?.message);
        return NextResponse.json({ success: false, message: 'Captcha verification failed' }, { status: 403 });
      }
    }

    // ─── Normalize answers: app client sends { answers: {...} } ───
    const raw = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : body;

    // ─── Validate server-side (mirrors the fill page's rules) ───
    const errors: Record<string, string> = {};
    const answers: Record<string, unknown> = {};

    for (const f of form.fields) {
      if (f.hidden || f.type === 'hidden') continue;

      let value = raw[f.id];
      // Link/embedded forms submit keyed by field name — accept both.
      if (value === undefined && raw[f.name] !== undefined) value = raw[f.name];
      if (value === undefined) value = null;

      const isEmpty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.filter(x => String(x).trim() !== '').length === 0);

      if (f.required && isEmpty) {
        errors[f.id] = `${f.label} is required`;
        continue;
      }
      if (isEmpty) continue;

      const str = Array.isArray(value) ? value.join(', ') : String(value);
      const v = (f.validation as any) || {};

      if (f.type === 'email' && !EMAIL_RE.test(str)) {
        errors[f.id] = 'Invalid email address';
      }
      if (v.minLength && str.length < v.minLength) errors[f.id] = `Minimum ${v.minLength} characters`;
      if (v.maxLength && str.length > v.maxLength) errors[f.id] = `Maximum ${v.maxLength} characters`;
      if (v.pattern && !new RegExp(v.pattern).test(str)) errors[f.id] = v.patternError || 'Invalid format';

      if (!errors[f.id]) answers[f.id] = Array.isArray(value) ? value : str;
    }

    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ success: false, message: 'Validation failed', errors }, { status: 422 });
    }

    // Respect the owner's storage preference (pass-through forms still notify).
    if (!form.storeResponses) {
      return NextResponse.json({ success: true, message: 'Submission received' });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || '';
    const userAgent = req.headers.get('user-agent') || '';
    const referrer = req.headers.get('referer') || '';

    const submission = await prisma.formSubmission.create({
      data: {
        formId: form.id,
        data: answers as Prisma.InputJsonValue,
        metadata: { ip, userAgent, referrer } as Prisma.InputJsonValue,
        source: referrer || 'public',
        ipAddress: ip,
        userAgent,
        referrer,
      },
    });

    // Stats + analytics + realtime notifications (non-blocking, same as the
    // legacy /api/forms/:id/submit handler).
    prisma.form.update({
      where: { id: form.id },
      data: { submissionCount: { increment: 1 }, lastSubmissionAt: new Date() },
    }).catch(() => {});

    const today = new Date(); today.setHours(0, 0, 0, 0);
    prisma.formAnalytic.upsert({
      where: { formId_date: { formId: form.id, date: today } },
      create: { formId: form.id, date: today, submissions: 1 },
      update: { submissions: { increment: 1 } },
    }).catch(() => {});

    createOwnerNotification(form.userId, form.name, form.id).catch(() => {});

    return NextResponse.json({ success: true, message: 'Submission received', submissionId: submission.id });
  } catch (error: any) {
    console.error('[FORMS PUBLIC] submit error:', error?.message);
    return NextResponse.json({ success: false, message: 'Failed to submit response' }, { status: 500 });
  }
}

// ─── Owner notification (kept local to avoid the heavier import graph) ───
async function createOwnerNotification(userId: string, formName: string, formId: string) {
  try {
    const { createNotification } = await import('@/features/notifications/notifications');
    await createNotification({
      userId,
      type: 'forms',
      title: `New submission: ${formName}`,
      body: `A new response was submitted to "${formName}".`,
      link: `/forms/${formId}`,
    });
  } catch {
    // Best-effort — submission already stored.
  }
}
