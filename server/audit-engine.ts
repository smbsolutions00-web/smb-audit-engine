/**
 * Audit Engine — orchestrates PDF parsing, CSV parsing, AI extraction,
 * and structured report generation for the SMB Audit Engine.
 */
import Anthropic from "@anthropic-ai/sdk";
import Papa from "papaparse";
// pdf-parse has no proper ESM types; use dynamic import
import type { ReportData, KeywordRow, ListingRow, Grade } from "@shared/schema";

// Anthropic API expects hyphenated IDs. The underscore form is a sandbox-only alias.
// claude-sonnet-4-6 is the latest Sonnet (Feb 2026). Override with ANTHROPIC_MODEL env var.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* -------------------- PDF + CSV parsing -------------------- */

export async function parsePdfBuffer(buf: Buffer): Promise<string> {
  // Lazy-load to avoid pdf-parse's debug-mode auto-test on import
  const pdfParse = (await import("pdf-parse")).default as (b: Buffer) => Promise<{ text: string }>;
  try {
    const result = await pdfParse(buf);
    return (result.text || "").trim();
  } catch (e) {
    console.error("pdf-parse failed:", e);
    return "";
  }
}

export function parseKeysearchCsv(csvText: string): KeywordRow[] {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const rows = (parsed.data as Record<string, string>[]) || [];
  return rows
    .map((r) => {
      const num = (v: string | undefined) => {
        if (!v) return undefined;
        const n = parseFloat(v.replace(/[$,]/g, ""));
        return Number.isFinite(n) ? n : undefined;
      };
      const keyword =
        r["keyword"] || r["query"] || r["term"] || r["search term"] || r["keywords"] || "";
      if (!keyword) return null;
      return {
        keyword: keyword.trim(),
        position: num(r["position"] || r["rank"] || r["pos"]),
        volume: num(r["volume"] || r["search volume"] || r["monthly searches"] || r["sv"]),
        difficulty: num(
          r["difficulty"] || r["kc"] || r["keyword difficulty"] || r["score"] || r["kd"]
        ),
        cpc: num(r["cpc"] || r["bid"] || r["cost"]),
        intent: r["intent"] || r["type"] || undefined,
        url: r["url"] || r["page"] || undefined,
      } as KeywordRow;
    })
    .filter((r): r is KeywordRow => !!r);
}

/* -------------------- AI helpers -------------------- */

let _client: Anthropic | null = null;
export function isLLMAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || _client !== null;
}
function getClient(): Anthropic {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "LLM_UNAVAILABLE: Anthropic API key not configured. Audit auto-generation requires the development environment. Use the Edit Business Info button to enter NAP manually, or run new audits in the dev preview."
    );
  }
  _client = new Anthropic();
  return _client;
}

