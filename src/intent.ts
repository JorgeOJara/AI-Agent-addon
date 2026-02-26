export type Intent =
  | "owner"
  | "services"
  | "about"
  | "value" 
  | "name"
  | "mission"
  | "location"
  | "address"
  | "hours"
  | "phone"
  | "email"
  | "pricing"
  | "greeting"
  | "other";

export function detectIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(hi|hello|hey|good (morning|afternoon|evening))\b/.test(m)) return "greeting";
  if (/(owner|owner\/?operator|founder|ceo|operator|who (runs|owns))/i.test(message)) return "owner";
  if (/\b(services?|what do you do|offer|provide|main services)\b/.test(m)) return "services";
  // Treat "build a new site/website" and "redesign website" as services intent
  if (/(build|create|make)\s+(a|an|new)\s+(site|website)|\bnew\s+(site|website)\b|\bredesign(ing)?\s+(my|our)?\s*(site|website)/i.test(message)) return "services";
  if (/\b(about|tell me more|more details|more info|elaborate|expand|continue|learn more|know more|more about|describe more)\b/.test(m)) return "about";
  // Value/why-choose intent (comparisons, differentiators, pros)
  if (/((why\s+(would\s+i\s+)?)?(choose|pick|go with|select)\s+(you|your|[a-z0-9 .-]+)|\bwhy us\b|why\s+.*\s+(you|your)|\b(benefits|advantages|pros)\b|\b(vs\.?|versus|better than others|compared to others|instead of others|over others|over competitors)\b)/i.test(message)) return "value";
  // Name intent (company/business/website name)
  if (/(what('?| i)s\s+(the\s+)?(business|company|site|website)\s+name|name\s+of\s+(your|the)\s+(business|company|site|website)|what('?| i)s\s+your\s+company\s+called)/i.test(message)) return "name";
  // Mission/goals intent
  if (/(mission|vision|purpose|goal(s)?|what (do|are) you (aim|trying) to (do|achieve))/i.test(m)) return "mission";
  if (/\b(address|street|suite)\b/.test(m)) return "address";
  if (/\b(location|located|where (is|are) you)\b/.test(m)) return "location";
  if (/\b(hours|open|opening|closing|schedule)\b/.test(m)) return "hours";
  if (/\b(phone|call|contact number|telephone)\b/.test(m)) return "phone";
  if (/\b(email|e-mail|contact email|mail)\b/.test(m)) return "email";
  if (/\b(price|pricing|cost|plans?)\b/.test(m)) return "pricing";
  return "other";
}
