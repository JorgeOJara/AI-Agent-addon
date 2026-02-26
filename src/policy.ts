export function getRefusalMessage(site: string): string {
  return `I can’t help with that topic, but I’m happy to talk about ${site}. Would you like details on services, pricing, contact, examples, or something else about the website?`;
}

// Optional env-based strictness toggle
export const STRICT_TOPIC_GUARD = (process.env.STRICT_TOPIC_GUARD ?? "true").toLowerCase() === "true";

export function getInsufficientInfoMessage(): string {
  return "I don't have enough information from the website to answer that. Would you like a quick overview or a link to a relevant page?";
}
