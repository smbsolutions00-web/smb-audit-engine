/**
 * Shared DataForSEO HTTP-Basic auth helper. Both the Google Ads keyword
 * client and the live SERP validator use these credentials, so the
 * sanitization rules (BOM / quotes / whitespace) live in one place.
 */

export function cleanSecret(v?: string): string {
  if (!v) return "";
  let s = v.replace(/^\uFEFF/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function dataForSeoAuthHeader(): string {
  const login = cleanSecret(process.env.DATAFORSEO_LOGIN);
  const password = cleanSecret(process.env.DATAFORSEO_PASSWORD);
  const token = Buffer.from(`${login}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

export function isDataForSeoEnabled(): boolean {
  return !!(cleanSecret(process.env.DATAFORSEO_LOGIN) && cleanSecret(process.env.DATAFORSEO_PASSWORD));
}
