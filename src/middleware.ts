import type { Context, Next } from "hono";

// Basic input validation middleware for chat requests
export async function validateChatInput(c: Context, next: Next) {
  try {
    const body = await c.req.json<{ message?: unknown; siteId?: unknown; history?: unknown; sessionId?: unknown }>();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!message || message.length < 2) {
      return c.json({ error: "A non-empty 'message' is required." }, 400);
    }
    if (message.length > 4000) {
      return c.json({ error: "Message is too long." }, 413);
    }
    if (!siteId) {
      return c.json({ error: "A 'siteId' is required." }, 400);
    }
    // light sanity check: prevent obvious prompt-injection markers from clients
    const lower = message.toLowerCase();
    if (/(ignore (previous|prior) instructions|forget all (rules|instructions))/i.test(lower)) {
      return c.json({ error: "Message contains disallowed content." }, 400);
    }

    // attach validated values for downstream handlers
    c.set("message", message);
    c.set("siteId", siteId);
    c.set("history", (body.history as any) || []);
    if (sessionId) c.set("sessionId", sessionId);
    await next();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
}
