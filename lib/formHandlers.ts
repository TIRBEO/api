import { prisma } from './db/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from './session';
import { sendTemplateEmail, escapeHtml } from './email';
import { sanitizeInput } from './security';
import { getCaptchaSettings, assertCaptchaSatisfied } from './captcha/service';

const createFormSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  thankYouMessage: z.string().optional(),
  allowCollaboratorEdits: z.boolean().optional(),
});

const updateFormSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived', 'closed']).optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  loginRequired: z.boolean().optional(),
  captchaEnabled: z.boolean().optional(),
  rateLimit: z.number().int().optional(),
  limitPerUser: z.number().int().optional(),
  responseLimit: z.number().int().optional(),
  expiresAt: z.string().datetime().optional(),
  scheduledAt: z.string().datetime().optional(),
  closeAt: z.string().datetime().optional(),
  openMessage: z.string().optional(),
  thankYouMessage: z.string().optional(),
  allowCollaboratorEdits: z.boolean().optional(),
  closeMessage: z.string().optional(),
  redirectUrl: z.string().optional(),
  collectEmail: z.boolean().optional(),
  confirmBeforeSubmit: z.boolean().optional(),
  showProgressBar: z.boolean().optional(),
  shuffleFields: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  color: z.string().optional(),
  fontSize: z.string().optional(),
  layout: z.string().optional(),
  coverImage: z.string().optional(),
  slug: z.string().optional(),
  customDomain: z.string().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  fields: z.array(z.object({
    id: z.string(),
    type: z.string(),
    label: z.string(),
    required: z.boolean().optional(),
    order: z.number().int(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      value: z.string(),
    })).optional(),
  })).optional(),
});

function generatePublicId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const session = await getSession(req);
  return session?.userId || null;
}

export async function listForms(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const search = searchParams.get('search');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const skip = (page - 1) * limit;

  const where: any = {
    OR: [
      { ownerId: userId },
      { collaborators: { some: { userId } } },
    ],
  };
  if (status) where.status = status;
  if (search) where.title = { contains: search, mode: 'insensitive' };

  const [forms, total] = await Promise.all([
    prisma.form.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { fields: true } } },
    }),
    prisma.form.count({ where }),
  ]);

  return NextResponse.json({ forms, total, page, limit });
}

export async function createForm(req: NextRequest) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const flag = await prisma.featureFlag.findUnique({ where: { key: 'forms.userCreation.enabled' } });
   if (!flag?.isActive) {
     return NextResponse.json({ error: { code: 'FEATURE_DISABLED', message: 'User-created forms are not available yet. We\'re preparing this feature for 2027.' } }, { status: 403 });
   }

   const body = await req.json();
  const parsed = createFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

const form = await prisma.form.create({
     data: {
       title: parsed.data.title,
       description: parsed.data.description,
       ownerId: userId,
       publicId: generatePublicId(),
       status: 'draft',
       thankYouMessage: parsed.data.thankYouMessage,
       allowCollaboratorEdits: parsed.data.allowCollaboratorEdits ?? false,
     },
   });

  return NextResponse.json(form, { status: 201 });
}

export async function getForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId } } },
      ],
    },
    include: {
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' } },
      collaborators: { include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } } },
      versions: { orderBy: { version: 'desc' }, take: 1 },
    },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  return NextResponse.json(form);
}

export async function updateForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId, role: { in: ['editor', 'admin'] } } } },
      ],
    },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const body = await req.json();
  const parsed = updateFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

  const { fields, ...formData } = parsed.data;

  if (fields) {
    await prisma.formField.deleteMany({ where: { formId } });
    await prisma.formFieldOption.deleteMany({ where: { field: { formId } } });
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const { options, ...fieldData } = f;
      const created = await prisma.formField.create({
        data: {
          formId,
          type: fieldData.type,
          label: fieldData.label,
          required: fieldData.required || false,
          order: fieldData.order,
          placeholder: fieldData.placeholder,
        },
      });
      if (options && options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: options.map((o, oi) => ({
            fieldId: created.id,
            label: o.label,
            value: o.value,
            order: oi,
          })),
        });
      }
    }
  }

  const updated = await prisma.form.update({
    where: { id: formId },
    data: {
      ...(formData.title !== undefined && { title: formData.title }),
      ...(formData.description !== undefined && { description: formData.description }),
      ...(formData.status !== undefined && { status: formData.status }),
      ...(formData.thankYouMessage !== undefined && { thankYouMessage: formData.thankYouMessage }),
      ...(formData.allowCollaboratorEdits !== undefined && { allowCollaboratorEdits: formData.allowCollaboratorEdits }),
    },
  });

  await prisma.formVersion.create({
    data: {
      formId,
      version: (form.versions?.[0]?.version || 0) + 1,
      data: updated,
      createdBy: userId,
    },
  });

  return NextResponse.json(updated);
}

