import { cachedJson } from "@/shared/response";
import { getPublishedLandingConfig } from "@/features/content/landing-page";
import {
  cachePublishedLandingConfig,
  getCachedPublishedLandingConfig,
} from "@/features/content/landing-public-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let config = getCachedPublishedLandingConfig();
    if (!config) {
      config = await getPublishedLandingConfig();
      cachePublishedLandingConfig(config);
    }

    return cachedJson({ config }, { ttl: 60, swr: 300 });
  } catch (error: any) {
    console.error(
      "[PUBLIC LANDING CONFIG] Failed to load published config:",
      error?.message || error,
    );
    return cachedJson({ config: null }, { ttl: 15, swr: 60 });
  }
}
