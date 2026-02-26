export type ContactInfo = {
  emails: string[];
  phones: string[];
};

// Very lightweight extractors for emails and US-style phone numbers.
export function extractContactInfo(text: string): ContactInfo {
  const emails = Array.from(
    new Set(
      (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).map((s) => s.trim())
    )
  );
  const phones = Array.from(
    new Set(
      (text.match(/\b\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g) || []).map((s) => s.trim())
    )
  );
  return { emails, phones };
}

// Detect user intent to speak with the company
export function detectContactIntent(text: string): boolean {
  const rx = /(talk|speak|chat)\s+(to|with)\s+(someone|a (human|person)|the (company|team|business|owner)|you)|\b(contact|reach|call|email)\s+(me|us|back)\b|\bcan someone (call|contact|reach) me\b|\bbook (a )?(call|meeting|consultation)\b|\bschedule (a )?(call|meeting)\b/i;
  return rx.test(text);
}

export function hasContact(info: ContactInfo): boolean {
  return (info.emails && info.emails.length > 0) || (info.phones && info.phones.length > 0);
}

export function mergeContactInfo(a: ContactInfo, b: ContactInfo): ContactInfo {
  const emails = Array.from(new Set([...(a.emails || []), ...(b.emails || [])]));
  const phones = Array.from(new Set([...(a.phones || []), ...(b.phones || [])]));
  return { emails, phones };
}

export function extractContactFromHistory(
  history: { role: "user" | "assistant"; content: string }[] | undefined
): ContactInfo {
  const empty: ContactInfo = { emails: [], phones: [] };
  if (!history || !Array.isArray(history) || history.length === 0) return empty;
  let acc: ContactInfo = { emails: [], phones: [] };
  for (const h of history) {
    if (h.role !== "user" || !h.content) continue;
    acc = mergeContactInfo(acc, extractContactInfo(h.content));
  }
  return acc;
}

// Heuristic: treat short, non-numeric user messages without URLs/emails as a topic hint
export function extractTopicHint(text: string): string | null {
  if (!text) return null;
  const withoutContacts = text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, " ")
    .replace(/\b\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  if (!withoutContacts) return null;
  const words = withoutContacts.split(/\s+/);
  if (words.length < 2 || words.length > 24) return null;
  return withoutContacts;
}

export function extractTopicsFromHistory(
  history: { role: "user" | "assistant"; content: string }[] | undefined
): string[] {
  const set = new Set<string>();
  if (!history) return [];
  for (const h of history) {
    if (h.role !== "user") continue;
    const t = extractTopicHint(h.content || "");
    if (t) set.add(t);
  }
  return Array.from(set);
}

// Simple name extractor: matches patterns like
// "my name is John", "I am John Doe", "I'm John".
export function extractName(text: string): string | null {
  if (!text) return null;
  const rxList: RegExp[] = [
    /\bmy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
    /\bi am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
    /\bi'm\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i,
  ];
  for (const rx of rxList) {
    const m = rx.exec(text);
    if (m && m[1]) {
      const name = m[1].trim();
      if (!/@/.test(name) && name.length >= 2 && name.length <= 40) return name;
    }
  }
  return null;
}

export function splitNameParts(full: string | null | undefined): { first?: string; last?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function extractCompany(text: string): string | null {
  if (!text) return null;
  const rxList: RegExp[] = [
    /\bmy company is\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\b/,
    /\bi (work|am) (at|with)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\b/,
    /\bwe are\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\b/,
  ];
  for (const rx of rxList) {
    const m = rx.exec(text);
    const val = m?.[1] || m?.[3];
    if (val) return val.trim();
  }
  return null;
}

export function extractNameFromHistory(
  history: { role: "user" | "assistant"; content: string }[] | undefined
): string | null {
  if (!history) return null;
  for (const h of history) {
    if (h.role !== "user") continue;
    const n = extractName(h.content || "");
    if (n) return n;
  }
  return null;
}
