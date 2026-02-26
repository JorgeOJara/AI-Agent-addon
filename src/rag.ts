import { getRagChunks, getRagMeta, putSiteFacts, replaceRagChunks, type SiteFacts } from "./db";
import { scrapesite } from "./scraper";

const CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || "1100");
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || "180");
const TOP_K = parseInt(process.env.RAG_TOP_K || "8");
const MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS || "12000");

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function chunkText(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + CHUNK_SIZE);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function extractFactsObject(pages: { url: string; title: string; content: string }[]): SiteFacts {
  const text = pages.map((p) => `${p.title}\n${p.content}`).join("\n\n");
  const phones = Array.from(new Set(text.match(/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g) || []));
  const emails = Array.from(new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []));
  const addressMatches = Array.from(
    new Set(
      text.match(/\b\d{2,5} [A-Za-z0-9 .,#-]+,? [A-Za-z .]+,? [A-Z]{2} \d{5}(?:-\d{4})?\b/g) || []
    )
  );
  type OwnerCandidate = { name: string; title: string; score: number };
  const ownerCandidates: OwnerCandidate[] = [];
  const BAD_NAME_WORDS = new Set([
    "who", "what", "when", "where", "why", "how", "wants", "your", "customer",
    "news", "launch", "website", "business", "services", "company", "about",
  ]);
  const isPlausibleName = (name: string): boolean => {
    const parts = name.trim().split(/\s+/);
    if (parts.length !== 2) return false;
    const [a, b] = parts.map((x) => x.toLowerCase());
    if (BAD_NAME_WORDS.has(a) || BAD_NAME_WORDS.has(b)) return false;
    return /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name);
  };
  for (const p of pages) {
    const hay = `${p.title} ${p.content}`;
    const baseScore =
      /\/(about|about-us|team|contact)(\/|$)/i.test(p.url) ? 10 :
      /\/blog(\/|$)/i.test(p.url) ? -5 :
      0;

    const rx1 = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b\s*(?:-|,|\|)?\s*\b(owner(?:\s*\/\s*operator|\s*operator)?|founder|operator|ceo)\b/gi;
    const rx2 = /\b(owner(?:\s*\/\s*operator|\s*operator)?|founder|operator|ceo)\b\s*(?:-|,|\|)?\s*\b([A-Z][a-z]+ [A-Z][a-z]+)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = rx1.exec(hay))) {
      const name = m[1].trim();
      if (isPlausibleName(name)) ownerCandidates.push({ name, title: m[2].trim().toLowerCase(), score: baseScore + 8 });
    }
    while ((m = rx2.exec(hay))) {
      const name = m[2].trim();
      if (isPlausibleName(name)) ownerCandidates.push({ name, title: m[1].trim().toLowerCase(), score: baseScore + 8 });
    }
  }

  const hoursBlockMatch = text.match(/hours[^\n]{0,40}:(.*)/i);
  const serviceCanon: Array<[string, RegExp]> = [
    ["Web development", /web (development|dev)\b/i],
    ["Web design", /(web|website) design\b/i],
    ["Website maintenance", /website maintenance|site maintenance/i],
    ["Web hosting", /(web|website|turnkey) hosting/i],
    ["Web application development", /web application/i],
    ["Search engine optimization (SEO)", /\bseo\b|search engine optimization/i],
    ["Google Workspace", /google workspace/i],
    ["Google Business Profile", /google (my|business) (profile)?/i],
    ["Social media marketing", /social media (marketing)?/i],
    ["Consulting", /\bconsult(ing)?\b|marketing consulting/i],
    ["Ecommerce websites", /e-?commerce|ecommerce/i],
    ["Real estate websites", /real estate websites?/i],
    ["Photography", /photography/i],
  ];
  const servicesSet = new Set<string>();
  for (const [label, rx] of serviceCanon) {
    if (rx.test(text)) servicesSet.add(label);
  }

  ownerCandidates.sort((a, b) => b.score - a.score);
  const ownerName = ownerCandidates[0]?.name || null;
  const ownerTitle = ownerCandidates[0]?.title || null;
  return {
    ownerName,
    ownerTitle: ownerTitle ? ownerTitle.toLowerCase() : null,
    phones: phones.slice(0, 3),
    emails: emails.slice(0, 3),
    addresses: addressMatches.slice(0, 3),
    hours: hoursBlockMatch ? hoursBlockMatch[1].trim().slice(0, 120) : null,
    services: Array.from(servicesSet).slice(0, 12),
  };
}

