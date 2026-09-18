import { NextRequest, NextResponse } from "next/server";
import { createAuditEvent } from "@/features/security/audit";
import { jsonError, jsonForbidden } from "@/shared/response";
import { getEffectivePermissions } from "@/features/auth/roles";
import { requireAdmin } from "@/features/auth/http-guards";
import {
  getLandingDraft,
  saveLandingDraft,
} from "@/features/content/landing-page";

async function requireLandingPermission(
  request: NextRequest,
  permission: "landing.view" | "landing.edit",
) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const permissions = await getEffectivePermissions(session.userId);
  if (!permissions[permission])
    return jsonForbidden(
      "You do not have permission to manage the landing page.",
      request,
    );

  return session;
}

export async function GET(request: NextRequest) {
  const session = await requireLandingPermission(request, "landing.view");
  if (session instanceof NextResponse) return session;

  try {
    const { page, config } = await getLandingDraft();
    return NextResponse.json({
      config,
      draftVersion: page.draftVersion,
      publishedVersion: page.publishedVersion,
      publishedAt: page.publishedAt,
      updatedAt: page.updatedAt,
      canEdit: true,
    });
  } catch (error: any) {
    console.error(
      "[ADMIN LANDING CONFIG] Failed to read landing draft:",
      error?.message || error,
    );
    return jsonError(
      "LANDING_CONFIG_UNAVAILABLE",
      "Unable to load landing page configuration.",
      503,
      request,
    );
  }
}

export async function PUT(request: NextRequest) {
  const session = await requireLandingPermission(request, "landing.edit");
  if (session instanceof NextResponse) return session;

  try {
    const body = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("config" in body)
    ) {
      return jsonError(
        "INVALID_LANDING_CONFIG",
        "A landing configuration is required.",
        400,
        request,
      );
    }

    const { page, config } = await saveLandingDraft(
      body.config,
      session.userId,
    );
    await createAuditEvent({
      actorId: session.userId,
      action: "LANDING_DRAFT_SAVED",
      targetType: "landing_page",
      targetId: page.id,
      metadata: {
        draftVersion: page.draftVersion,
        sectionCount: config.sections.length,
      },
      severity: "info",
    });

    return NextResponse.json({
      success: true,
      config,
      draftVersion: page.draftVersion,
      updatedAt: page.updatedAt,
    });
  } catch (error: any) {
    console.error(
      "[ADMIN LANDING CONFIG] Failed to save landing draft:",
      error?.message || error,
    );
    return jsonError(
      "INVALID_LANDING_CONFIG",
      "Unable to save landing page configuration.",
      400,
      request,
    );
  }
}
