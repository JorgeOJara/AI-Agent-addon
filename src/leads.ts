import { mkdirSync, existsSync } from "fs";

export type Lead = {
  id: string;
  domain: string;
  siteName: string;
  emails: string[];
  phones: string[];
  name?: string | null;
  lastName?: string | null;
  company?: string | null;
  topics: string[];
  sessions: string[];
  createdAt: string;
  updatedAt: string;
};

const FILE = "data/leads.json";

async function readLeads(): Promise<Lead[]> {
  try {
    const file = Bun.file(FILE);
    if (!(await file.exists())) return [];
    const text = await file.text();
    if (!text.trim()) return [];
    return JSON.parse(text) as Lead[];
  } catch {
    return [];
  }
}

async function writeLeads(leads: Lead[]): Promise<void> {
  try {
    mkdirSync("data", { recursive: true });
  } catch {}
  await Bun.write(FILE, JSON.stringify(leads, null, 2));
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function upsertLead(opts: {
  domain: string;
  siteName: string;
  emails?: string[];
  phones?: string[];
  name?: string | null;
  lastName?: string | null;
  company?: string | null;
  topic?: string | null;
  sessionId?: string | null;
}): Promise<Lead> {
  const emails = Array.from(new Set((opts.emails || []).filter(Boolean)));
  const phones = Array.from(new Set((opts.phones || []).filter(Boolean)));
  const leads = await readLeads();

  const match = leads.find((l) =>
    l.emails.some((e) => emails.includes(e)) || l.phones.some((p) => phones.includes(p))
  );

  const now = new Date().toISOString();
  if (match) {
    // Merge
    match.emails = Array.from(new Set([...match.emails, ...emails]));
    match.phones = Array.from(new Set([...match.phones, ...phones]));
    if (opts.name && (!match.name || match.name.length < 2)) match.name = opts.name;
    if (opts.lastName && (!match.lastName || match.lastName.length < 2)) match.lastName = opts.lastName;
    if (opts.company && (!match.company || match.company.length < 2)) match.company = opts.company;
    if (opts.topic) match.topics = Array.from(new Set([...(match.topics || []), opts.topic]));
    if (opts.sessionId) match.sessions = Array.from(new Set([...(match.sessions || []), opts.sessionId]));
    match.updatedAt = now;
    await writeLeads(leads);
    return match;
  }

  const lead: Lead = {
    id: makeId(),
    domain: opts.domain,
    siteName: opts.siteName,
    emails,
    phones,
    name: opts.name || null,
    lastName: opts.lastName || null,
    company: opts.company || null,
    topics: opts.topic ? [opts.topic] : [],
    sessions: opts.sessionId ? [opts.sessionId] : [],
    createdAt: now,
    updatedAt: now,
  };
  leads.push(lead);
  await writeLeads(leads);
  return lead;
}