type PreparedChunk = {
  url: string;
  title: string;
  chunkId: number;
  content: string;
  score: number;
};

function scoreChunk(content: string, title: string, url: string, queryTerms: string[]): number {
  const hay = `${title} ${url} ${content}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    const occurrences = hay.split(term).length - 1;
    if (occurrences > 0) score += occurrences;
    if (title.toLowerCase().includes(term)) score += 4;
    if (url.toLowerCase().includes(term)) score += 3;
  }
  return score;
}

export async function buildRagIndex(domain: string, siteName: string): Promise<{
  domain: string;
  siteName: string;
  pageCount: number;
  chunkCount: number;
}> {
  const pages = await scrapesite(domain);
  if (!pages.length) {
    throw new Error(`RAG bootstrap failed: no pages were scraped from ${domain}. Check DOMAINNAME and site reachability.`);
  }
  const preparedPages = pages.map((p) => ({
    url: p.url,
    title: p.title || "Untitled",
    chunks: chunkText(p.content),
  }));

  const stats = replaceRagChunks(domain, siteName, preparedPages);
  if (!stats.chunkCount) {
    throw new Error(`RAG bootstrap failed: pages were scraped but no chunks were generated for ${domain}.`);
  }
  putSiteFacts(domain, extractFactsObject(pages));
  return { domain, siteName, pageCount: stats.pageCount, chunkCount: stats.chunkCount };
}

export async function ensureRagIndex(domain: string, siteName: string, force = false) {
  const meta = getRagMeta(domain);
  if (!force && meta && meta.chunkCount > 0) {
    return {
      domain,
      siteName: meta.siteName || siteName,
      pageCount: meta.pageCount,
      chunkCount: meta.chunkCount,
      indexedAt: meta.indexedAt,
      built: false,
    };
  }
  const built = await buildRagIndex(domain, siteName);
  return {
    ...built,
    indexedAt: new Date().toISOString(),
    built: true,
  };
}

export function retrieveRagContext(
  domain: string,
  userQuery: string,
  opts?: { topK?: number; maxChars?: number }
): {
  context: string;
  sources: string[];
  bestScore: number;
  topScore: number;
} {
  const topK = opts?.topK ?? TOP_K;
  const maxChars = opts?.maxChars ?? MAX_CONTEXT_CHARS;
  const rows = getRagChunks(domain);
  if (!rows.length) return { context: "", sources: [], bestScore: 0, topScore: 0 };

  const queryTerms = tokenize(userQuery);
  const scored: PreparedChunk[] = rows.map((row) => ({
    url: row.url,
    title: row.title,
    chunkId: row.chunkId,
    content: row.content,
    score: scoreChunk(row.content, row.title, row.url, queryTerms),
  }));

  scored.sort((a, b) => b.score - a.score);
  const bestScore = scored[0]?.score ?? 0;
  const selected = scored.filter((s, i) => i < topK && (s.score > 0 || i < 2));

  const parts: string[] = [];
  const sources = new Set<string>();
  let total = 0;
  for (const chunk of selected) {
    const entry = `--- ${chunk.title} (${chunk.url}) [chunk ${chunk.chunkId}] ---\n${chunk.content}`;
    if (total + entry.length > maxChars) break;
    parts.push(entry);
    total += entry.length;
    sources.add(chunk.url);
  }

  return {
    context: parts.join("\n\n"),
    sources: Array.from(sources),
    bestScore,
    topScore: bestScore,
  };
}

export function isLikelyOnTopic(domain: string, message: string): boolean {
  const hits = retrieveRagContext(domain, message, { topK: 1, maxChars: 1200 });
  const minScore = parseInt(process.env.RAG_MIN_TOPIC_SCORE || "2");
  return hits.bestScore >= minScore;
}
