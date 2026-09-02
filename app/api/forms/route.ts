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

// GET /api/forms — List all forms for the current user, or ?stats=true for stats
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);

    // Stats mode: return user's form stats
    if (searchParams.get('stats') === 'true') {
      const [userForms, userSubmissions, totalUsersWithForms] = await Promise.all([
        prisma.form.count({ where: { userId: session.userId } }),
        prisma.formSubmission.count({ where: { form: { userId: session.userId } } }),
        prisma.form.groupBy({ by: ['userId'], _count: true }).then(r => r.length),
      ]);
      return NextResponse.json({
        totalForms: userForms,
        totalSubmissions: userSubmissions,
        totalUsers: totalUsersWithForms,
      });
    }

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
    const { name, description, fields, settings } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Form name is required' }, { status: 400 });
    }

    const slug = generateSlug(name.trim());
    const accessKey = generateAccessKey();

    const form = await prisma.form.create({
      data: {
        name: name.trim(),
        description: description || null,
        slug,
        accessKey,
        userId: session.userId,
        status: 'draft',
        settings: settings || {},
        fields: {
          create: (fields || []).map((f: any, i: number) => ({
            label: f.label || `Field ${i + 1}`,
            name: f.name || `field_${i + 1}`,
            type: f.type || 'text',
            required: f.required || false,
            placeholder: f.placeholder || null,
            options: f.options || null,
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
