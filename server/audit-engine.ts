/**
 * Audit Engine — orchestrates PDF parsing, CSV parsing, AI extraction,
 * and structured report generation for the SMB Audit Engine.
 */
import Anthropic from "@anthropic-ai/sdk";
import Papa from "papaparse";
// pdf-parse has no proper ESM types; use dynamic import
import type { ReportData, KeywordRow, ListingRow, Grade, KeywordTier, LiveValidation } from "@shared/schema";
import { validateBusinessLive, reconcile, isLiveValidationEnabled } from "./live-google-validation";

// Anthropic API expects hyphenated IDs. The underscore form is a sandbox-only alias.
// claude-sonnet-4-6 is the latest Sonnet (Feb 2026). Override with ANTHROPIC_MODEL env var.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* -------------------- PDF + CSV parsing -------------------- */

export async function parsePdfBuffer(buf: Buffer): Promise<string> {
  // pdf-parse v2 changed its API — the default export is no longer a callable
  // function. The new API is a `PDFParse` class with a `getText()` method.
  // Lazy-load to avoid any top-level side effects on import.
  try {
    const mod = (await import("pdf-parse")) as unknown as {
      PDFParse?: new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }> };
      default?: { PDFParse?: new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }> } };
    };
    const PDFParseCtor = mod.PDFParse || mod.default?.PDFParse;
    if (!PDFParseCtor) {
      console.error("pdf-parse: PDFParse class not found in module", Object.keys(mod));
      return "";
    }
    const parser = new PDFParseCtor({ data: buf });
    const result = await parser.getText();
    return (result?.text || "").trim();
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
import { enrichKeywords, isGoogleAdsEnabled, type GeoCascade } from "./dataforseo-google-ads";

/**
 * Deterministic regex/heuristic fallback for the three critical auto-fill
 * fields (website, email, business name). Runs BEFORE the LLM call so the
 * LLM has hints, and AFTER the LLM call to back-fill anything the LLM missed.
 * This is what saves us when the PDF is scanned, oddly formatted, or has
 * labels the LLM doesn't recognize.
 */
