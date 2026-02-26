import * as cheerio from "cheerio";
import { getConfiguredDomain } from "./config";

const SITE_DOMAIN = getConfiguredDomain();
const MAX_PAGES = parseInt(process.env.SCRAPER_MAX_PAGES || "0");
const CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY || "3");
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || "12000");

interface PageData {
  url: string;
  title: string;
  content: string;
}

function normUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    // Only keep same-origin links
    const origin = new URL(base).origin;
    if (u.origin !== origin) return null;
    // Skip non-html resources
    const ext = u.pathname.split(".").pop()?.toLowerCase() ?? "";
    const skip = ["png", "jpg", "jpeg", "gif", "svg", "css", "js", "pdf", "zip", "ico", "woff", "woff2", "ttf", "mp4", "mp3", "webp"];
    if (skip.includes(ext)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function buildSeedQueue(baseDomain: string): string[] {
  const seeds = new Set<string>();
  const add = (href: string) => {
    const n = normUrl(href, baseDomain);
    if (n) seeds.add(n);
  };
  add(baseDomain);
  const priorityPaths = [
    "/",
    "/about",
    "/about/",
    "/about-us",
    "/about-us/",
    "/contact",
    "/contact/",
    "/contact-us",
    "/contact-us/",
    "/services",
    "/services/",
    "/web-development-design/",
  ];
  for (const p of priorityPaths) add(p);
  const extra = (process.env.SCRAPER_EXTRA_URLS || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of extra) add(u);
  return Array.from(seeds);
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>(.*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const u = decodeXml(m[1].trim());
    if (u) urls.push(u);
  }
  return urls;
}

async function fetchSitemapUrls(baseDomain: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [
    new URL("/sitemap.xml", baseDomain).toString(),
    new URL("/wp-sitemap.xml", baseDomain).toString(),
  ];
  const out: string[] = [];

  while (queue.length > 0 && seen.size < 40) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    try {
      const res = await fetch(sm, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("xml") && !ct.includes("text")) continue;
      const xml = await res.text();
      const locs = extractSitemapUrls(xml);
      for (const loc of locs) {
        try {
          const n = normUrl(loc, baseDomain);
          if (!n) continue;
          if (n.endsWith(".xml") || /sitemap/i.test(n)) queue.push(n);
          else out.push(n);
        } catch {}
      }
    } catch {}
  }
  return Array.from(new Set(out));
}

async function fetchPage(url: string): Promise<{ html: string; ok: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SiteChatBot/1.0 (scraper)" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) {
      return { html: "", ok: false };
    }
    return { html: await res.text(), ok: true };
  } catch {
    return { html: "", ok: false };
  }
}

function extractText(html: string): { title: string; text: string; links: string[] } {
  const $ = cheerio.load(html);

  const title = $("title").text().trim() || $("h1").first().text().trim() || "";

  // Extract ALL links BEFORE removing nav/footer so we discover every route
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href);
  });

  // Now remove non-content elements for text extraction
  $("script, style, nav, footer, header, noscript, iframe, svg, form, [role='navigation'], [role='banner'], [aria-hidden='true']").remove();

  // Get main content areas first, fall back to body
  let text = "";
  const mainSelectors = ["main", "article", "[role='main']", "#content", ".content", "#main"];
  for (const sel of mainSelectors) {
    const el = $(sel);
    if (el.length) {
      text = el.text();
      break;
    }
  }
  if (!text) {
    text = $("body").text();
  }

  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();

  return { title, text, links };
}

export async function scrapesite(domain?: string): Promise<PageData[]> {
  const baseDomain = domain || SITE_DOMAIN;
  console.log(`[scraper] Starting scrape of ${baseDomain}`);

  const visited = new Set<string>();
  const queue: string[] = buildSeedQueue(baseDomain);
  try {
    const sitemapUrls = await fetchSitemapUrls(baseDomain);
    queue.push(...sitemapUrls);
    console.log(`[scraper] Loaded ${sitemapUrls.length} URLs from sitemaps`);
  } catch {}
  const pages: PageData[] = [];
  const canVisitMore = () => MAX_PAGES <= 0 || visited.size < MAX_PAGES;

  while (queue.length > 0 && canVisitMore()) {
    // Dedupe the batch before processing
    const batch: string[] = [];
    while (queue.length > 0 && batch.length < CONCURRENCY) {
      const url = queue.shift()!;
      if (!visited.has(url) && canVisitMore()) {
        visited.add(url);
        batch.push(url);
      }
    }
    if (batch.length === 0) break;

    const discovered: string[] = [];
    const tasks = batch.map(async (url) => {
      const { html, ok } = await fetchPage(url);
      if (!ok) return;

      const { title, text, links } = extractText(html);
      if (text.length < 20) return; // Skip near-empty pages

      pages.push({ url, title, content: text.slice(0, 8000) });
      console.log(`[scraper] Scraped: ${url} (${text.length} chars)`);

      // Collect discovered links
      for (const href of links) {
        const normalized = normUrl(href, url);
        if (normalized && !visited.has(normalized)) {
          discovered.push(normalized);
        }
      }
    });

    await Promise.all(tasks);
    // Add discovered links after batch completes, with core pages first.
    const core: string[] = [];
    const rest: string[] = [];
    for (const u of discovered) {
      if (/(\/about|\/about-us|\/contact|\/contact-us|\/services)(\/|$)/i.test(u)) core.push(u);
      else rest.push(u);
    }
    queue.push(...core, ...rest);
  }

  console.log(`[scraper] Done. Scraped ${pages.length} pages from ${baseDomain}`);
  return pages;
}

// Run directly
if (import.meta.main) {
  const pages = await scrapesite();
  console.log(`Scraped ${pages.length} pages`);
}
