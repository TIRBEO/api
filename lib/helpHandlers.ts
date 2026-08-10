import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { jsonError, jsonNotFound } from './response';
import { createAuditEvent } from './audit';
import { sanitizeInput } from './security';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// GET /api/admin/help-articles (list all, including drafts)
export async function helpArticlesListHandler(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const url = new URL(req.url);
    const includeDrafts = url.searchParams.get('drafts') !== 'false';
    const articles = await prisma.helpArticle.findMany({
      where: includeDrafts ? {} : { published: true },
      orderBy: [{ ord: 'asc' }, { title: 'asc' }],
    });
    return NextResponse.json(articles);
  } catch (err: any) {
    return jsonError('Failed to list help articles', err?.message || err);
  }
}

// POST /api/admin/help-articles (create)
export async function helpArticlesCreateHandler(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const body: any = await req.json();
    const title = sanitizeInput(String(body.title || '').trim(), 200);
    if (!title) return jsonError('Title is required', 400);
    const content = sanitizeInput(String(body.content || '').trim(), 50000);
    if (!content) return jsonError('Content is required', 400);
    const category = sanitizeInput(String(body.category || 'General').trim(), 100);
    const icon = sanitizeInput(String(body.icon || 'book').trim(), 100);
    const slugRaw = String(body.slug || '').trim();
    const slug = slugRaw ? slugify(slugRaw) : slugify(title);
    const ord = typeof body.ord === 'number' ? body.ord : 0;
    const published = body.published !== false;

    const existing = await prisma.helpArticle.findUnique({ where: { slug } });
    if (existing) return jsonError(`Slug "${slug}" already exists`, 409);

    const article = await prisma.helpArticle.create({
      data: { slug, title, content, category, icon, ord, published },
    });
    await createAuditEvent({ actorId: admin.userId, action: 'HELP_ARTICLE_CREATED', targetType: 'help_article', targetId: article.id });
    return NextResponse.json(article, { status: 201 });
  } catch (err: any) {
    return jsonError('Failed to create help article', err?.message || err);
  }
}

// PATCH /api/admin/help-articles/[id]
export async function helpArticlesUpdateHandler(req: NextRequest, id: string) {
  try {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const body: any = await req.json();
    const existing = await prisma.helpArticle.findUnique({ where: { id } });
    if (!existing) return jsonNotFound('Help article');

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const title = sanitizeInput(String(body.title).trim(), 200);
      if (!title) return jsonError('Title cannot be empty', 400);
      data.title = title;
    }
    if (body.content !== undefined) {
      const content = sanitizeInput(String(body.content).trim(), 50000);
      if (!content) return jsonError('Content cannot be empty', 400);
      data.content = content;
    }
    if (body.category !== undefined) data.category = sanitizeInput(String(body.category).trim(), 100) || 'General';
    if (body.icon !== undefined) data.icon = sanitizeInput(String(body.icon).trim(), 100) || 'book';
    if (body.ord !== undefined) data.ord = typeof body.ord === 'number' ? body.ord : existing.ord;
    if (body.published !== undefined) data.published = body.published !== false;
    if (body.slug !== undefined) {
      const slug = slugify(String(body.slug).trim());
      if (!slug) return jsonError('Invalid slug', 400);
      const clash = await prisma.helpArticle.findFirst({ where: { slug, id: { not: id } } });
      if (clash) return jsonError(`Slug "${slug}" already exists`, 409);
      data.slug = slug;
    }

    const article = await prisma.helpArticle.update({ where: { id }, data });
    await createAuditEvent({ actorId: admin.userId, action: 'HELP_ARTICLE_UPDATED', targetType: 'help_article', targetId: id });
    return NextResponse.json(article);
  } catch (err: any) {
    return jsonError('Failed to update help article', err?.message || err);
  }
}

// DELETE /api/admin/help-articles/[id]
export async function helpArticlesDeleteHandler(req: NextRequest, id: string) {
  try {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const existing = await prisma.helpArticle.findUnique({ where: { id } });
    if (!existing) return jsonNotFound('Help article');
    await prisma.helpArticle.delete({ where: { id } });
    await createAuditEvent({ actorId: admin.userId, action: 'HELP_ARTICLE_DELETED', targetType: 'help_article', targetId: id });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return jsonError('Failed to delete help article', err?.message || err);
  }
}

export async function helpArticleDetailHandler(req: NextRequest, id: string) {
  try {
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const article = await prisma.helpArticle.findUnique({ where: { id } });
    if (!article) return jsonNotFound('Help article');
    return NextResponse.json(article);
  } catch (err: any) {
    return jsonError('Failed to load help article', err?.message || err);
  }
}