export async function deleteForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  await prisma.form.delete({ where: { id: formId } });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    sendTemplateEmail(owner.email, 'form_deleted', {
      formTitle: form.title || 'Untitled Form',
    }).catch(() => {});
  }

  return NextResponse.json({ success: true }, { status: 200 });
}

export async function publishForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId, role: { in: ['editor', 'admin'] } } } },
      ],
    },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status: 'published', publishedAt: new Date() },
  });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    sendTemplateEmail(owner.email, 'form_published', {
      formTitle: form.title || 'Untitled Form',
      formUrl: `https://forms.tirbeo.app/f/${form.publicId}`,
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function archiveForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status: 'archived' },
  });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    sendTemplateEmail(owner.email, 'form_archived', {
      formTitle: form.title || 'Untitled Form',
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function getPublicForm(req: NextRequest, publicId: string) {
  const form = await prisma.form.findUnique({
    where: { publicId },
    include: {
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' }, include: { fields: { orderBy: { order: 'asc' } } } },
    },
  });

  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }

  await prisma.form.update({
    where: { id: form.id },
    data: { viewCount: { increment: 1 } },
  });

  return NextResponse.json(form);
}

export async function submitResponse(req: NextRequest, publicId: string) {
  const form = await prisma.form.findUnique({
    where: { publicId },
    include: { fields: true },
  });

  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const session = await getSession(req);
  const userId = session?.userId || null;

  const body = await req.json();

  if (form.captchaEnabled) {
    const settings = await getCaptchaSettings();
    if (settings.enabled) {
      const captchaRayId = body.captchaRayId;
      if (!captchaRayId) {
        return NextResponse.json({ error: { code: 'CAPTCHA_REQUIRED', message: 'CAPTCHA verification is required' } }, { status: 403 });
      }
      const check = await assertCaptchaSatisfied({
        rayId: captchaRayId,
        sessionId: session?.sessionId || 'anonymous',
        ipAddress: ip,
        userAgent,
        fingerprint: req.headers.get('x-device-fingerprint') || '',
        requiredDifficulty: 'medium',
      });
      if (!check.ok) {
        return NextResponse.json({ error: { code: 'CAPTCHA_FAILED', message: check.error || 'CAPTCHA verification failed' } }, { status: 403 });
      }
    }
  }

  const cleanAnswers = Object.entries(body.answers || {}).map(([fieldId, value]) => ({
    fieldId,
    value: typeof value === 'string' ? sanitizeInput(value, 20000) : value,
  }));

  const response = await prisma.response.create({
    data: {
      formId: form.id,
      respondentEmail: body.respondentEmail ? sanitizeInput(String(body.respondentEmail), 254) : undefined,
      respondentName: body.respondentName ? sanitizeInput(String(body.respondentName), 200) : undefined,
      ipAddress: ip,
      userAgent: userAgent,
      status: 'completed',
      completedAt: new Date(),
      answers: { create: cleanAnswers as any },
    },
  });

  await prisma.form.update({
    where: { id: form.id },
    data: {
      responseCount: { increment: 1 },
      lastSubmissionAt: new Date(),
      submissionCountToday: { increment: 1 },
    },
  });

  try {
    const owner = await prisma.user.findUnique({ where: { id: form.ownerId } });
    if (owner?.email) {
      const answersHtml = Object.entries(body.answers || {})
        .map(([fieldId, value]) => {
          const field = form.fields.find(f => f.id === fieldId);
          const label = escapeHtml(field?.label || fieldId);
          const val = escapeHtml(Array.isArray(value) ? value.join(', ') : String(value ?? ''));
          return `<div class="answer-item"><div class="answer-label">${label}</div><div class="answer-value">${val}</div></div>`;
        })
        .join('');

      await sendTemplateEmail(owner.email, 'form_response', {
        formTitle: form.title,
        respondentName: body.respondentName || 'Anonymous',
        respondentEmail: body.respondentEmail || 'N/A',
        submittedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        responseId: response.id,
        answers: answersHtml,
        adminUrl: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.publicId}/responses`,
      });
    }
  } catch (e: any) {
    console.error('[EMAIL] Failed to send form response notification:', e?.message);
  }

  if (body.respondentEmail) {
    try {
      await sendTemplateEmail(body.respondentEmail, 'form_submission_confirmation', {
        formTitle: form.title,
        respondentName: body.respondentName || 'There',
      });
    } catch (e: any) {
      console.error('[EMAIL] Failed to send submission confirmation:', e?.message);
    }
  }

  return NextResponse.json({ id: response.id, message: form.thankYouMessage || 'Thank you!' }, { status: 201 });
}

export async function listResponses(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const skip = (page - 1) * limit;
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  const [responses, total] = await Promise.all([
    prisma.response.findMany({
      where: { formId },
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      include: { answers: { include: { field: true } } },
    }),
    prisma.response.count({ where: { formId } }),
  ]);

  return NextResponse.json({ responses, total, page, limit });
}

export async function getResponse(req: NextRequest, formId: string, responseId: string) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const form = await prisma.form.findUnique({ where: { id: formId } });
   if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

   const isOwner = form.ownerId === userId;
   const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
     where: { formId, userId, role: { in: ['editor', 'admin'] } },
   });

   if (!isOwner && !isCollaborator) {
     return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
   }

   const response = await prisma.response.findFirst({
     where: { id: responseId, formId },
     include: {
       answers: { include: { field: { include: { options: true } } } },
       notes: { orderBy: { createdAt: 'desc' } },
     },
   });

   if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });
   return NextResponse.json(response);
 }

export async function deleteResponse(req: NextRequest, formId: string, responseId: string) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const form = await prisma.form.findUnique({ where: { id: formId } });
   if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

   const isOwner = form.ownerId === userId;
   const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
     where: { formId, userId, role: { in: ['editor', 'admin'] } },
   });

   if (!isOwner && !isCollaborator) {
     return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
   }

   const response = await prisma.response.findFirst({
     where: { id: responseId, formId },
   });

   if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });

   await prisma.response.delete({ where: { id: responseId } });

   await prisma.form.update({
     where: { id: formId },
     data: { responseCount: { decrement: 1 } },
   });

   const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
   if (owner?.email) {
     sendTemplateEmail(owner.email, 'response_deleted', {
       formTitle: form.title || 'Untitled Form',
       responseId: responseId,
       deletedAt: new Date().toLocaleString(),
     }).catch(() => {});
   }

 return NextResponse.json({ success: true });
  }

  export async function updateResponse(req: NextRequest, formId: string, responseId: string) {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

    const form = await prisma.form.findUnique({ where: { id: formId } });
    if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

    const isOwner = form.ownerId === userId;
    const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
      where: { formId, userId, role: { in: ['editor', 'admin'] } },
    });

    if (!isOwner && !isCollaborator) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
    }

    const response = await prisma.response.findFirst({
      where: { id: responseId, formId },
    });

    if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });

    // Only allow editing if the respondent is the owner or the form allows collaborator edits
    const canEdit = isOwner || form.allowCollaboratorEdits;
    if (!canEdit && response.respondentEmail) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Respondents can only edit their own responses if the form owner allows it' } }, { status: 403 });
    }

    const body = await req.json();
    const { answers, status, notes } = body;

    const updated = await prisma.response.update({
      where: { id: responseId },
      data: {
        ...(answers && { answers: { deleteMany: {}, create: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value: value as any })) } }),
        ...(status && { status }),
        ...(notes && { notes: { create: notes.map((n: any) => ({ userId: n.userId, content: n.content })) } }),
      },
      include: { answers: { include: { field: true } } },
    });

    const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
    if (owner?.email) {
      sendTemplateEmail(owner.email, 'response_updated', {
        formTitle: form.title || 'Untitled Form',
        responseId: responseId,
        updatedAt: new Date().toLocaleString(),
      }).catch(() => {});
    }

    return NextResponse.json(updated);
  }

  export async function getFormAnalytics(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const [form, responses, totalResponses] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: true } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, duration: true, status: true },
    }),
    prisma.response.count({ where: { formId } }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const submissionsByDay = responses.reduce((acc: Record<string, number>, r) => {
    const day = r.createdAt.toISOString().slice(0, 10);
    acc[day] = (acc[day] || 0) + 1;
    return acc;
  }, {});

  const avgDuration = responses.reduce((sum, r) => sum + (r.duration || 0), 0) / (responses.length || 1);

  const completionRate = form.viewCount > 0 ? Math.round((totalResponses / form.viewCount) * 100) : 0;

  const fieldBreakdown = form.fields.map(field => {
    const fieldResponses = responses.filter(() => true).length;
    return {
      fieldId: field.id,
      fieldLabel: field.label,
      fieldType: field.type,
      responses: fieldResponses,
      skipped: 0,
    };
  });

  return NextResponse.json({
    totalResponses,
    totalViews: form.viewCount,
    completionRate,
    avgDuration: Math.round(avgDuration),
    submissionsByDay,
    lastSubmissionAt: form.lastSubmissionAt,
    fieldCount: form.fields.length,
    fieldBreakdown,
  });
}

export async function listCollaborators(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const collaborators = await prisma.formCollaborator.findMany({
    where: { formId },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });

  const form = await prisma.form.findUnique({
    where: { id: formId },
    select: { ownerId: true },
  });

  return NextResponse.json({ collaborators, ownerId: form?.ownerId });
}

export async function addCollaborator(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body = await req.json();
  const { email, role = 'editor' } = body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, { status: 404 });

  const existing = await prisma.formCollaborator.findUnique({
    where: { formId_userId: { formId, userId: user.id } },
  });

  if (existing) return NextResponse.json({ error: { code: 'CONFLICT', message: 'User is already a collaborator' } }, { status: 409 });

  const collaborator = await prisma.formCollaborator.create({
    data: { formId, userId: user.id, role },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });

  return NextResponse.json(collaborator, { status: 201 });
}

export async function removeCollaborator(req: NextRequest, formId: string, collaboratorId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  await prisma.formCollaborator.delete({
    where: { id: collaboratorId, formId },
  });

  return NextResponse.json({ success: true });
}

export async function listVersions(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const versions = await prisma.formVersion.findMany({
    where: { formId },
    orderBy: { version: 'desc' },
    take: 50,
  });

  return NextResponse.json({ versions });
}

export async function restoreVersion(req: NextRequest, formId: string, versionId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const version = await prisma.formVersion.findFirst({
    where: { id: versionId, formId },
  });

  if (!version) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Version not found' } }, { status: 404 });

  const data = version.data as any;
  await prisma.form.update({
    where: { id: formId },
    data: {
      title: data.title,
      description: data.description,
    },
  });

  return NextResponse.json({ success: true, message: `Restored to version ${version.version}` });
}

export async function getFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const [form, notifications] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId } }),
    prisma.formNotification.findUnique({ where: { formId } }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  return NextResponse.json({ form, notifications });
}

export async function updateFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body = await req.json();
  const { notifications, ...formSettings } = body;

  if (Object.keys(formSettings).length > 0) {
    await prisma.form.update({ where: { id: formId }, data: formSettings });
  }

  if (notifications) {
    await prisma.formNotification.upsert({
      where: { formId },
      update: notifications,
      create: { formId, ...notifications },
    });
  }

  return NextResponse.json({ success: true });
}

export async function publicDirectory(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');

  const where: any = { status: 'published' };
  if (search) where.title = { contains: search, mode: 'insensitive' };

  const [forms, total] = await Promise.all([
    prisma.form.findMany({
      where,
      orderBy: { responseCount: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        description: true,
        publicId: true,
        responseCount: true,
        createdAt: true,
        _count: { select: { fields: true } },
      },
    }),
    prisma.form.count({ where }),
  ]);

  return NextResponse.json({ forms, total, page, limit });
}

export async function exportResponses(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const format = new URL(req.url).searchParams.get('format') || 'csv';

  const [form, responses] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { orderBy: { order: 'asc' } } } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { createdAt: 'desc' },
      include: { answers: { include: { field: true } } },
    }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  if (format === 'csv') {
    const headers = ['Submitted At', 'Respondent', ...form.fields.map(f => f.label)];
    const rows = responses.map(r => {
      const answerMap: Record<string, string> = {};
      r.answers.forEach(a => { answerMap[a.fieldId] = JSON.stringify(a.value); });
      return [
        r.createdAt.toISOString(),
        r.respondentEmail || '',
        ...form.fields.map(f => answerMap[f.id] || ''),
      ];
    });

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(','))].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${form.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`,
      },
    });
  }

  return NextResponse.json({ responses, fields: form.fields });
}
