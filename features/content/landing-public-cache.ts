import { createTtlCache } from '@/infrastructure/cache';
import type { LandingConfig } from '@/features/content/landing-page';

const CACHE_KEY = 'home';
const landingConfigCache = createTtlCache<LandingConfig>(60_000, 1, 'public-landing-config');

export function getCachedPublishedLandingConfig(): LandingConfig | undefined {
  return landingConfigCache.get(CACHE_KEY);
}

export function cachePublishedLandingConfig(config: LandingConfig): void {
  landingConfigCache.set(CACHE_KEY, config);
}

/** Clear the process-local copy after a successful publication. */
export function invalidatePublishedLandingConfig(): void {
  landingConfigCache.delete(CACHE_KEY);
}
