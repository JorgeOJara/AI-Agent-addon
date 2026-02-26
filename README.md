# AI Scrapper Inference API

RAG-powered API for answering website questions with an Ollama model.

It crawls a domain, builds a SQLite-backed retrieval index, and answers chat questions using only retrieved site context plus extracted business facts.

## Features

- Full-site crawling with sitemap support
- RAG chunk indexing in SQLite
- Nightly auto re-scrape/reindex at `1:00 AM` (server local time)
- Ollama-backed inference (`/api/chat` + `/api/chat/stream`)
- Contact capture (email/phone/name/topic) and session tracking
- Queue-safe frontend chat UI

## Stack

- Runtime: Bun
- API framework: Hono
- Scraping: Cheerio + fetch
- Storage: SQLite (`data/cache.db`)
- Model inference: Ollama
- Container: Docker Compose

## Quick Start (Docker)

1. Create `.env` (or copy from `.env.example`):

```env
PORT=9191
HOST=0.0.0.0
SITE_NAME=Your Company Name
DOMAINNAME=https://your-domain.com

AI_RULES_FILE=data/ai-rules.txt

OLLAMA_HOST=host.docker.internal
OLLAMA_PORT=11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=180

SCRAPER_MAX_PAGES=0
# Optional forced URLs:
# SCRAPER_EXTRA_URLS=https://your-domain.com/about-us/,https://your-domain.com/contact-us/
```

2. Run:

```bash
docker compose up -d --build
```

3. Check status:

```bash
curl -sS http://127.0.0.1:9191/api/status
```

## API

### `POST /api/chat`

Request:

```json
{
  "siteId": "demo",
  "message": "Tell me about your services",
  "history": [
    { "role": "user", "content": "Hi" },
    { "role": "assistant", "content": "Hello!" }
  ],
  "sessionId": "optional-session-id"
}
```

Response:

```json
{
  "reply": "We offer ...",
  "domain": "https://your-domain.com"
}
```

### `POST /api/chat/stream`

Same request body, streamed text response.

### `GET /api/status`

Returns runtime/index state:

- `indexing`
- `ragReady`
- `ragBootstrapError`
- `rag.pageCount`
- `rag.chunkCount`

### `POST /api/scrape`

Forces a full re-scrape/reindex now.

## How It Works

1. On startup, server comes online immediately.
2. Background bootstrap crawls domain + sitemaps and indexes chunks.
3. Chat retrieves top relevant chunks for each question.
4. Ollama generates response constrained to retrieved context and rules.
5. Nightly refresh reindexes content for latest site updates.

## AI Rules

Edit `data/ai-rules.txt` to control assistant behavior without code changes.

## Local Dev

```bash
bun install
bun run dev
```

## Notes

- Ensure Ollama is running and model is pulled.
- In Docker bridge mode, use `OLLAMA_HOST=host.docker.internal` so the app can reach Ollama on the host.
- `docker compose up -d --build` is enough; the API port is published from `.env` (`PORT`, default `9191`).
- Pages not linked and not in sitemap may not be discovered automatically; use `SCRAPER_EXTRA_URLS`.
