import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId }, include: { fields: { orderBy: { order: 'asc' } } } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const format = searchParams.get('format'); // 'csv' or 'json' for export
    const status = searchParams.get('status');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;

    const where: any = { formId: id };
    if (status) where.status = status;

    // Export mode — fetch all submissions
    if (format === 'csv' || format === 'json') {
      const submissions = await prisma.formSubmission.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10000 });
      const fields = form.fields;

      if (format === 'json') {
        const jsonData = submissions.map((s, i) => {
          const row: Record<string, any> = {
            id: s.id,
            submitted_at: s.createdAt,
          };
          for (const f of fields) {
            row[f.name] = (s.data as any)?.[f.name] ?? '';
          }
          return row;
        });
        return new NextResponse(JSON.stringify(jsonData, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${form.slug}-submissions.json"`,
          },
        });
      }

      // CSV
      const headers = ['id', 'submitted_at', ...fields.map(f => f.name)];
      const csvRows = [headers.join(',')];
      for (const s of submissions) {
        const row = [
          s.id,
          s.createdAt.toISOString(),
          ...fields.map(f => {
            const val = (s.data as any)?.[f.name] ?? '';
            const str = String(val);
            // Escape CSV: wrap in quotes if it contains comma, quote, or newline
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
          }),
        ];
        csvRows.push(row.join(','));
      }
      return new NextResponse(csvRows.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${form.slug}-submissions.csv"`,
        },
      });
    }

    // Paginated mode (default)
    const [submissions, total] = await Promise.all([
      prisma.formSubmission.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.formSubmission.count({ where }),
    ]);

    return NextResponse.json({ submissions, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error: any) {
    console.error('[FORMS] GET submissions error:', error?.message);
    return NextResponse.json({ error: 'Failed to load submissions' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const { ids, status, notes } = body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'No submissions selected' }, { status: 400 });
    }

    const updateData: any = {};
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    const updated = await prisma.formSubmission.updateMany({
      where: { id: { in: ids }, formId: id },
      data: updateData,
    });

    return NextResponse.json({ updated: updated.count });
  } catch (error: any) {
    console.error('[FORMS] PATCH submissions error:', error?.message);
    return NextResponse.json({ error: 'Failed to update submissions' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const ids = searchParams.get('ids')?.split(',').filter(Boolean);

    const deleted = ids?.length
      ? await prisma.formSubmission.deleteMany({ where: { id: { in: ids }, formId: id } })
      : await prisma.formSubmission.deleteMany({ where: { formId: id } });

    return NextResponse.json({ deleted: deleted.count });
  } catch (error: any) {
    console.error('[FORMS] DELETE submissions error:', error?.message);
    return NextResponse.json({ error: 'Failed to delete submissions' }, { status: 500 });
  }
}