function extractJson<T>(text: string, fallback: T): T {
  // Find the first {...} or [...] block
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[\[{]/);
  if (start === -1) return fallback;
  const candidate = body.slice(start);
  // Find balanced end
  let depth = 0,
    end = -1,
    inStr = false,
    esc = false;
  const open = candidate[0];
  const close = open === "{" ? "}" : "]";
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return fallback;
  try {
    return JSON.parse(candidate.slice(0, end + 1)) as T;
  } catch (e) {
    console.error("JSON parse failed:", e, candidate.slice(0, 200));
    return fallback;
  }
}

async function chatJSON(systemPrompt: string, userPrompt: string, maxTokens = 4096): Promise<string> {
  const client = getClient();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = message.content.find((b) => b.type === "text");
  return block && "text" in block ? block.text : "";
}

/* -------------------- Extraction prompts -------------------- */

export interface IntakeData {
  clientName?: string;
  contactName?: string;
  ownerFirstName?: string;  // Derived deterministically from contactName via firstNameOf()
  email?: string;
  phone?: string;
  website?: string;
  industry?: string;
  location?: string;        // City/state — brief (e.g. "Frisco, TX")
  address?: string;         // Full street address (NAP)
  city?: string;            // Parsed local city (e.g. "Frisco")
  state?: string;           // Parsed state code or name (e.g. "TX" or "Texas")
  metroArea?: string;       // Dominant metro anchor city (e.g. "Dallas")
  surroundingCities?: string[];  // 3 nearby cities for local-SEO escalation (e.g. ["Plano", "McKinney", "Allen"])
  businessGoals?: string[];
  painPoints?: string[];
  currentTools?: string[];
  budget?: string;
  rawNotes?: string;
}

import { firstNameOf } from "./lib/names";

export async function extractIntake(pdfText: string): Promise<IntakeData> {
  if (!pdfText) return {};
  const sys = `You extract structured client information from intake/onboarding forms and order forms for digital marketing audits. Output ONLY valid JSON. Never include commentary.`;
  const usr = `Extract this client intake/order form into JSON with these keys (NAP fields are CRITICAL — they appear on the audit cover):

- clientName: The business / company name (the legal or DBA name as it appears on the form). REQUIRED if present anywhere in the document.
- contactName: Primary contact person's full name.
- email: Contact email.
- phone: The BUSINESS phone number, formatted as written. Look for labels like "Business Phone", "Company Phone", "Main Line", "Phone", "Tel". REQUIRED if present.
- website: Business website URL.
- industry: Industry / business category (e.g. "HVAC", "Dental", "Roofing").
- location: Brief city/state only (e.g. "Methuen, MA").
- address: FULL street address as a single string — number, street, suite/building/unit, city, state, ZIP. Look for labels like "Business Address", "Mailing Address", "Service Address", "Location", "Street Address". REQUIRED if present anywhere in the document. Do NOT abbreviate; preserve suite/building info.
- city: Just the city portion of the address (e.g. "Frisco").
- state: Just the state portion of the address (e.g. "Texas" — spell out the full state name, not the postal code).
- businessGoals: array of strings
- painPoints: array of strings
- currentTools: array of strings
- budget: string or null
- rawNotes: 1-2 sentence summary

Use null for unknown fields. The clientName, address, and phone fields together form the NAP (Name, Address, Phone) block displayed prominently on the audit cover, so be thorough finding them.

FORM TEXT:
${pdfText.slice(0, 18000)}

Return only JSON.`;
  const txt = await chatJSON(sys, usr, 2048);
  const intake = extractJson<IntakeData>(txt, {});
  // Deterministically derive owner first name from contactName so the
  // ElevenLabs narration and downstream skills never have to guess.
  if (intake.contactName) {
    intake.ownerFirstName = firstNameOf(intake.contactName);
  }
  return intake;
}

/**
 * Use a small LLM call to derive the dominant metro anchor and 3 surrounding
 * cities for a given local city + state. Used for the DataForSEO geo cascade
 * (local → adjacent → metro → state → root-phrase) so local-service keywords
 * get realistic search volumes.
 *
 * Returns { metroArea, surroundingCities[] }. Both fields may be empty on
 * failure — this is enrichment, not a hard dependency.
 */
export async function enrichIntakeGeo(args: {
  city?: string;
  state?: string;
  location?: string;
}): Promise<{ metroArea?: string; surroundingCities?: string[] }> {
  const city = args.city?.trim();
  const state = args.state?.trim();
  const location = args.location?.trim();
  if (!city && !state && !location) return {};

  const sys = `You are a US geography assistant. Given a small/mid-size US city, return the dominant metro anchor city and 3 nearby cities used for local SEO geo targeting. Output ONLY valid JSON. Never include commentary.`;
  const usr = `For the following local business location, return:
- metroArea: the largest dominant metro anchor city for this area (e.g. for Frisco, TX → "Dallas"; for Plano, TX → "Dallas"; for Methuen, MA → "Boston"; for Macon, GA → "Macon" itself if it is already the local metro, otherwise the dominant anchor). Just the city name, no state.
- surroundingCities: an array of EXACTLY 3 nearby cities that share the local market, ordered nearest first. Use cities that a local-service business would realistically serve customers from. Do NOT include the input city itself or the metroArea. Just city names, no state.

LOCATION:
  city: ${city || "(unknown)"}
  state: ${state || "(unknown)"}
  full location string: ${location || "(unknown)"}

Return only JSON like {"metroArea":"Dallas","surroundingCities":["Plano","McKinney","Allen"]}.`;

  try {
    const txt = await chatJSON(sys, usr, 256);
    const parsed = extractJson<{ metroArea?: string; surroundingCities?: string[] }>(txt, {});
    // Defensively trim and dedupe.
    const metroArea = parsed.metroArea?.trim() || undefined;
    const surroundingCities = Array.isArray(parsed.surroundingCities)
      ? parsed.surroundingCities
          .map((c) => (typeof c === "string" ? c.trim() : ""))
          .filter((c) => c && c.toLowerCase() !== (city || "").toLowerCase() && c.toLowerCase() !== (metroArea || "").toLowerCase())
          .slice(0, 3)
      : undefined;
    return { metroArea, surroundingCities };
  } catch (err) {
    console.warn("[enrichIntakeGeo] failed; returning empty", err);
    return {};
  }
}

export interface VendastaData {
  overallScore?: number;
  listings?: ListingRow[];
  reviewCount?: number;
  averageRating?: number;
  responseRate?: number;
  socialPresence?: { platform: string; followers?: number; activity?: string }[];
  websiteSpeed?: number;
  mobileFriendly?: boolean;
  napConsistencyScore?: number;
  domainAuthority?: number;
  backlinks?: number;
  referringDomains?: number;
  rankingKeywords?: KeywordRow[];
  rawSummary?: string;
}

export async function extractVendasta(pdfText: string): Promise<VendastaData> {
  if (!pdfText) return {};
  const sys = `You extract structured data from Vendasta Snapshot Report PDFs. Output ONLY valid JSON.`;
  const usr = `Extract this Vendasta Snapshot into JSON with keys: overallScore (0-100), listings (array of {directory, status: "Listed"|"Missing"|"Inconsistent", napAccurate, notes}), reviewCount, averageRating, responseRate, socialPresence (array of {platform, followers, activity}), websiteSpeed (0-100), mobileFriendly (bool), napConsistencyScore (0-100), domainAuthority, backlinks, referringDomains, rankingKeywords (array of {keyword, position, volume}), rawSummary (2-3 sentence overall finding). Use null/empty arrays when not found.

VENDASTA SNAPSHOT TEXT:
${pdfText.slice(0, 20000)}

Return only JSON.`;
  const txt = await chatJSON(sys, usr, 4096);
  return extractJson<VendastaData>(txt, {});
}

/* -------------------- Report generation -------------------- */

export async function generateReport(opts: {
  clientName: string;
  website: string;
  intake: IntakeData;
  vendasta: VendastaData;
  keysearch: KeywordRow[];
}): Promise<ReportData & { overallGrade: Grade; overallScore: number }> {
  const { clientName, website, intake, vendasta, keysearch } = opts;

  const sys = `You are SMB Solutions' senior audit strategist. You produce structured Four-Pillar digital audit reports for B2B clients. Your tone is executive, faith-forward, nurturing-but-powerful, structured, and visionary. You write with clarity and precision. Output ONLY valid JSON, no commentary.

The Four Pillars are:
1. AI Automation (chatbots, CRM workflows, lead routing, automation maturity)
2. SEO + Listings (DEEPEST pillar: domain strength, backlinks, keywords, listings, NAP)
3. Reputation (reviews, ratings, response rate, sentiment)
4. Social Media (presence, cadence, engagement, brand consistency)

Plus a Website Performance section framed as an UPSELL engagement.

Grade scale: A+ (95-100), A (90-94), A- (87-89), B+ (83-86), B (80-82), B- (77-79), C+ (73-76), C (70-72), C- (67-69), D+ (63-66), D (60-62), F (<60).`;

  const usr = `Generate a complete Four-Pillar audit report for this client. Return ONLY a JSON object that matches this exact shape:

{
  "overallScore": number,
  "overallGrade": "A+|A|A-|B+|B|B-|C+|C|C-|D+|D|F",
  "executiveSummary": {
    "diagnosis": "2-3 sentence executive diagnosis",
    "topWins": ["3 wins, current strengths"],
    "topRisks": ["3 risks/urgent gaps"]
  },
  "pillars": {
    "aiAutomation": {
      "name":"AI Automation", "grade":"...", "score":0-100, "summary":"...",
      "strengths":[...], "gaps":[...], "recommendations":[...],
      "platforms": [
        { "platform": "ChatGPT",          "present": bool, "notes": "plain-English explanation" },
        { "platform": "Google Gemini",    "present": bool, "notes": "..." },
        { "platform": "Perplexity",       "present": bool, "notes": "..." },
        { "platform": "Grok",             "present": bool, "notes": "..." },
        { "platform": "Microsoft Copilot","present": bool, "notes": "..." },
        { "platform": "Claude",           "present": bool, "notes": "..." }
      ]
    },
    "seoListings":  { "name":"SEO + Listings", "grade":"...", "score":0-100, "summary":"...", "strengths":[...], "gaps":[...], "recommendations":[...] },
    "reputation":   { "name":"Reputation", "grade":"...", "score":0-100, "summary":"...", "strengths":[...], "gaps":[...], "recommendations":[...] },
    "socialMedia":  { "name":"Social Media", "grade":"...", "score":0-100, "summary":"...", "strengths":[...], "gaps":[...], "recommendations":[...] }
  },
  "seoDeep": {
    "domainAuthority": number,
    "pageAuthority": number,
    "totalBacklinks": number,
    "referringDomains": number,
    "rankingKeywords": [{"keyword":"...", "position":n, "volume":n, "difficulty":n, "cpc":n, "intent":"..."}],
    "opportunityKeywords": [{"keyword":"...", "volume":n, "difficulty":n, "cpc":n, "intent":"..."}],
    "listings": [{"directory":"...", "status":"Listed|Missing|Inconsistent", "napAccurate":bool, "notes":"..."}],
    "napConsistency": {"score":0-100, "nameVariants":[...], "addressVariants":[...], "phoneVariants":[...], "notes":"..."}
  },
  "websitePerformance": {
    "performanceScore": 0-100,
    "mobileScore": 0-100,
    "accessibilityScore": 0-100,
    "seoScore": 0-100,
    "coreWebVitals": {
      "lcp": { "value":"e.g. 2.8s", "rating":"Good|Needs Improvement|Poor", "fullName":"Largest Contentful Paint", "plainEnglish":"How long visitors wait before the main content appears" },
      "cls": { "value":"e.g. 0.12", "rating":"...", "fullName":"Cumulative Layout Shift",  "plainEnglish":"How much the page jumps around as it loads" },
      "fid": { "value":"e.g. 80ms", "rating":"...", "fullName":"First Input Delay",        "plainEnglish":"How quickly the page reacts when a visitor first taps or clicks" }
    },
    "conversionBlockers": [...],
    "securityNotes": [...]
  },
  "immediateActionPlan": {
    "summary": "2-3 sentence summary of what needs to happen now. NO 90-day language, NO paid-ad language. NO em-dashes.",
    "aiAutomation": [{ "task":"...", "why":"one-line reason", "priority":"Critical|High|Medium" }],
    "seoListings":  [{ "task":"...", "why":"...",            "priority":"..." }],
    "reputation":   [{ "task":"...", "why":"...",            "priority":"..." }],
    "socialMedia":  [{ "task":"...", "why":"...",            "priority":"..." }],
    "quickWins":    [{ "task":"...", "why":"...",            "priority":"..." }],
    "expectedOutcomes": ["3-5 outcomes once these items are executed. NO timeline language. NO em-dashes."]
  }
}

CLIENT: ${clientName}
WEBSITE: ${website}

INTAKE FORM DATA:
${JSON.stringify(intake, null, 2)}

VENDASTA SNAPSHOT DATA:
${JSON.stringify(vendasta, null, 2)}

KEYSEARCH KEYWORD DATA (${keysearch.length} rows):
${keysearch.length > 0 ? JSON.stringify(keysearch.slice(0, 80), null, 2) : "(No Keysearch CSV provided; infer ranking and opportunity keywords from Vendasta data, the client's industry, and location.)"}

REQUIREMENTS:
- SEO + Listings is the DEEPEST pillar; give it the most detail.
- For seoDeep.domainAuthority: use the Vendasta value if present, otherwise estimate from the website's age, backlink profile, and industry. Always return a number.
- For seoDeep.rankingKeywords: include up to 15 rows. Prioritize Keysearch data; merge with Vendasta. Sort by position ascending.
- For seoDeep.opportunityKeywords: identify up to 12 high-value gap keywords (decent volume, moderate difficulty, transactional/commercial intent). Use Keysearch data + your knowledge of the industry.
- Listings: cover Google, Bing, Facebook, Yelp, Apple Maps, Instagram, BBB, and 5+ industry-specific directories.
- AI Automation platforms array MUST include all SIX platforms in the order shown above (ChatGPT, Google Gemini, Perplexity, Grok, Microsoft Copilot, Claude). For each, judge whether the business is likely to be surfaced/cited when someone asks that AI for a recommendation in this category and market. Notes should be plain-English and specific (e.g., "Not cited when prompting ChatGPT for HVAC contractors near Macon, GA. The site has no schema.org markup and no AI-readable FAQ content.").
- Recommendations and Immediate Action Plan tasks must be concrete and specific (e.g., "Claim and optimize Google Business Profile with 10 photos and service categories" not "improve Google listing").
- The Immediate Action Plan replaces any 90-day plan. Do NOT use phrases like "in 30 days", "by week 4", "phase 2", or any week/day/month timeline. Do NOT recommend paid ads, Google Ads, Facebook Ads, or any paid media spend. SMB Solutions does not run paid-ad services.
- PUNCTUATION: Do NOT use em-dashes (—) or en-dashes (–) ANYWHERE in the report copy. This applies to every string field: diagnosis, summaries, strengths, gaps, recommendations, immediate-action items, notes, taglines, NAP variants, listings notes, voiceover phrasing, etc. Use commas, semicolons, colons, periods, or parentheses instead. Hyphens inside compound words ("high-value", "long-tail", "24/7") are fine, but never the long em-dash or en-dash.
- Use real data where available; make reasonable industry-informed estimates only when data is missing.

Return ONLY the JSON object.`;

  const txt = await chatJSON(sys, usr, 16000);
  const parsed = extractJson<ReportData & { overallGrade: Grade; overallScore: number }>(
    txt,
    {} as ReportData & { overallGrade: Grade; overallScore: number }
  );
  // Defensive: ensure required nested objects exist so downstream UI code never crashes.
  parsed.pillars = parsed.pillars ?? ({} as ReportData["pillars"]);
  parsed.immediateActionPlan = parsed.immediateActionPlan ?? ({
    summary: "",
    aiAutomation: [],
    seoListings: [],
    reputation: [],
    socialMedia: [],
    quickWins: [],
    expectedOutcomes: [],
  } as ReportData["immediateActionPlan"]);
  parsed.executiveSummary = parsed.executiveSummary ?? { diagnosis: "", topWins: [], topRisks: [] };
  parsed.seoDeep = parsed.seoDeep ?? ({} as ReportData["seoDeep"]);
  parsed.websitePerformance = parsed.websitePerformance ?? ({
    coreWebVitals: {},
    conversionBlockers: [],
    securityNotes: [],
  } as ReportData["websitePerformance"]);
  // Ensure AI platforms array exists with all 6 entries (in case the model omitted them)
  const expectedPlatforms = [
    "ChatGPT", "Google Gemini", "Perplexity", "Grok", "Microsoft Copilot", "Claude",
  ] as const;
  if (parsed.pillars.aiAutomation) {
    const existing = parsed.pillars.aiAutomation.platforms ?? [];
    parsed.pillars.aiAutomation.platforms = expectedPlatforms.map((p) => {
      const found = existing.find((x) => x.platform === p);
      return found ?? { platform: p, present: false, notes: "Not detected." };
    });
  }
  if (!parsed.overallGrade) parsed.overallGrade = "C" as Grade;
  if (typeof parsed.overallScore !== "number") parsed.overallScore = 70;
  // Server-side safety net: strip em-dashes / en-dashes from every string field.
  // The model is instructed not to use them, but this guarantees clean output.
  return stripDashes(parsed);
}

/**
 * Recursively walks a parsed value and replaces em-dashes (—) and en-dashes (–)
 * inside every string with cleaner punctuation. Hyphens (-) inside compound words
 * are intentionally left alone.
 *
 * Replacement rules (applied in order):
 *   space + dash + space  ->  ", "  (space-flanked dash becomes a comma pause)
 *   bare dash             ->  ", "  (any remaining dash, falls back to comma)
 */
function stripDashes<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(/\s+[\u2014\u2013]\s+/g, ", ")
      .replace(/[\u2014\u2013]/g, ", ") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripDashes(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDashes(v);
    }
    return out as T;
  }
  return value;
}

