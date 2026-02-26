import { STRICT_TOPIC_GUARD } from "./policy";

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","those","these","with","for","from","to","in","on","at","by","of","as","is","are","was","were","be","been","being","it","its","you","your","yours","we","our","ours","they","their","theirs","i","me","my","mine","he","him","his","she","her","hers","them","who","what","when","where","why","how","do","does","did","can","could","should","would"
]);

const OFFTOPIC_PATTERNS: RegExp[] = [
  /\b(president|prime minister|governor|senator|election|capital of|country flag|state flag)\b/i,
  /\b(weather|temperature|forecast|time in|timezone)\b/i,
  /\b(stock|price|bitcoin|crypto|exchange rate)\b/i,
  /\bnews|headlines|trending|twitter|reddit|wikipedia\b/i,
  /\btranslate|definition of|define |what does .* mean\b/i,
  /\bsolve |what is \d+ [+\-*/] \d+\b/i,
  /\bmovie|lyrics|celebrity|sports score|nba|nfl|soccer\b/i,
];

// Queries that are inherently about the business, even if the
// exact brand name isn't present in the message text.
const ALWAYS_ON_TOPIC_PATTERNS: RegExp[] = [
  // Business/company identification
  /\b(business|company|site|website)\s+name\b/i,
  // Mission, goals, purpose
  /\b(business|company|site|website)\s+(goals?|mission|vision|purpose)\b/i,
  // "Why choose us/you" style
  /\bwhy\s+(choose|pick|go with|select)\s+(you|your|us|the\s+(business|company|site|website)|[a-z0-9 .-]+)\b/i,
  /\bwhy\s+us\b/i,
  // Common misspellings of business
  /\bbus+ines+s\b/i,
  /\bbus+nes+s\b/i,
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function topicScore(message: string, context: string): number {
  const msgTerms = new Set(tokenize(message));
  if (msgTerms.size === 0) return 0;
  const ctx = tokenize(context);
  const ctxSet = new Set(ctx);
  let hits = 0;
  for (const t of msgTerms) if (ctxSet.has(t)) hits++;
  return hits / Math.max(1, msgTerms.size);
}

export function isOnTopic(message: string, context: string): boolean {
  // Hard disallow obvious unrelated queries
  for (const rx of OFFTOPIC_PATTERNS) {
    if (rx.test(message)) return false;
  }
  // Fast allow if the phrasing clearly refers to the business itself
  for (const rx of ALWAYS_ON_TOPIC_PATTERNS) {
    if (rx.test(message)) return true;
  }
  const score = topicScore(message, context);
  const threshold = parseFloat(process.env.TOPIC_MIN_OVERLAP || "0.06");
  if (!STRICT_TOPIC_GUARD) return true;
  return score >= threshold;
}

export function isTriviaRequest(message: string): boolean {
  const m = message.toLowerCase();
  return /tell me something .* (don't|dont) know/.test(m)
    || /lesser[- ]known|little[- ]known|unknown fact|hidden (fact|info)/.test(m)
    || /fun (fact|info)/.test(m)
    || /random (fact|info)/.test(m);
}
