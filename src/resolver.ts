// Mock for resolving a siteId to a domain + freshness flag
// In production, replace with a real HTTP call to your resolver service.
import { getConfiguredDomain, getConfiguredSiteName } from "./config";

export type ResolvedSite = {
  domain: string; // e.g., https://example.com
  updated: boolean; // true => site content changed; re-scrape recommended
  siteName?: string; // optional, if resolver knows
};

const FALLBACK_DOMAIN = getConfiguredDomain();
const MOCK_ID_DOMAIN = process.env.MOCK_ID_DOMAIN || FALLBACK_DOMAIN;
const MOCK_ID_UPDATED = (process.env.MOCK_ID_UPDATED || "false").toLowerCase() === "true";
const MOCK_SITE_NAME = process.env.MOCK_SITE_NAME || getConfiguredSiteName();

// Track first-seen behavior per siteId: first call => updated=true, then false.
const seenSiteIds = new Set<string>();

export async function resolveSiteId(siteId: string): Promise<ResolvedSite> {
  // Replace with a fetch() to a real resolver API when ready.
  // Mock behavior: first request for a given siteId returns updated=true to force scrape,
  // then subsequent requests return updated=false to use SQLite cache.
  const firstTime = !seenSiteIds.has(siteId);
  if (firstTime) seenSiteIds.add(siteId);
  const updated = firstTime ? true : MOCK_ID_UPDATED;
  return {
    domain: MOCK_ID_DOMAIN,
    updated,
    siteName: MOCK_SITE_NAME,
  };
}
