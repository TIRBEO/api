import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { sendEmail, sendTemplateEmail, renderTemplate, escapeHtml } from '@/lib/email';

// POST /api/forms/:id/submit — Public form submission
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let form = await prisma.form.findUnique({ where: { id }, include: { fields: true } });
    if (!form) form = await prisma.form.findUnique({ where: { slug: id }, include: { fields: true } });
    if (!form) return NextResponse.json({ success: false, message: 'Form not found' }, { status: 404 });

    if (form.status !== 'published') {
      return NextResponse.json({ success: false, message: 'This form is not accepting submissions' }, { status: 403 });
    }

    let submissionData: Record<string, any> = {};
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      submissionData = await req.json();
    } else if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      formData.forEach((value, key) => {
        if (key !== 'access_key' && key !== 'honeypot_field') submissionData[key] = String(value);
      });
    } else {
      submissionData = await req.json();
    }

    // Honeypot
    if (form.honeypot && submissionData.honeypot_field) {
      return NextResponse.json({ success: true, message: 'Submission received', submission_id: 'fake' });
    }
    delete submissionData.honeypot_field;

    // Turnstile verification
    if (form.spamProtection === 'turnstile' && form.turnstileKey) {
      const turnstileToken = submissionData['cf-turnstile-response'] || submissionData.turnstile_token;
      delete submissionData['cf-turnstile-response'];
      delete submissionData.turnstile_token;

      if (!turnstileToken) {
        return NextResponse.json({ success: false, message: 'Captcha verification required' }, { status: 403 });
      }

      try {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY || '', response: turnstileToken }),
        });
        const verifyData: { success?: boolean } = await verifyRes.json();
        if (!verifyData.success) {
          return NextResponse.json({ success: false, message: 'Captcha verification failed' }, { status: 403 });
        }
      } catch (e: any) {
        console.error('[FORMS] Turnstile verification error:', e?.message);
        return NextResponse.json({ success: false, message: 'Captcha verification failed' }, { status: 403 });
      }
    }

    // Validate
    const errors: Record<string, string> = {};
    for (const field of form.fields) {
      if (field.hidden || field.type === 'hidden') continue;
      const value = submissionData[field.name];
      if (field.required && (value === undefined || value === null || String(value).trim() === '')) {
        errors[field.name] = `${field.label} is required`;
      }
      if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
        errors[field.name] = 'Invalid email address';
      }
      if (value && field.validation) {
        const v = field.validation as any;
        if (v.minLength && String(value).length < v.minLength) errors[field.name] = `Minimum ${v.minLength} characters`;
        if (v.maxLength && String(value).length > v.maxLength) errors[field.name] = `Maximum ${v.maxLength} characters`;
        if (v.pattern && !new RegExp(v.pattern).test(String(value))) errors[field.name] = v.patternError || 'Invalid format';
      }
    }
    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ success: false, message: 'Validation failed', errors }, { status: 422 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || '';
    const userAgent = req.headers.get('user-agent') || '';
    const referrer = req.headers.get('referer') || '';
    const source = submissionData._source || referrer || '';
    delete submissionData._source;

    const submission = await prisma.formSubmission.create({
      data: {
        formId: form.id,
        data: submissionData,
        metadata: { ip, userAgent, referrer, source },
        source,
        ipAddress: ip,
        userAgent,
        referrer,
      },
    });

    // Update stats (non-blocking)
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

    // Send auto-response email to submitter
    if (form.autoReply) {
      try {
        // Find the submitter's email from the submission data
        const emailField = form.fields.find((f: any) => f.type === 'email');
        const submitterEmail = emailField ? submissionData[emailField.name] : null;

        if (submitterEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(submitterEmail))) {
          // Build template variables from submission data
          const vars: Record<string, string> = {
            submission_id: submission.id,
            form_name: form.name,
            submitted_at: new Date().toLocaleString(),
          };

          // Add all field values as template variables
          for (const field of form.fields) {
            const val = submissionData[field.name];
            if (val !== undefined && val !== null) {
              vars[field.name] = String(val);
              vars[field.label.toLowerCase().replace(/\s+/g, '_')] = String(val);
            }
          }

          // Shared row builder — one styled <p> per answered field
          const rowsHtml = form.fields
            .filter((f: any) => f.type !== 'hidden' && !f.hidden)
            .map((f: any) => {
              const val = submissionData[f.name];
              return val ? `<p style="margin:0 0 8px;font-size:14px;color:#9a9a9a;line-height:22px;"><strong style="color:#ffffff;">${escapeHtml(f.label)}:</strong> ${escapeHtml(String(val))}</p>` : '';
            })
            .filter(Boolean).join('');

          const submittedAtStr = new Date().toLocaleString();

          if (form.autoReplySubject || form.autoReplyBody) {
            // Custom auto-reply copy supplied by the form owner
            const subject = renderTemplate(form.autoReplySubject || `Thanks for submitting to ${form.name}`, vars);
            const body = renderTemplate(form.autoReplyBody || '', vars);
            sendEmail(submitterEmail, subject, body, {
              templateName: 'form_auto_reply',
            }).catch((e: any) => console.error('[FORMS] Auto-reply email failed:', e?.message));
          } else {
            // Default themed auto-reply
            sendTemplateEmail(submitterEmail, 'form_auto_reply', {
              formTitle: form.name,
              fieldsRows: rowsHtml,
              submissionId: submission.id,
              submittedAt: submittedAtStr,
            }, { rawVars: ['fieldsRows'] })
              .catch((e: any) => console.error('[FORMS] Auto-reply email failed:', e?.message));
          }
        }
      } catch (e: any) {
        console.error('[FORMS] Auto-reply error:', e?.message);
      }
    }

    // Send notification email to form owner(s)
    const notifyEmails = form.notificationEmails || [];
    if (notifyEmails.length > 0) {
      try {
        const vars: Record<string, string> = {
          submission_id: submission.id,
          form_name: form.name,
          submitted_at: new Date().toLocaleString(),
          ip: ip || 'Unknown',
          user_agent: userAgent || 'Unknown',
        };
        for (const field of form.fields) {
          const val = submissionData[field.name];
          if (val !== undefined && val !== null) {
            vars[field.name] = String(val);
            vars[field.label.toLowerCase().replace(/\s+/g, '_')] = String(val);
          }
        }

        const subject = form.emailSubject
          ? renderTemplate(form.emailSubject, vars)
          : `New submission: ${form.name}`;

        const fieldRows = form.fields
          .filter((f: any) => f.type !== 'hidden' && !f.hidden)
          .map((f: any) => {
            const val = submissionData[f.name];
            return val ? `<p style="margin:0 0 8px;font-size:14px;color:#9a9a9a;line-height:22px;"><strong style="color:#ffffff;">${escapeHtml(f.label)}:</strong> ${escapeHtml(String(val))}</p>` : '';
          }).filter(Boolean).join('');

        // Send to all notification recipients via the themed template
        for (const email of notifyEmails) {
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            sendTemplateEmail(email, 'form_submission_notification', {
              formTitle: form.name,
              fieldRows: fieldRows,
              submissionId: submission.id,
              submittedAt: new Date().toLocaleString(),
              ip: ip || 'Unknown',
              viewUrl: `${process.env.NEXT_PUBLIC_DASHBOARD_URL || 'http://localhost:3004'}/forms/${form.id}`,
            }, {
              rawVars: ['fieldRows'],
              replyTo: form.replyToEmail || undefined,
            }).catch((e: any) => console.error('[FORMS] Notification email failed:', e?.message));
          }
        }
      } catch (e: any) {
        console.error('[FORMS] Notification error:', e?.message);
      }
    }

    return NextResponse.json({
      success: true,
      message: form.successMessage || 'Submission received',
      submission_id: submission.id,
    });
  } catch (error: any) {
    console.error('[FORMS] Submit error:', error?.message);
    return NextResponse.json({ success: false, message: 'Failed to process submission' }, { status: 500 });
  }
}