function extractIntakeHeuristics(pdfText: string): Partial<IntakeData> {
  const out: Partial<IntakeData> = {};
  if (!pdfText) return out;
  const text = pdfText.replace(/\r/g, "");

  // ---- Email ----
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) out.email = emailMatch[0];

  // ---- Website (URL or bare domain on a "Website:" line) ----
  // First try a labeled line so we don't grab the email's domain.
  const labeledUrl = text.match(/(?:website|web ?site|url|domain)\s*[:\-]?\s*((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s,]*)?)/i);
  if (labeledUrl) {
    let u = labeledUrl[1].trim().replace(/[,;.]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    out.website = u;
  } else {
    // Any http(s) URL anywhere in the text
    const anyUrl = text.match(/https?:\/\/[^\s,]+/);
    if (anyUrl) out.website = anyUrl[0].replace(/[,;.)]+$/, "");
  }

  // ---- Phone ----
  const phoneMatch = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  if (phoneMatch) out.phone = phoneMatch[0];

  // ---- Business name (labeled) ----
  const bizLabel = text.match(/(?:business name|company name|company|business|dba|d\/b\/a|organization|practice name|clinic name)\s*[:\-]\s*([^\n\r]{2,120})/i);
  if (bizLabel) {
    const candidate = bizLabel[1].trim().replace(/[,;]+$/, "");
    // Drop trailing label noise like "Phone" or "Email" that sometimes follows on the same line.
    const cleaned = candidate.split(/\s{2,}|\t/)[0].trim();
    if (cleaned.length >= 2 && cleaned.length <= 120) out.clientName = cleaned;
  }

  // ---- Contact name (labeled) ----
  const contactLabel = text.match(/(?:owner|contact name|primary contact|your name|full name|name)\s*[:\-]\s*([A-Za-z][A-Za-z .'\-]{1,80})/i);
  if (contactLabel) {
    const c = contactLabel[1].trim().replace(/[,;]+$/, "");
    if (c.length >= 2) out.contactName = c;
  }

  return out;
}

export async function extractIntake(pdfText: string): Promise<IntakeData> {
  if (!pdfText) return {};

  // Run the deterministic heuristics first — they're cheap and give us a
  // guaranteed floor even if the LLM produces nothing usable.
  const heur = extractIntakeHeuristics(pdfText);
  console.log("[extractIntake] heuristic fallback found:", {
    clientName: heur.clientName,
    contactName: heur.contactName,
    website: heur.website,
    email: heur.email,
  });

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

Use null for unknown fields. The clientName, address, and phone fields together form the NAP (Name, Address, Phone) block displayed prominently on the audit cover, so be thorough finding them. Look broadly: any business/company/organization/practice/clinic/firm/agency name counts. Any URL/domain in the document counts as the website unless explicitly labeled otherwise.

FORM TEXT:
${pdfText.slice(0, 18000)}

Return only JSON.`;
  let intake: IntakeData = {};
  try {
    const txt = await chatJSON(sys, usr, 2048);
    intake = extractJson<IntakeData>(txt, {});
  } catch (err) {
    console.warn("[extractIntake] LLM call failed, falling back to heuristics only", err);
  }

  // Back-fill any field the LLM left blank with the deterministic heuristics.
  if (!intake.clientName && heur.clientName) intake.clientName = heur.clientName;
  if (!intake.contactName && heur.contactName) intake.contactName = heur.contactName;
  if (!intake.website && heur.website) intake.website = heur.website;
  if (!intake.email && heur.email) intake.email = heur.email;
  if (!intake.phone && heur.phone) intake.phone = heur.phone;

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

/* -------------------- Local-keyword opportunity (DataForSEO Google Ads) -------------------- */

/**
 * Generate 8–10 candidate local-SEO opportunity keywords for the client's
 * industry + city using the LLM, then enrich each with real Google Ads search
 * volume / CPC / competition via the DataForSEO geo cascade.
 *
 * Returns a KeywordRow[] ready to plug into seoDeep.opportunityKeywords.
 * Falls back to LLM-only rows (no DataForSEO metrics) if creds are missing
 * or the API fails.
 */
async function buildLocalOpportunityKeywords(
  intake: IntakeData,
  vendasta: VendastaData,
): Promise<KeywordRow[]> {
  const industry = (intake.industry || "local business").trim();
  const city = (intake.city || intake.location || "").trim();
  const state = (intake.state || "").trim();

  // 1) Ask the LLM for 8–10 candidate keywords specific to this industry and city.
  const sys = `You generate local-SEO keyword candidates for small businesses. Output ONLY valid JSON. Never include commentary.`;
  const usr = `Generate exactly 10 high-value local-SEO opportunity keywords for this business. Return JSON: {"keywords":["...","..."]}.

INDUSTRY: ${industry}
CITY: ${city || "(unknown)"}
STATE: ${state || "(unknown)"}
BUSINESS NAME: ${intake.clientName || "(unknown)"}

Guidelines:
- 8-10 keywords, all relevant to local search for this industry in this city.
- Mix of "service" terms ("emergency hvac") and "service + city" terms ("hvac repair frisco").
- Transactional / commercial intent preferred over informational.
- 2-5 words each. Lowercase. No quotes, no punctuation.
- Do NOT include the business name itself.
- Do NOT include broad national terms like "best hvac near me" — stay specific to this city/industry.

Return only JSON.`;
  let candidates: string[] = [];
  try {
    const txt = await chatJSON(sys, usr, 512);
    const parsed = extractJson<{ keywords?: string[] }>(txt, {});
    candidates = Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => (typeof k === "string" ? k.trim().toLowerCase() : "")).filter(Boolean).slice(0, 10)
      : [];
  } catch (err) {
    console.warn("[opportunity-keywords] LLM candidate generation failed", err);
  }
  if (candidates.length === 0) {
    // Last-resort: derive a tiny seed list from industry + city.
    if (industry && city) {
      candidates = [
        industry,
        `${industry} ${city}`,
        `best ${industry} ${city}`,
        `${industry} near me`,
        `affordable ${industry}`,
      ].map((k) => k.toLowerCase());
    } else {
      return []; // nothing to enrich
    }
  }

  // 2) Enrich with DataForSEO Google Ads search volume cascade.
  if (!isGoogleAdsEnabled()) {
    // No creds: return LLM-only rows so the report still has SOMETHING. Mark geo as "none".
    return candidates.map((kw) => ({
      keyword: kw,
      volume: undefined,
      cpc: undefined,
      competition: undefined,
      geoLayer: "none" as const,
      volumeGeo: "",
      intent: "commercial",
    }));
  }

  // If the intake was created before geo enrichment was added (older audits),
  // metroArea / surroundingCities will be missing. Do an on-the-fly enrichment
  // so reruns of old audits still get a proper geo cascade.
  let metroArea = intake.metroArea;
  let surroundingCities = intake.surroundingCities;
  if ((!metroArea || !surroundingCities?.length) && (intake.city || intake.state)) {
    try {
      const geo = await enrichIntakeGeo({
        city: intake.city,
        state: intake.state,
        location: intake.location,
      });
      if (geo.metroArea && !metroArea) metroArea = geo.metroArea;
      if (geo.surroundingCities && !surroundingCities?.length) {
        surroundingCities = geo.surroundingCities;
      }
      console.log(
        `[opportunity-keywords] on-the-fly geo enrichment: metro=${metroArea} surrounding=${(surroundingCities || []).join(", ")}`,
      );
    } catch (err) {
      console.warn("[opportunity-keywords] on-the-fly geo enrichment failed", err);
    }
  }

  const cascade: GeoCascade = {
    city: intake.city || undefined,
    state: intake.state || undefined,
    adjacentCity: surroundingCities?.[0],
    metroArea: metroArea || undefined,
    surroundingCities,
  };
  console.log(
    `[opportunity-keywords] candidates=${candidates.length} cascade=${JSON.stringify({
      city: cascade.city,
      state: cascade.state,
      metro: cascade.metroArea,
      surrounding: cascade.surroundingCities || [],
    })}`,
  );
  try {
    // acceptAnyNonNull: trust the first non-null result from DataForSEO at any
    // geo layer. Without this, low-volume local terms (1-19 searches/mo) get
    // dropped as "not usable" and the report ends up with N/A everywhere.
    // threshold: 0 means even "sv === 0" counts so the cascade can escalate
    // to a broader geo and find a real number.
    const enriched = await enrichKeywords(candidates, cascade, {
      threshold: 0,
      acceptAnyNonNull: true,
    });
    const hits = enriched.filter((e) => (e.metrics.sv ?? null) !== null).length;
    console.log(
      `[opportunity-keywords] enrichment hits=${hits}/${enriched.length} ` +
        `layers=${enriched.map((e) => e.metrics.geo_layer).join(",")}`,
    );

    // LLM-estimated fallback: for any keyword that DataForSEO returned null on
    // across every geo layer, ask the LLM to estimate realistic volume / cpc /
    // difficulty so the report never shows all N/A. Estimates are marked with
    // geoLayer = "estimated" so the front end / narration knows the provenance.
    const stillNull = enriched
      .filter((e) => (e.metrics.sv ?? null) === null)
      .map((e) => e.keyword);
    const estimates = stillNull.length > 0
      ? await estimateKeywordMetricsLLM(stillNull, { industry, city, state })
      : new Map<string, { volume: number; cpc: number; difficulty: number }>();
    if (estimates.size > 0) {
      console.log(
        `[opportunity-keywords] LLM-estimated fallback applied to ${estimates.size}/${stillNull.length} null keywords`,
      );
    }

    return enriched.map((e) => {
      const live = (e.metrics.sv ?? null) !== null;
      if (live) {
        return {
          keyword: e.keyword,
          volume: e.metrics.sv ?? undefined,
          cpc: e.metrics.cpc ?? undefined,
          competition: e.metrics.comp ?? undefined,
          geoLayer: e.metrics.geo_layer,
          volumeGeo: e.volumeGeo,
          intent: "commercial",
        };
      }
      const est = estimates.get(e.keyword.toLowerCase());
      if (est) {
        return {
          keyword: e.keyword,
          volume: est.volume,
          cpc: est.cpc,
          difficulty: est.difficulty,
          competition: undefined,
          geoLayer: "estimated" as const,
          volumeGeo: "Estimated (local industry baseline)",
          intent: "commercial",
        } as KeywordRow;
      }
      return {
        keyword: e.keyword,
        volume: undefined,
        cpc: undefined,
        competition: undefined,
        geoLayer: "none" as const,
        volumeGeo: "",
        intent: "commercial",
      };
    });
  } catch (err) {
    console.warn("[opportunity-keywords] DataForSEO enrichment failed", err);
    // Even when the cascade throws, try to give the user LLM estimates so the
    // table is not entirely N/A.
    const estimates = await estimateKeywordMetricsLLM(candidates, { industry, city, state }).catch(() => new Map());
    return candidates.map((kw) => {
      const est = estimates.get(kw.toLowerCase());
      if (est) {
        return {
          keyword: kw,
          volume: est.volume,
          cpc: est.cpc,
          difficulty: est.difficulty,
          geoLayer: "estimated" as const,
          volumeGeo: "Estimated (local industry baseline)",
          intent: "commercial",
        } as KeywordRow;
      }
      return {
        keyword: kw,
        geoLayer: "none" as const,
        volumeGeo: "",
        intent: "commercial",
      };
    });
  }
}

/**
 * LLM-estimated keyword metrics fallback. Used only when DataForSEO returns
 * null across every geo layer for a keyword. Returns conservative, realistic
 * estimates clearly labelled as estimated in the report. Never invents a brand
 * keyword volume.
 */
async function estimateKeywordMetricsLLM(
  keywords: string[],
  ctx: { industry: string; city?: string; state?: string },
): Promise<Map<string, { volume: number; cpc: number; difficulty: number }>> {
  const out = new Map<string, { volume: number; cpc: number; difficulty: number }>();
  if (keywords.length === 0) return out;
  const sys = `You estimate realistic Google search metrics for long-tail local keywords. Output ONLY valid JSON.`;
  const usr = `Estimate monthly search volume, average CPC (USD), and keyword difficulty (0-100) for each keyword below in the context of a small local business.

INDUSTRY: ${ctx.industry}
CITY: ${ctx.city || "(unknown)"}
STATE: ${ctx.state || "(unknown)"}

KEYWORDS:
${keywords.map((k) => `- ${k}`).join("\n")}

Guidelines:
- Volume should reflect a small city / metro audience. Long-tail local terms typically 10-90 searches/month. Be conservative.
- CPC realistic for the industry (commercial intent usually $0.50 - $4.00).
- Difficulty: 10-40 for long-tail local, higher only if generic.
- Round volume to nearest 10. Round CPC to 2 decimals.

Return JSON: {"estimates":[{"keyword":"...","volume":N,"cpc":N.NN,"difficulty":N}, ...]}`;
  try {
    const txt = await chatJSON(sys, usr, 1024);
    const parsed = extractJson<{ estimates?: Array<{ keyword?: string; volume?: number; cpc?: number; difficulty?: number }> }>(txt, {});
    for (const row of parsed.estimates || []) {
      if (!row?.keyword) continue;
      const v = Number(row.volume);
      const c = Number(row.cpc);
      const d = Number(row.difficulty);
      if (!Number.isFinite(v) || !Number.isFinite(c) || !Number.isFinite(d)) continue;
      out.set(row.keyword.trim().toLowerCase(), {
        volume: Math.max(0, Math.round(v)),
        cpc: Math.max(0, Math.round(c * 100) / 100),
        difficulty: Math.min(100, Math.max(0, Math.round(d))),
      });
    }
  } catch (err) {
    console.warn("[opportunity-keywords] LLM estimation failed", err);
  }
  return out;
}

/* -------------------- Keyword tier classification -------------------- */

/**
 * Classify each keyword as brand / local / national for the Brand → Local →
 * National narration arc Dwayne wants. Deterministic so the narration never
 * disagrees with the report data:
 *
 *   - brand: contains the business name (any token) or the domain root.
 *   - local: contains the city, metro, state name, state postal code (TX, NY),
 *     surrounding city, or common local modifiers ("near me").
 *   - national: everything else.
 *
 * Applied to BOTH ranking and opportunity keyword arrays.
 */
function tokenize(s?: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh",
  "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc",
  "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa",
  "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn",
  texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

export function classifyKeywordTier(
  keyword: string,
  ctx: {
    businessName?: string;
    website?: string;
    city?: string;
    state?: string;
    metroArea?: string;
    surroundingCities?: string[];
  },
): KeywordTier {
  const kw = keyword.toLowerCase();
  const tokens = tokenize(keyword);

  // ---- Brand check ----
  // The business name tokenized, ignoring noise words.
  const brandTokens = tokenize(ctx.businessName).filter(
    (t) => !/^(llc|inc|co|corp|the|and|&)$/.test(t),
  );
  if (brandTokens.length > 0) {
    // Match if any meaningful brand token appears in the keyword.
    if (brandTokens.some((bt) => tokens.includes(bt))) return "brand";
    // Also match contiguous brand phrase (e.g. "fiorinabeauty")
    const brandPhrase = brandTokens.join("");
    if (brandPhrase.length >= 4 && kw.replace(/\s+/g, "").includes(brandPhrase)) return "brand";
  }
  // Domain root match (e.g. "fiorinabeauty.com")
  if (ctx.website) {
    const domain = ctx.website
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(".")[0];
    if (domain.length >= 4 && kw.includes(domain)) return "brand";
  }

  // ---- Local check ----
  const localTerms = new Set<string>();
  for (const v of [ctx.city, ctx.metroArea, ctx.state, ...(ctx.surroundingCities || [])]) {
    for (const t of tokenize(v)) localTerms.add(t);
  }
  if (ctx.state) {
    const abbr = STATE_ABBREVIATIONS[ctx.state.toLowerCase().trim()];
    if (abbr) localTerms.add(abbr);
  }
  if (tokens.some((t) => localTerms.has(t))) return "local";
  if (/\bnear\s+me\b/i.test(keyword)) return "local";

  // ---- Default: national ----
  return "national";
}

function tagKeywordTiers(rows: KeywordRow[] | undefined, ctx: Parameters<typeof classifyKeywordTier>[1]): KeywordRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ ...r, tier: r.tier || classifyKeywordTier(r.keyword || "", ctx) }));
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

  // Kick off the DataForSEO-backed local opportunity keywords in parallel with the
  // main report generation. Whichever finishes first waits for the other.
  const opportunityKeywordsPromise = buildLocalOpportunityKeywords(intake, vendasta);

  // Kick off the live-Google validation pass in parallel. This is what saves us
  // from claiming "no GBP" or "no reviews" when Google clearly shows otherwise.
  // Non-blocking: if it fails, we still ship a report from snapshot data.
  const liveValidationPromise = isLiveValidationEnabled()
    ? validateBusinessLive({
        businessName: clientName,
        city: intake.city,
        state: intake.state,
        website,
      }).catch((err) => {
        console.warn("[generateReport] live validation failed:", err?.message || err);
        return null;
      })
    : Promise.resolve(null);

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

  // Hard-override opportunityKeywords with the DataForSEO-enriched local list,
  // so the report shows real Google Ads volume / CPC / competition + geo layer
  // instead of the model's guesses. If the enrichment returned nothing usable,
  // we leave the model's guesses in place.
  try {
    const localKws = await opportunityKeywordsPromise;
    if (localKws.length > 0) {
      parsed.seoDeep = parsed.seoDeep || ({} as ReportData["seoDeep"]);
      parsed.seoDeep.opportunityKeywords = localKws;
    }
  } catch (err) {
    console.warn("[generateReport] opportunity-keywords promise rejected", err);
  }

  // Classify every keyword row (ranking + opportunity) as brand / local / national
  // so the narration can walk Brand → Local → National in that order.
  const tierCtx = {
    businessName: clientName,
    website,
    city: intake.city,
    state: intake.state,
    metroArea: intake.metroArea,
    surroundingCities: intake.surroundingCities,
  };
  parsed.seoDeep.rankingKeywords = tagKeywordTiers(parsed.seoDeep.rankingKeywords, tierCtx);
  parsed.seoDeep.opportunityKeywords = tagKeywordTiers(parsed.seoDeep.opportunityKeywords, tierCtx);

  // Apply live-Google validation overrides. Per directive: live ALWAYS wins.
  try {
    const live = await liveValidationPromise;
    if (live && live.ok) {
      const discrepancies = reconcile(live, {
        reviewCount: vendasta.reviewCount,
        averageRating: vendasta.averageRating,
        hasGbp: (vendasta.listings || []).some(
          (l) => /google business profile|gbp|google my business/i.test(l.directory) && l.status === "Listed",
        ),
      });
      if (discrepancies.length > 0) {
        console.log("[generateReport] live-validation discrepancies:", discrepancies);
      }

      // Attach the live validation block so downstream code (UI + narration)
      // can reference verified facts directly.
      parsed.liveValidation = {
        gbp: {
          present: live.gbp.present,
          rating: live.gbp.rating,
          reviewCount: live.gbp.reviewCount,
          phone: live.gbp.phone,
          address: live.gbp.address,
          reviewsUrl: live.gbp.reviewsUrl,
        },
        social: live.social.map((s) => ({ platform: s.platform, present: s.present, url: s.url })),
        discrepancies,
        provider: live.provider,
      };

      // Override the Reputation pillar copy when live shows reviews exist.
      // We replace the false "no reviews" framing with a faithful summary
      // while keeping any legitimate gaps the LLM identified.
      if (live.gbp.reviewCount && live.gbp.reviewCount > 0 && parsed.pillars?.reputation) {
        const verifiedLine =
          `Verified via live Google search on ${new Date().toISOString().slice(0, 10)}: ` +
          `Google Business Profile is active with ${live.gbp.reviewCount} review${live.gbp.reviewCount === 1 ? "" : "s"}` +
          (live.gbp.rating ? ` at ${live.gbp.rating} stars.` : ".");
        parsed.pillars.reputation.summary = verifiedLine + " " +
          (parsed.pillars.reputation.summary || "");
        // Remove any "no reviews" / "no GBP" claims from gaps and strengths.
        const stripBadClaims = (arr?: string[]) =>
          (arr || []).filter(
            (g) =>
              !/no\s+reviews|zero\s+reviews|no\s+google\s+business\s+profile|no\s+gbp|missing\s+google\s+business/i.test(
                g,
              ),
          );
        parsed.pillars.reputation.gaps = stripBadClaims(parsed.pillars.reputation.gaps);
        parsed.pillars.reputation.strengths = [
          `Active Google Business Profile with ${live.gbp.reviewCount} review${live.gbp.reviewCount === 1 ? "" : "s"}${live.gbp.rating ? ` at ${live.gbp.rating} stars` : ""}.`,
          ...stripBadClaims(parsed.pillars.reputation.strengths),
        ];
      }

      // Override the listings array: if Google says GBP exists, mark it Listed.
      if (live.gbp.present && parsed.seoDeep?.listings) {
        const gbpIdx = parsed.seoDeep.listings.findIndex((l) =>
          /google business profile|gbp|google my business/i.test(l.directory),
        );
        const gbpRow: ListingRow = {
          directory: "Google Business Profile",
          status: "Listed",
          napAccurate: true,
          notes: `Verified live: ${live.gbp.reviewCount ?? 0} reviews${live.gbp.rating ? `, ${live.gbp.rating} stars` : ""}${live.gbp.phone ? `, phone ${live.gbp.phone}` : ""}.`,
        };
        if (gbpIdx >= 0) parsed.seoDeep.listings[gbpIdx] = gbpRow;
        else parsed.seoDeep.listings.unshift(gbpRow);
      }

      // Override the Social pillar gaps for platforms we confirmed exist.
      if (parsed.pillars?.socialMedia) {
        const presentPlatforms = live.social.filter((s) => s.present).map((s) => s.platform);
        if (presentPlatforms.length > 0) {
          const labels: Record<string, string> = {
            facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn",
            tiktok: "TikTok", youtube: "YouTube",
          };
          const presentLabel = presentPlatforms.map((p) => labels[p] || p).join(", ");
          // Strip any "no presence on X" claims for platforms we verified exist.
          parsed.pillars.socialMedia.gaps = (parsed.pillars.socialMedia.gaps || []).filter((g) => {
            const gl = g.toLowerCase();
            return !presentPlatforms.some((p) => gl.includes(`no ${p}`) || gl.includes(`missing ${p}`) || gl.includes(`no presence on ${p}`));
          });
          parsed.pillars.socialMedia.strengths = [
            `Verified active social profiles: ${presentLabel}.`,
            ...(parsed.pillars.socialMedia.strengths || []),
          ];
        }
      }
    } else if (live === null || (live && !live.ok)) {
      console.log("[generateReport] live validation returned no data; snapshot stands");
    }
  } catch (err) {
    console.warn("[generateReport] live-validation merge failed", err);
  }

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

