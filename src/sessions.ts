export type SessionState = {
  id: string;
  domain: string;
  siteName: string;
  emails: string[];
  phones: string[];
  name?: string | null;
  lastName?: string | null;
  company?: string | null;
  topics: string[];
  reconComplete: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
};

const FILE = "data/sessions.json";

async function readAll(): Promise<Record<string, SessionState>> {
  try {
    const f = Bun.file(FILE);
    if (!(await f.exists())) return {};
    const t = await f.text();
    if (!t.trim()) return {};
    return JSON.parse(t) as Record<string, SessionState>;
  } catch {
    return {};
  }
}

async function writeAll(map: Record<string, SessionState>): Promise<void> {
  await Bun.write(FILE, JSON.stringify(map, null, 2));
}

export async function getSession(id: string, domain: string, siteName: string): Promise<SessionState> {
  const map = await readAll();
  let s = map[id];
  if (!s) {
    const now = new Date().toISOString();
    s = map[id] = {
      id,
      domain,
      siteName,
      emails: [],
      phones: [],
      topics: [],
      reconComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    await writeAll(map);
  }
  return s;
}

export async function updateSession(id: string, updater: (s: SessionState) => void): Promise<SessionState> {
  const map = await readAll();
  let s = map[id];
  if (!s) throw new Error("session not found");
  updater(s);
  s.updatedAt = new Date().toISOString();
  map[id] = s;
  await writeAll(map);
  return s;
}

export function computeReconComplete(s: SessionState): boolean {
  const hasContact = (s.emails?.length || 0) > 0 || (s.phones?.length || 0) > 0;
  const hasTopic = (s.topics?.length || 0) > 0;
  const hasName = !!(s.name && s.name.length > 0);
  const hasLast = !!(s.lastName && s.lastName.length > 0);
  const hasCompany = !!(s.company && s.company.length > 1);
  return hasContact && hasTopic && hasName && hasLast && hasCompany;
}

