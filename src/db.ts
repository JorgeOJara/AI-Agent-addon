import { Database } from "bun:sqlite";

export type SiteFacts = {
  ownerName?: string | null;
  ownerTitle?: string | null;
  phones?: string[];
  emails?: string[];
  addresses?: string[];
  hours?: string | null;
  services?: string[];
};

export type RagChunk = {
  domain: string;
  url: string;
  title: string;
  chunkId: number;
  content: string;
  updatedAt: string;
};

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  db = new Database("data/cache.db");
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_facts (
      domain TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      domain TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, url, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS rag_meta (
      domain TEXT PRIMARY KEY,
      site_name TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function putSiteFacts(domain: string, facts: SiteFacts): void {
  getDb()
    .query(
      `INSERT INTO site_facts (domain, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(domain) DO UPDATE SET
         data = excluded.data,
         updated_at = datetime('now')`
    )
    .run(domain, JSON.stringify(facts));
}

export function getSiteFacts(domain: string): SiteFacts | null {
  const row = getDb()
    .query<{ data: string }, [string]>(`SELECT data FROM site_facts WHERE domain = ?`)
    .get(domain);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function replaceRagChunks(
  domain: string,
  siteName: string | null,
  pages: Array<{ url: string; title: string; chunks: string[] }>
): { pageCount: number; chunkCount: number } {
  const database = getDb();
  const deleteStmt = database.query(`DELETE FROM rag_chunks WHERE domain = ?`);
  const insertStmt = database.query(
    `INSERT INTO rag_chunks (domain, url, title, chunk_id, content, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  const upsertMetaStmt = database.query(
    `INSERT INTO rag_meta (domain, site_name, page_count, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(domain) DO UPDATE SET
       site_name = excluded.site_name,
       page_count = excluded.page_count,
       chunk_count = excluded.chunk_count,
       indexed_at = datetime('now')`
  );

  let pageCount = 0;
  let chunkCount = 0;
  database.transaction(() => {
    deleteStmt.run(domain);
    for (const page of pages) {
      pageCount += 1;
      for (let i = 0; i < page.chunks.length; i++) {
        insertStmt.run(domain, page.url, page.title || "Untitled", i, page.chunks[i]);
        chunkCount += 1;
      }
    }
    upsertMetaStmt.run(domain, siteName, pageCount, chunkCount);
  })();

  return { pageCount, chunkCount };
}

export function getRagChunks(domain: string): RagChunk[] {
  return getDb()
    .query<RagChunk, [string]>(
      `SELECT domain, url, title, chunk_id as chunkId, content, updated_at as updatedAt
       FROM rag_chunks
       WHERE domain = ?
       ORDER BY url, chunk_id`
    )
    .all(domain);
}

export function getRagMeta(domain: string): {
  domain: string;
  siteName: string | null;
  pageCount: number;
  chunkCount: number;
  indexedAt: string;
} | null {
  const row = getDb()
    .query<{ domain: string; site_name: string | null; page_count: number; chunk_count: number; indexed_at: string }, [string]>(
      `SELECT domain, site_name, page_count, chunk_count, indexed_at FROM rag_meta WHERE domain = ?`
    )
    .get(domain);
  if (!row) return null;
  return {
    domain: row.domain,
    siteName: row.site_name,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    indexedAt: row.indexed_at,
  };
}
