import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { answerWithContext, streamAnswerWithContext } from "./chat";
import { validateChatInput } from "./middleware";
import { resolveSiteId } from "./resolver";
import { getRagMeta, getSiteFacts, type SiteFacts } from "./db";
import { detectIntent } from "./intent";
import { isTriviaRequest } from "./topic";
import { getRefusalMessage, getInsufficientInfoMessage } from "./policy";
import { extractContactInfo, detectContactIntent, hasContact, extractContactFromHistory, mergeContactInfo, extractTopicHint, extractName, extractNameFromHistory, splitNameParts, extractCompany, extractTopicsFromHistory } from "./contact";
import { upsertLead } from "./leads";
import { getSession, updateSession, computeReconComplete } from "./sessions";
import { buildRagIndex, ensureRagIndex, isLikelyOnTopic, retrieveRagContext } from "./rag";
import { getConfiguredDomain, getConfiguredSiteName } from "./config";

type ChatTurn = { role: "user" | "assistant"; content: string };
type AppVars = {
  message: string;
  siteId: string;
  history: ChatTurn[];
  sessionId?: string;
};

const app = new Hono<{ Variables: AppVars }>();
const PORT = parseInt(process.env.PORT || "5555");
const HOST = process.env.HOST || "0.0.0.0";
const SITE_DOMAIN = getConfiguredDomain();
const SITE_NAME = getConfiguredSiteName();
const ENV = (process.env.APP_ENV || process.env.NODE_ENV || "development").toLowerCase();
const SERVE_STATIC = (process.env.SERVE_STATIC ?? (ENV === "development" ? "true" : "false")).toLowerCase() === "true";

// ── CORS ───────────────────────────────────────────────────
// Allow configuration via env var; default to permissive for easy integration
// Examples:
//   CORS_ORIGIN="*"                            -> allow all origins
//   CORS_ORIGIN="https://a.com,https://b.com"  -> allow specific origins
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*"; // non-browser clients (curl, server-to-server)
      if (CORS_ORIGIN === "*") return origin;
      const allowed = CORS_ORIGIN.split(",").map((s) => s.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-API-Key"],
    credentials: true,
  })
);

// ── State ──────────────────────────────────────────────────
let indexing = false;
let ragReady = false;
let ragBootstrapError: string | null = null;

// ── API routes ─────────────────────────────────────────────
app.get("/api/status", (c) =>
  c.json({
    indexing,
    ragReady,
    ragBootstrapError,
    siteName: SITE_NAME,
    siteDomain: SITE_DOMAIN,
    rag: getRagMeta(SITE_DOMAIN),
  })
);

