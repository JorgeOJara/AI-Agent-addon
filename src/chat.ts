import { getInsufficientInfoMessage, getRefusalMessage } from "./policy";
import { topicScore } from "./topic";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "localhost";
const OLLAMA_PORT = process.env.OLLAMA_PORT || "11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || "8192");
const OLLAMA_NUM_PREDICT = parseInt(process.env.OLLAMA_NUM_PREDICT || "180");
const OLLAMA_NUM_THREAD = parseInt(process.env.OLLAMA_NUM_THREAD || "0");
const RULES_FILE = process.env.AI_RULES_FILE || "data/ai-rules.txt";

const CONTACT_POLICY_ENABLE = (process.env.CONTACT_POLICY_ENABLE ?? "true").toLowerCase() === "true";
const CONTACT_CTA_LINE =
  process.env.CONTACT_CTA_LINE ||
  "If you'd like, share your email or phone and what you'd like to discuss, and I’ll make sure the team reaches out.";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

async function loadAiRules(): Promise<string> {
  try {
    const file = Bun.file(RULES_FILE);
    if (!(await file.exists())) return "";
    return (await file.text()).trim();
  } catch {
    return "";
  }
}

function buildSystemPrompt(
  context: string,
  site: string,
  extraInstructions?: string,
  factsHint?: string,
  aiRules?: string
) {
  const contactRules = CONTACT_POLICY_ENABLE
    ? `\nContact Policy:\n- If the user provides an email or phone number, acknowledge once and confirm you will pass it to the ${site} team. Optionally ask for preferred time and topic.\n- At the end of every response, append exactly one short line: '${CONTACT_CTA_LINE}'.\n- Exception: If Additional Instructions include 'NO_CTA', do not append that invite line.\n`
    : "";
  const topicRules = `\nTopic Guard:\n- Answer only questions about ${site} and the RAG CONTEXT.\n- If the question is unrelated, respond with exactly: '${getRefusalMessage(site)}'\n`;

  return `You are a customer service representative for "${site}".

Goals:
- Help the customer with clear, professional, first-person answers.
- Use only the RAG CONTEXT and FACTS provided. Do not invent details.
- If information is missing, say: "I don't have enough information to answer that."

Style:
- First person voice.
- Be concise and helpful.

${aiRules ? `AI RULES (strict):\n${aiRules}\n\n` : ""}${factsHint ? `FACTS (prefer these if present):\n${factsHint}\n\n` : ""}${topicRules}${contactRules}${extraInstructions ? `Additional Instructions:\n${extraInstructions}\n\n` : ""}RAG CONTEXT:\n${context}`;
}

function expandQuestion(msg: string): string {
  const lower = msg.toLowerCase();
  const hints: string[] = [];
  if (/\bceo\b/.test(lower)) hints.push('(Note: the site may use "Owner", "Operator", or "Founder" instead of "CEO")');
  if (/\bfounder\b/.test(lower)) hints.push('(Note: the site may use "Owner" or "Operator" instead of "Founder")');
  if (/\blocation\b|\bwhere\b|\baddress\b/.test(lower)) hints.push("(Note: check for city, state, or street address)");
  if (/\bphone\b|\bcall\b/.test(lower)) hints.push("(Note: look for phone numbers or contact info)");
  if (/\bpric/.test(lower)) hints.push('(Note: the site may use "plans", "packages", or "cost")');
  return hints.length ? `${msg}\n${hints.join(" ")}` : msg;
}

function polishReply(text: string): string {
  if (!text) return text;
  const banned: RegExp[] = [
    /as an ai[, ]?/gi,
    /based on (my|the) training data/gi,
    /i (cannot|can't) browse/gi,
    /my knowledge (cut[- ]?off|is limited)/gi,
    /according to (the |our )?(website|site|provided (content|context))/gi,
  ];
  for (const rx of banned) text = text.replace(rx, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

export async function answerWithContext(
  siteContext: string,
  userMessage: string,
  history: ChatMessage[] = [],
  site = "the website",
  extraInstructions?: string,
  factsHint?: string,
  minSupportOverride?: number
): Promise<string> {
  const ollamaUrl = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;
  const aiRules = await loadAiRules();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(siteContext, site, extraInstructions, factsHint, aiRules) },
    ...history,
    { role: "user", content: expandQuestion(userMessage) },
  ];

  try {
    const res = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        keep_alive: -1,
        options: {
          temperature: 0.2,
          num_ctx: OLLAMA_NUM_CTX,
          num_predict: OLLAMA_NUM_PREDICT,
          ...(OLLAMA_NUM_THREAD > 0 ? { num_thread: OLLAMA_NUM_THREAD } : {}),
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[chat] Ollama error: ${res.status} ${errText}`);
      return "Sorry, I'm having trouble connecting to the AI model. Please try again later.";
    }

    const data = (await res.json()) as { message?: { content?: string }; error?: string; response?: string; content?: string };
    const raw = data.message?.content || data.response || data.content || "";
    if (!raw) return getInsufficientInfoMessage();
    const polished = polishReply(raw);
    const support = topicScore(polished, siteContext);
    const minSupport = typeof minSupportOverride === "number" ? minSupportOverride : parseFloat(process.env.MIN_ANSWER_SUPPORT || "0.08");
    if (support < minSupport && polished.length === 0) return getInsufficientInfoMessage();
    return polished;
  } catch (err) {
    console.error("[chat] Error:", err);
    return "Sorry, I couldn't reach the AI model. Make sure Ollama is running.";
  }
}

export async function streamAnswerWithContext(
  siteContext: string,
  userMessage: string,
  history: ChatMessage[] = [],
  site = "the website",
  extraInstructions?: string,
  factsHint?: string,
  tailPostfix?: string
): Promise<ReadableStream<Uint8Array>> {
  const ollamaUrl = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat`;
  const aiRules = await loadAiRules();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(siteContext, site, extraInstructions, factsHint, aiRules) },
    ...history,
    { role: "user", content: expandQuestion(userMessage) },
  ];

  const res = await fetch(ollamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      keep_alive: -1,
      options: {
        temperature: 0.2,
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: OLLAMA_NUM_PREDICT,
        ...(OLLAMA_NUM_THREAD > 0 ? { num_thread: OLLAMA_NUM_THREAD } : {}),
      },
    }),
  });

  if (!res.ok || !res.body) {
    const errText = res.body ? await res.text() : "no body";
    throw new Error(`Ollama error: ${res.status} ${errText}`);
  }

  const reader = res.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim().length) {
          try {
            const evt = JSON.parse(buffer);
            const txt = evt?.message?.content || "";
            if (txt) controller.enqueue(encoder.encode(txt));
          } catch {}
        }
        if (tailPostfix && tailPostfix.trim().length) controller.enqueue(encoder.encode(`\n\n${tailPostfix}`));
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          const evt = JSON.parse(s);
          const txt = evt?.message?.content || "";
          if (txt) controller.enqueue(encoder.encode(txt));
        } catch {}
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
