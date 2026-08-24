import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function generateAccessKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `tb_live_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

// GET /api/forms — List all forms for the current user
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const skip = (page - 1) * limit;

    const where: any = { userId: session.userId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [forms, total] = await Promise.all([
      prisma.form.findMany({
        where,
        include: {
          fields: { orderBy: { order: 'asc' } },
          _count: { select: { submissions: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.form.count({ where }),
    ]);

    return NextResponse.json({ forms, total, page, limit });
  } catch (error: any) {
    console.error('[FORMS] GET error:', error?.message);
    return NextResponse.json({ error: 'Failed to load forms' }, { status: 500 });
  }
}

// POST /api/forms — Create a new form
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body: any = await req.json();
    const { name, description, formType, websiteUrl, fields: fieldDefs } = body;

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Form name is required' }, { status: 400 });
    }

    let slug = generateSlug(name);
    const existingSlug = await prisma.form.findUnique({ where: { slug } });
    if (existingSlug) {
      const rand = new Uint8Array(3);
      globalThis.crypto.getRandomValues(rand);
      slug = `${slug}-${Array.from(rand, b => b.toString(16).padStart(2, '0')).join('')}`;
    }

    const accessKey = generateAccessKey();

    const defaultFields: Record<string, Array<{ label: string; name: string; type: string; required: boolean; placeholder?: string }>> = {
      contact: [
        { label: 'Name', name: 'name', type: 'text', required: true, placeholder: 'Your name' },
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'you@example.com' },
        { label: 'Subject', name: 'subject', type: 'text', required: true, placeholder: 'How can we help?' },
        { label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: 'Tell us more...' },
      ],
      bug_report: [
        { label: 'Title', name: 'title', type: 'text', required: true, placeholder: 'Brief summary' },
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'you@example.com' },
        { label: 'Description', name: 'description', type: 'textarea', required: true, placeholder: 'Steps to reproduce...' },
        { label: 'Browser', name: 'browser', type: 'text', required: false, placeholder: 'Chrome 120' },
        { label: 'OS', name: 'os', type: 'text', required: false, placeholder: 'macOS 14.2' },
      ],
      feedback: [
        { label: 'Name', name: 'name', type: 'text', required: false, placeholder: 'Your name' },
        { label: 'Email', name: 'email', type: 'email', required: false, placeholder: 'you@example.com' },
        { label: 'Feedback', name: 'feedback', type: 'textarea', required: true, placeholder: 'Your feedback...' },
      ],
      waitlist: [
        { label: 'Name', name: 'name', type: 'text', required: true, placeholder: 'Your name' },
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'you@example.com' },
      ],
      lead_capture: [
        { label: 'Name', name: 'name', type: 'text', required: true, placeholder: 'Full name' },
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'you@company.com' },
        { label: 'Company', name: 'company', type: 'text', required: false, placeholder: 'Company name' },
        { label: 'Phone', name: 'phone', type: 'phone', required: false, placeholder: '+1 (555) 000-0000' },
      ],
      newsletter: [
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: 'you@example.com' },
      ],
    };

    const fieldsToCreate = fieldDefs || defaultFields[formType] || defaultFields.contact;

    const form = await prisma.form.create({
      data: {
        userId: session.userId,
        name: name.trim(),
        slug,
        description: description || null,
        formType: formType || 'custom',
        websiteUrl: websiteUrl || null,
        accessKey,
        notificationEmails: [],
        fields: {
          create: fieldsToCreate.map((f: any, i: number) => ({
            label: f.label,
            name: f.name,
            type: f.type || 'text',
            required: f.required || false,
            placeholder: f.placeholder || null,
            order: i,
          })),
        },
      },
      include: { fields: { orderBy: { order: 'asc' } } },
    });

    return NextResponse.json({ form }, { status: 201 });
  } catch (error: any) {
    console.error('[FORMS] POST error:', error?.message);
    return NextResponse.json({ error: 'Failed to create form' }, { status: 500 });
  }
}