// ── Optional API key protection ────────────────────────────
// If API_KEY is set, require it for all /api/* routes except /api/status
const API_KEY = process.env.API_KEY;
if (API_KEY) {
  app.use("/api/*", async (c, next) => {
    // Allow the status route without a key
    if (c.req.path === "/api/status") return next();
    const provided = c.req.header("x-api-key") || c.req.header("X-API-Key");
    if (provided !== API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}

app.post("/api/scrape", async (c) => {
  if (indexing) return c.json({ error: "Already indexing" }, 409);
  indexing = true;
  try {
    const out = await buildRagIndex(SITE_DOMAIN, SITE_NAME);
    ragReady = out.chunkCount > 0;
    ragBootstrapError = ragReady ? null : "RAG index has zero chunks.";
    return c.json({ ok: true, pages: out.pageCount, chunks: out.chunkCount, domain: out.domain });
  } catch (err: any) {
    console.error("[server] Index error:", err);
    ragReady = false;
    ragBootstrapError = err?.message || "RAG indexing failed";
    return c.json({ error: err.message }, 500);
  } finally {
    indexing = false;
  }
});

// Build/update RAG index without a chat message
app.post("/api/prep", async (c) => {
  try {
    const body = await c.req.json<{ siteId?: string; force?: boolean }>();
    const siteId = (body.siteId || "").trim();
    if (!siteId) return c.json({ error: "siteId is required" }, 400);
    const resolved = await resolveSiteId(siteId);
    const domain = resolved.domain;
    const siteName = resolved.siteName || SITE_NAME;
    const prep = await ensureRagIndex(domain, siteName, !!body.force || resolved.updated);
    ragReady = prep.chunkCount > 0;
    ragBootstrapError = ragReady ? null : "RAG index has zero chunks.";
    return c.json({
      ok: true,
      domain,
      siteName: prep.siteName,
      pageCount: prep.pageCount,
      chunkCount: prep.chunkCount,
      indexedAt: prep.indexedAt,
      rebuilt: prep.built,
    });
  } catch (e: any) {
    ragReady = false;
    ragBootstrapError = e?.message || "prep failed";
    return c.json({ error: e.message || "prep failed" }, 500);
  }
});

// New chat endpoint: accepts { message, siteId, history? }
app.post("/api/chat", validateChatInput, async (c) => {
  const message = c.get("message") as string;
  const siteId = c.get("siteId") as string;
  const chatHistory = c.get("history") as { role: "user" | "assistant"; content: string }[];
  const sessionId = (c.get("sessionId") as string) || undefined;

  // Translate siteId to domain via resolver (mocked for now)
  const resolved = await resolveSiteId(siteId);
  const domain = resolved.domain;
  const siteName = resolved.siteName || SITE_NAME;
  const session = sessionId ? await getSession(sessionId, domain, siteName) : null;

  // Inference must not scrape. Use indexed chunks only; if missing, return a prep-required error.
  const ragMeta = getRagMeta(domain);
  if (!ragMeta || ragMeta.chunkCount === 0) {
    return c.json({ error: ragBootstrapError || "Site not prepared. Please call /api/prep with this siteId to build the RAG index, then try again." }, 412);
  }
  const rag = retrieveRagContext(domain, message);
  const ragContext = rag.context;

  // Collect facts + intent to guide the model (no pre-baked responses)
  const facts = getSiteFacts(domain) || null;
  const intent = detectIntent(message);
  // Limit history to last 6 exchanges to reduce payload/latency
  const shortHistory = Array.isArray(chatHistory) ? chatHistory.slice(-6) : [];
  const contact = extractContactInfo(message);
  const priorContact = extractContactFromHistory(shortHistory);
  const knownContact = hasContact(mergeContactInfo({ emails: [], phones: [] }, mergeContactInfo(priorContact, contact)));
  const wantsContact = detectContactIntent(message) || hasContact(contact);
  if (hasContact(contact)) {
    console.log(
      "[contact] Request captured:",
      JSON.stringify({ domain, siteName, message, emails: contact.emails, phones: contact.phones, ts: new Date().toISOString() })
    );
    const name = extractName(message) || extractNameFromHistory(chatHistory);
    const company = extractCompany(message) || null;
    const { first, last } = splitNameParts(name || undefined);
    await upsertLead({ domain, siteName, emails: contact.emails, phones: contact.phones, name: first || name, lastName: last || null, company, sessionId });
    if (session) await updateSession(session.id, (s) => {
      s.emails = Array.from(new Set([...(s.emails || []), ...contact.emails]));
      s.phones = Array.from(new Set([...(s.phones || []), ...contact.phones]));
      if (first && !s.name) s.name = first;
      if (last && !s.lastName) s.lastName = last;
      if (company && !s.company) s.company = company;
    });
  }
  if (!hasContact(contact) && knownContact) {
    const topic = extractTopicHint(message);
    if (topic) {
      console.log(
        "[contact] Update captured:",
        JSON.stringify({ domain, siteName, topic, ts: new Date().toISOString() })
      );
      const merged = mergeContactInfo(priorContact, contact);
      const name = extractNameFromHistory(chatHistory);
      const company = extractCompany(message) || null;
      const { first, last } = splitNameParts(name || undefined);
      await upsertLead({ domain, siteName, emails: merged.emails, phones: merged.phones, name: first || name, lastName: last || null, company, topic, sessionId });
      if (session) await updateSession(session.id, (s) => {
        s.topics = Array.from(new Set([...(s.topics || []), topic]));
        if (company && !s.company) s.company = company;
      });
    }
  }

  // After updates, if we have a session, recompute reconComplete
  let reconComplete = false;
  if (session) {
    const s = await getSession(session.id, domain, siteName);
    reconComplete = computeReconComplete(s);
    if (reconComplete && !s.reconComplete) {
      await updateSession(session.id, (st) => {
        st.reconComplete = true;
        st.completedAt = new Date().toISOString();
      });
      console.log("[contact] Recon complete:", JSON.stringify({ sessionId: session.id, domain, siteName }));
    }
  }

  // Guard trivial/unknowable requests (e.g., "tell me something I don't know")
  if (isTriviaRequest(message)) {
    return c.json({ reply: "I don't have enough information from the website to answer that. Could I share a quick overview or help with something specific?", domain });
  }

  // Deterministic owner reply to avoid model drift on role/name questions.
  if (intent === "owner" && facts?.ownerName) {
    const title = facts.ownerTitle ? facts.ownerTitle.replace(/\s+/g, " ").trim() : "owner";
    return c.json({ reply: `We are led by ${facts.ownerName}, our ${title}.`, domain });
  }

  // If the user provided contact details or asked to talk, acknowledge and skip the model
  if (wantsContact) {
    const ack = `Thanks — I’ll pass your contact to the ${siteName} team so they can reach out. If you have a preferred time or topic, let me know here.`;
    return c.json({ reply: ack, domain });
  }

  // Guard: refuse unrelated questions before calling the model (allow contact messages)
  if (intent === "other" && !isLikelyOnTopic(domain, message) && !wantsContact) {
    return c.json({ reply: getRefusalMessage(siteName), domain });
  }

  // Determine recon state from history
  const haveName = !!(extractNameFromHistory(chatHistory));
  const priorTopics = extractTopicsFromHistory(chatHistory);
  const haveTopic = priorTopics.length > 0 || !!extractTopicHint(message);
  // prefer session boolean if available
  reconComplete = session ? (await getSession(session.id, domain, siteName)).reconComplete : (knownContact && haveTopic && haveName);

  let extras = buildExtraInstructions(intent, siteName) || "";
  if (reconComplete) {
    extras += " NO_CTA. From now on, do not ask for any contact details. Simply answer questions about the business.";
  } else if (knownContact) {
    // Ask for missing pieces only
    extras += " NO_CTA. Do not ask for email or phone again. ";
    if (!haveName) extras += "Ask once, casually: 'Sorry—what's your name so I can let the team know?' Keep it to one short line. ";
    if (!haveTopic) extras += "Ask once, casually: 'What would you like to discuss?' Keep it short. ";
  }
  const followupSuggestion = buildFollowupTail({ knownContact, haveTopic, haveName, haveCompany: !!(session && (session as any).company), intent });
  if (followupSuggestion) {
    extras += ` Add ONE short follow-up sentence at the end: '${followupSuggestion}'. Integrate naturally. Do not repeat earlier asks.`;
  }
  const factsHint = facts ? factsToHint(facts) : undefined;
  let reply = await answerWithContext(
    ragContext,
    message,
    shortHistory,
    siteName,
    extras,
    factsHint,
    0.05
  );
  return c.json({ reply, domain });
});

// Streaming chat endpoint for faster perceived latency
app.post("/api/chat/stream", validateChatInput, async (c) => {
  const message = c.get("message") as string;
  const siteId = c.get("siteId") as string;
  const history = c.get("history") as { role: "user" | "assistant"; content: string }[];
  const shortHistory = Array.isArray(history) ? history.slice(-6) : [];

  const resolved = await resolveSiteId(siteId);
  const domain = resolved.domain;
  const siteName = resolved.siteName || SITE_NAME;

  const ragMeta = getRagMeta(domain);
  if (!ragMeta || ragMeta.chunkCount === 0) {
    return c.json({ error: ragBootstrapError || "Site not prepared. Please call /api/prep with this siteId to build the RAG index, then try again." }, 412);
  }
  const rag = retrieveRagContext(domain, message);
  const ragContext = rag.context;

  // Same guards as non-streaming for quick rejects
  const facts = getSiteFacts(domain) || null;
  const intent = detectIntent(message);
  const contact = extractContactInfo(message);
  const priorContact = extractContactFromHistory(shortHistory);
  const sessionId = (c.get("sessionId") as string) || undefined;
  const session = sessionId ? await getSession(sessionId, domain, siteName) : null;
  const knownContact = hasContact(mergeContactInfo({ emails: [], phones: [] }, mergeContactInfo(priorContact, contact)));
  const wantsContact = detectContactIntent(message) || hasContact(contact);
  if (hasContact(contact)) {
    console.log(
      "[contact] Request captured:",
      JSON.stringify({ domain, siteName, message, emails: contact.emails, phones: contact.phones, ts: new Date().toISOString() })
    );
    const name = extractName(message) || extractNameFromHistory(history);
    const company = extractCompany(message) || null;
    const { first, last } = splitNameParts(name || undefined);
    await upsertLead({ domain, siteName, emails: contact.emails, phones: contact.phones, name: first || name, lastName: last || null, company, sessionId });
    if (session) await updateSession(session.id, (s) => {
      s.emails = Array.from(new Set([...(s.emails || []), ...contact.emails]));
      s.phones = Array.from(new Set([...(s.phones || []), ...contact.phones]));
      if (first && !s.name) s.name = first;
      if (last && !s.lastName) s.lastName = last;
      if (company && !s.company) s.company = company;
    });
  }
  if (!hasContact(contact) && knownContact) {
    const topic = extractTopicHint(message);
    if (topic) {
      console.log(
        "[contact] Update captured:",
        JSON.stringify({ domain, siteName, topic, ts: new Date().toISOString() })
      );
      const merged = mergeContactInfo(priorContact, contact);
      const name = extractNameFromHistory(history);
      const company = extractCompany(message) || null;
      const { first, last } = splitNameParts(name || undefined);
      await upsertLead({ domain, siteName, emails: merged.emails, phones: merged.phones, name: first || name, lastName: last || null, company, topic, sessionId });
      if (session) await updateSession(session.id, (s) => {
        s.topics = Array.from(new Set([...(s.topics || []), topic]));
        if (company && !s.company) s.company = company;
      });
    }
  }

  // Compute reconComplete (prefer persisted flag)
  let reconComplete2 = false;
  if (session) {
    const s = await getSession(session.id, domain, siteName);
    reconComplete2 = computeReconComplete(s);
    if (reconComplete2 && !s.reconComplete) {
      await updateSession(session.id, (st) => {
        st.reconComplete = true;
        st.completedAt = new Date().toISOString();
      });
      console.log("[contact] Recon complete:", JSON.stringify({ sessionId: session.id, domain, siteName }));
    }
  }
  if (isTriviaRequest(message)) {
    // For the streaming endpoint, return plain text so the client doesn't render a JSON object
    const msg = getInsufficientInfoMessage();
    return c.body(msg, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  if (intent === "owner" && facts?.ownerName) {
    const title = facts.ownerTitle ? facts.ownerTitle.replace(/\s+/g, " ").trim() : "owner";
    return c.body(`We are led by ${facts.ownerName}, our ${title}.`, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  // If the user provided contact details or asked to talk, acknowledge with plain text
  if (wantsContact) {
    const ack = `Thanks — I’ll pass your contact to the ${siteName} team so they can reach out. If you have a preferred time or topic, let me know here.`;
    return c.body(ack, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  if (intent === "other" && !isLikelyOnTopic(domain, message) && !wantsContact) {
    // Return plain text refusal for streaming path
    const msg = getRefusalMessage(siteName);
    return c.body(msg, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }

  const haveName2 = !!(extractNameFromHistory(shortHistory));
  const priorTopics2 = extractTopicsFromHistory(shortHistory);
  const haveTopic2 = priorTopics2.length > 0 || !!extractTopicHint(message);
  reconComplete2 = session ? (await getSession(session.id, domain, siteName)).reconComplete : (knownContact && haveTopic2 && haveName2);

  let extras = buildExtraInstructions(intent, siteName) || "";
  if (reconComplete2) {
    extras += " NO_CTA. From now on, do not ask for any contact details. Simply answer questions about the business.";
  } else if (knownContact) {
    extras += " NO_CTA. Do not ask for email or phone again. ";
    if (!haveName2) extras += "Ask once, casually: 'Sorry—what's your name so I can let the team know?' Keep it to one short line. ";
    if (!haveTopic2) extras += "Ask once, casually: 'What would you like to discuss?' Keep it short. ";
  }

  // Provide follow-up suggestion to the model via instructions
  const followupSuggestion2 = buildFollowupTail({ knownContact, haveTopic: haveTopic2, haveName: haveName2, haveCompany: !!(session && (session as any).company), intent });
  if (followupSuggestion2) {
    extras += ` Add ONE short follow-up sentence at the end: '${followupSuggestion2}'. Integrate naturally. Do not repeat earlier asks.`;
  }
  const factsHint = facts ? factsToHint(facts) : undefined;
  try {
    const tail = undefined; // handled by model via extras
    const stream = await streamAnswerWithContext(
      ragContext,
      message,
      shortHistory,
      siteName,
      extras,
      factsHint,
      tail,
    );
    return c.body(stream, 200, { "Content-Type": "text/plain; charset=utf-8" });
  } catch (e: any) {
    return c.json({ error: e?.message || "stream failed" }, 500);
  }
});

function buildExtraInstructions(intent: ReturnType<typeof detectIntent>, siteLabel?: string): string | undefined {
  switch (intent) {
    case "owner":
      return "If a person is identified as owner/founder/CEO/operator, answer in one sentence: 'We are led by <Name>, our <title>.'";
    case "services":
      return "List the main services in a short, readable list (comma-separated or bullets). Avoid long paragraphs.";
    case "value":
      return "Briefly explain why to choose us: 3–5 concise points based only on the site's content (e.g., expertise, responsiveness, locality, guarantees, stack). Avoid marketing fluff and keep each point to one short sentence.";
    case "name":
      return siteLabel ? `Return exactly this business name on one line: "${siteLabel}"` : "Return the business name on one short line.";
    case "mission":
      return "Summarize our mission/goals in 1–2 short sentences using only the site's content (about, services, value). Avoid generic filler.";
    case "address":
      return "If a full street address exists, return it on one line. If not, return city and state (e.g., 'We are in City, State').";
    case "location":
      return "Return city and state (and street address if available) in one line.";
    case "phone":
      return "Return phone numbers separated by commas.";
    case "email":
      return "Return email addresses separated by commas.";
    case "hours":
      return "Return business hours on one line if available.";
    case "pricing":
      return "If pricing or plans exist, summarize briefly; otherwise invite the user to contact for a quote.";
    case "about":
      return "Provide a 1–2 sentence overview of what we do and who we serve.";
    default:
      return undefined;
  }
}

function factsToHint(f: SiteFacts): string | undefined {
  const lines: string[] = [];
  if (f.ownerName) lines.push(`Owner: ${f.ownerName}${f.ownerTitle ? ` (${f.ownerTitle})` : ""}`);
  if (f.services?.length) lines.push(`Services: ${f.services.slice(0, 8).join(", ")}`);
  if (f.phones?.length) lines.push(`Phone: ${f.phones.join(", ")}`);
  if (f.emails?.length) lines.push(`Email: ${f.emails.join(", ")}`);
  if (f.addresses?.length) lines.push(`Address: ${f.addresses.join(" | ")}`);
  if (f.hours) lines.push(`Hours: ${f.hours}`);
  return lines.length ? lines.join("\n") : undefined;
}

function buildFollowupTail(opts: {
  knownContact: boolean;
  haveTopic: boolean;
  haveName: boolean;
  haveCompany: boolean;
  intent: string;
}): string | undefined {
  if (!opts.knownContact) {
    return "If you'd like, share your email or phone and what you'd like to discuss, and I’ll make sure the team reaches out.";
  }
  if (!opts.haveTopic) {
    if (opts.intent === "pricing") {
      return "Quick one — is this for a new build or a redesign, and do you have a timeline or budget in mind?";
    }
    return "Quick one — what would you like to discuss (new site, redesign, SEO, maintenance)?";
  }
  if (!opts.haveName || !opts.haveCompany) {
    return "Could you share your name and company so I can pass it to the team?";
  }
  return undefined;
}

// ── Static files (optional) ────────────────────────────────
if (SERVE_STATIC) {
  app.use("/*", serveStatic({ root: "./public" }));
}

let lastNightlyRefreshDay = "";

async function refreshRag(domain: string, siteName: string, force: boolean) {
  if (indexing) return;
  indexing = true;
  try {
    const out = await ensureRagIndex(domain, siteName, force);
    ragReady = out.chunkCount > 0;
    ragBootstrapError = ragReady ? null : "RAG index has zero chunks.";
    console.log(`[rag] ${out.built ? "indexed" : "cached"} domain=${domain} pages=${out.pageCount} chunks=${out.chunkCount}`);
  } catch (err) {
    ragReady = false;
    ragBootstrapError = err instanceof Error ? err.message : String(err);
    console.error("[rag] refresh failed:", err);
  } finally {
    indexing = false;
  }
}

function startNightlyRefresh(domain: string, siteName: string) {
  const maybeRun = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === 1 && now.getMinutes() === 0 && day !== lastNightlyRefreshDay) {
      lastNightlyRefreshDay = day;
      await refreshRag(domain, siteName, true);
    }
  };
  setInterval(() => {
    void maybeRun();
  }, 60_000);
}

function startBootstrapRetry(domain: string, siteName: string) {
  setInterval(() => {
    if (!ragReady && !indexing) void refreshRag(domain, siteName, true);
  }, 5 * 60_000);
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 120,
});

console.log(`[server] Env: ${ENV}; Static frontend ${SERVE_STATIC ? "enabled" : "disabled (API only)"}`);

console.log(`
┌─────────────────────────────────────────────┐
│  AI Site Chatbot running on port ${PORT}        │
│  Site: ${SITE_NAME.padEnd(36)}│
│  Domain: ${SITE_DOMAIN.slice(0, 34).padEnd(34)}│
│  Status: RAG mode (nightly refresh 01:00)   │
└─────────────────────────────────────────────┘
`);

// Keep server available immediately; bootstrap indexing in background.
void refreshRag(SITE_DOMAIN, SITE_NAME, true);
startNightlyRefresh(SITE_DOMAIN, SITE_NAME);
startBootstrapRetry(SITE_DOMAIN, SITE_NAME);
