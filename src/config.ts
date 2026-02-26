function normalizeDomain(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "https://example.com";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol).origin;
}

export function getConfiguredDomain(): string {
  return normalizeDomain(process.env.DOMAINNAME || process.env.SITE_DOMAIN || "https://example.com");
}

export function getConfiguredSiteName(): string {
  return process.env.SITE_NAME || "Example Site";
}