// GET /api/forms/:id/submit — Get form definition for embed
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let form = await prisma.form.findUnique({ where: { id }, include: { fields: { orderBy: { order: 'asc' } } } });
    if (!form) form = await prisma.form.findUnique({ where: { slug: id }, include: { fields: { orderBy: { order: 'asc' } } } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    // Track view (non-blocking)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    prisma.formAnalytic.upsert({
      where: { formId_date: { formId: form.id, date: today } },
      create: { formId: form.id, date: today, views: 1, starts: 1 },
      update: { views: { increment: 1 }, starts: { increment: 1 } },
    }).catch(() => {});

    return NextResponse.json({
      id: form.id,
      name: form.name,
      description: form.description,
      fields: form.fields.filter(f => !f.hidden && f.type !== 'hidden').map(f => ({
        label: f.label, name: f.name, type: f.type, required: f.required,
        placeholder: f.placeholder, helpText: f.helpText, options: f.options,
      })),
      settings: {
        layout: form.layout, width: form.width, alignment: form.alignment,
        labelPosition: form.labelPosition, theme: form.theme,
        successMessage: form.successMessage, headless: form.headless, customCss: form.customCss,
      },
    });
  } catch (error: any) {
    console.error('[FORMS] GET/submit error:', error?.message);
    return NextResponse.json({ error: 'Failed to load form' }, { status: 500 });
  }
}
