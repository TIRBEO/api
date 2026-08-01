import type { NextRequest } from "next/server";
import { prisma } from "./db/prisma";
import { getSession, getAdminRole } from "./session";
import { jsonUnauthorized } from "./response";

function isProjectVisibility(v: string): boolean {
  return v === "public" || v === "private" || v === "unlisted";
}

function parsePagination(req: NextRequest) {
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export async function handleProjects(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();
  const userId = session.userId;

  const url = new URL(req.url);
  const method = req.method;

  if (method === "GET") {
    const { page, limit, offset } = parsePagination(req);
    const search = url.searchParams.get("search") || "";
    const category = url.searchParams.get("category") || "";
    const visibility = url.searchParams.get("visibility") || "";
    const sort = url.searchParams.get("sort") || "recent";
    const userId = url.searchParams.get("userId") || "";

    try {
      const where: any = {};
      if (userId) where.userId = userId;
      if (search) where.title = { contains: search, mode: "insensitive" as const };
      if (category && category !== "all") where.category = category;
      if (visibility && isProjectVisibility(visibility)) where.visibility = visibility;
      const orderBy: any = {};
      if (sort === "stars") orderBy.starCount = "desc" as const;
      else if (sort === "views") orderBy.viewCount = "desc" as const;
      else if (sort === "name") orderBy.title = "asc" as const;
      else orderBy.updatedAt = "desc" as const;

      const [projects, total] = await Promise.all([
        prisma.projects.findMany({
          where,
          orderBy,
          skip: offset,
          take: limit,
          select: {
            id: true, title: true, description: true, category: true,
            language: true, visibility: true, starCount: true, viewCount: true,
            forkCount: true, githubUrl: true, demoUrl: true, thumbnailUrl: true,
            pinned: true, createdAt: true,
            user: { select: { id: true, name: true, photoUrl: true } },
            _count: { select: { likes: true, comments: true } },
          },
        }),
        prisma.projects.count({ where }),
      ]);

      return new Response(JSON.stringify({ projects, total, page, limit, hasMore: offset + limit < total }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to fetch projects" }), { status: 500 });
    }
  }

  if (method === "POST") {
    try {
      const body = await req.json();
      const { title, description, content, githubUrl, demoUrl, language, category, visibility, isStartup, pinned } = body;
      if (!title || !title.trim()) return new Response(JSON.stringify({ error: "Title is required" }), { status: 400 });

      const project = await prisma.projects.create({
        data: {
          title: title.trim(),
          description: description?.trim(),
          content: content?.trim(),
          githubUrl,
          demoUrl,
          language,
          category: category || "other",
          visibility: isProjectVisibility(visibility) ? visibility : "public",
          isStartup: !!isStartup,
          pinned: !!pinned,
          userId,
        },
        select: { id: true, title: true, description: true, category: true, language: true, visibility: true, starCount: true, viewCount: true, forkCount: true, githubUrl: true, demoUrl: true, thumbnailUrl: true, pinned: true, createdAt: true, user: { select: { id: true, name: true, photoUrl: true } } },
      });
      return new Response(JSON.stringify(project), { status: 201, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to create project" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
}

export async function handleProjectDetail(req: NextRequest, params: { id: string }) {
  const session = await getSession(req);
  const { id } = params;
  const method = req.method;

  if (method === "GET") {
    try {
      const project = await prisma.projects.findUnique({
        where: { id },
        select: {
          id: true, title: true, description: true, content: true, githubUrl: true, demoUrl: true,
          language: true, category: true, visibility: true, isStartup: true, pinned: true,
          starCount: true, forkCount: true, viewCount: true, thumbnailUrl: true,
          createdAt: true, updatedAt: true,
          user: { select: { id: true, name: true, photoUrl: true, githubUsername: true, linkedin: true } },
          projectTags: { select: { name: true } },
          _count: { select: { likes: true, comments: true, bookmarks: true } },
        },
      });
      if (!project) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
      await prisma.projects.update({ where: { id }, data: { viewCount: { increment: 1 } } });
      return new Response(JSON.stringify(project), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to fetch project" }), { status: 500 });
    }
  }

  if (!session) return jsonUnauthorized();
  const userId = session.userId;

  if (method === "PATCH") {
    try {
      const existing = await prisma.projects.findUnique({ where: { id }, select: { userId: true } });
      if (!existing) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
      if (existing.userId !== userId && (await getAdminRole(userId)) !== "super_admin") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
      const body = await req.json();
      const updated = await prisma.projects.update({
        where: { id },
        data: { title: body.title, description: body.description, content: body.content, githubUrl: body.githubUrl, demoUrl: body.demoUrl, language: body.language, category: body.category, visibility: body.visibility, pinned: body.pinned },
        select: { id: true, title: true, description: true, visibility: true },
      });
      return new Response(JSON.stringify(updated), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to update project" }), { status: 500 });
    }
  }

  if (method === "DELETE") {
    try {
      const existing = await prisma.projects.findUnique({ where: { id }, select: { userId: true } });
      if (!existing) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
      if (existing.userId !== userId && (await getAdminRole(userId)) !== "super_admin") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
      await prisma.projects.delete({ where: { id } });
      return new Response(null, { status: 204 });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to delete project" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
}

export async function handleProjectStar(req: NextRequest, params: { id: string }) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();
  const userId = session.userId;
  const { id } = params;

  if (req.method === "POST") {
    try {
      const { starCount } = await prisma.projects.update({
        where: { id },
        data: { starCount: { increment: 1 } },
        select: { starCount: true },
      });
      await prisma.likes.upsert({
        where: { userId_entityType_entityId: { userId, entityType: "project", entityId: id } },
        create: { userId, entityType: "project", entityId: id },
        update: {},
      });
      return new Response(JSON.stringify({ starred: true, starCount }), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to star project" }), { status: 500 });
    }
  }

  if (req.method === "DELETE") {
    try {
      await prisma.likes.deleteMany({ where: { userId, entityType: "project", entityId: id } });
      const { starCount } = await prisma.projects.update({ where: { id }, data: { starCount: { decrement: 1 } }, select: { starCount: true } });
      return new Response(JSON.stringify({ starred: false, starCount }), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to unstar project" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
}

export async function handleProjectFork(req: NextRequest, params: { id: string }) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();
  const userId = session.userId;
  const { id } = params;

  if (req.method === "POST") {
    try {
      const original = await prisma.projects.findUnique({ where: { id }, select: { title: true, description: true, content: true, language: true, category: true, visibility: true, githubUrl: true } });
      if (!original) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
      const forked = await prisma.projects.create({
        data: { title: `${original.title} (fork)`, description: original.description, content: original.content, language: original.language, category: original.category, visibility: "private", githubUrl: original.githubUrl, userId },
        select: { id: true, title: true, description: true },
      });
      await prisma.projects.update({ where: { id }, data: { forkCount: { increment: 1 } } });
      return new Response(JSON.stringify(forked), { status: 201, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to fork project" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
}