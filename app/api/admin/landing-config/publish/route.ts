import { NextRequest, NextResponse } from "next/server";
import { createAuditEvent } from "@/features/security/audit";
import { jsonError, jsonForbidden } from "@/shared/response";
import { getEffectivePermissions } from "@/features/auth/roles";
import { requireAdmin } from "@/features/auth/http-guards";
import { publishLandingDraft } from "@/features/content/landing-page";
import { invalidatePublishedLandingConfig } from "@/features/content/landing-public-cache";

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const permissions = await getEffectivePermissions(session.userId);
  if (!permissions["landing.edit"]) {
    return jsonForbidden(
      "You do not have permission to publish the landing page.",
      request,
    );
  }

  try {
    const { page, config } = await publishLandingDraft(session.userId);
    invalidatePublishedLandingConfig();
    await createAuditEvent({
      actorId: session.userId,
      action: "LANDING_PAGE_PUBLISHED",
      targetType: "landing_page",
      targetId: page.id,
      metadata: {
        publishedVersion: page.publishedVersion,
        sectionCount: config.sections.length,
      },
      severity: "info",
    });

    return NextResponse.json({
      success: true,
      config,
      publishedVersion: page.publishedVersion,
      publishedAt: page.publishedAt,
    });
  } catch (error: any) {
    console.error(
      "[ADMIN LANDING PUBLISH] Failed to publish landing page:",
      error?.message || error,
    );
    return jsonError(
      "LANDING_PUBLISH_FAILED",
      "Unable to publish the landing page.",
      503,
      request,
    );
  }
}
