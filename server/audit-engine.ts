/**
 * Audit Engine — orchestrates PDF parsing, CSV parsing, AI extraction,
 * and structured report generation for the SMB Audit Engine.
 */
import Papa from "papaparse";
// pdf-parse has no proper ESM types; use dynamic import
import type { ReportData, KeywordRow, KeywordResearchSummary, ListingRow, Grade, KeywordTier, LiveValidation } from "@shared/schema";
import { validateBusinessLive, reconcile, isLiveValidationEnabled } from "./live-google-validation";
import { generateLLMText, isLLMAvailable } from "./llm-provider";

export { isLLMAvailable } from "./llm-provider";

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

/** Convert a 0-100 score to a letter grade matching the report's scale. */
function scoreToGrade(score: number): Grade {
  if (score >= 90) return "A" as Grade;
  if (score >= 80) return "B" as Grade;
  if (score >= 70) return "C" as Grade;
  if (score >= 60) return "D" as Grade;
  return "F" as Grade;
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
  return generateLLMText({
    instructions: systemPrompt,
    content: [{ type: "text", text: userPrompt }],
    maxOutputTokens: maxTokens,
  });
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
import {
  enrichKeywords,
  fetchKeywordOverviewAt,
  isGoogleAdsEnabled,
  type GeoCascade,
  type KeywordOverviewResult,
} from "./dataforseo-google-ads";

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
 * Use a small LLM call to derive the dominant metro anchor and up to 5 surrounding
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

  const sys = `You are a US geography assistant. Given a small or mid-size US city, return the dominant metro anchor city and nearby incorporated cities used for local SEO research. Output ONLY valid JSON. Never include commentary.`;
  const usr = `For the following local business location, return:
- metroArea: the largest dominant metro anchor city for this area (e.g. for Frisco, TX → "Dallas"; for Plano, TX → "Dallas"; for Methuen, MA → "Boston"; for Macon, GA → "Macon" itself if it is already the local metro, otherwise the dominant anchor). Just the city name, no state.
- surroundingCities: up to 5 nearby incorporated cities whose centers are approximately within a 30-mile radius of the input city, ordered nearest first. Prefer places with distinct local search demand. Do NOT include the input city itself. Include the metro anchor only when it is also inside the approximate 30-mile radius. Just city names, no state.

LOCATION:
  city: ${city || "(unknown)"}
  state: ${state || "(unknown)"}
  full location string: ${location || "(unknown)"}

Return only JSON like {"metroArea":"Dallas","surroundingCities":["Plano","McKinney","Allen","Carrollton","Lewisville"]}.`;

  try {
    const txt = await chatJSON(sys, usr, 256);
    const parsed = extractJson<{ metroArea?: string; surroundingCities?: string[] }>(txt, {});
    // Defensively trim and dedupe.
    const metroArea = parsed.metroArea?.trim() || undefined;
    const surroundingCities = Array.isArray(parsed.surroundingCities)
      ? parsed.surroundingCities
          .map((c) => (typeof c === "string" ? c.trim() : ""))
          .filter((c) => c && c.toLowerCase() !== (city || "").toLowerCase())
          .slice(0, 5)
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

export type ResearchMarket = { city: string; state?: string; geoLayer: "local" | "adjacent" | "metro" };
export type ResearchCandidate = KeywordRow & { market: string; serviceTheme: string };

export function buildPreSaleKeywordMatrix(
  serviceThemes: string[],
  markets: ResearchMarket[],
): Array<{ keyword: string; market: ResearchMarket; serviceTheme: string }> {
  const rows: Array<{ keyword: string; market: ResearchMarket; serviceTheme: string }> = [];
  const seen = new Set<string>();
  for (const market of markets) {
    for (const rawTheme of serviceThemes) {
      const serviceTheme = rawTheme.trim().toLowerCase();
      if (!serviceTheme) continue;
      for (const keyword of [
        `${serviceTheme} ${market.city}`,
        `${serviceTheme} in ${market.city}`,
        ...(market.geoLayer === "local" ? [`${serviceTheme} near me`] : []),
      ]) {
        const clean = keyword.replace(/\s+/g, " ").trim().toLowerCase();
        const key = `${market.city.toLowerCase()}|${clean}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ keyword: clean, market, serviceTheme });
      }
    }
  }
  return rows;
}

export function selectPreSaleOpportunities(
  rows: ResearchCandidate[],
  limit = 15,
  minimumVolume = 5,
): KeywordRow[] {
  const scored = rows
    .filter((row) => (row.volume ?? 0) >= minimumVolume)
    .sort((a, b) => {
      const volume = (b.volume ?? 0) - (a.volume ?? 0);
      if (volume !== 0) return volume;
      const commercial = (b.cpc ?? 0) - (a.cpc ?? 0);
      if (commercial !== 0) return commercial;
      return (a.difficulty ?? 101) - (b.difficulty ?? 101);
    });

  // Keep the terms responsible for most of the measured opportunity. We aim
  // to cover at least 80% of positive search volume, return at least eight rows
  // when available, and never exceed the concise audit limit.
  const totalVolume = scored.reduce((sum, row) => sum + (row.volume || 0), 0);
  const coverageTarget = totalVolume * 0.8;
  const minimumRows = Math.min(8, scored.length);
  const chosen: ResearchCandidate[] = [];
  let coveredVolume = 0;
  for (const row of scored) {
    if (chosen.length >= limit) break;
    chosen.push(row);
    coveredVolume += row.volume || 0;
    if (chosen.length >= minimumRows && coveredVolume >= coverageTarget) break;
  }
  return chosen.map(({ market: _market, serviceTheme: _theme, ...row }) => row);
}

async function deriveServiceThemes(
  intake: IntakeData,
  vendasta: VendastaData,
  keysearch: KeywordRow[],
): Promise<string[]> {
  const industry = (intake.industry || "local business").trim();
  const sys = `You identify verified commercial service themes for local keyword research. Output ONLY valid JSON.`;
  const usr = `Return JSON in this shape: {"serviceThemes":["..."]}.

BUSINESS: ${intake.clientName || "(unknown)"}
INDUSTRY: ${industry}
INTAKE FACTS: ${JSON.stringify({
    goals: intake.businessGoals || [],
    painPoints: intake.painPoints || [],
    notes: intake.rawNotes || "",
  })}
SNAPSHOT SUMMARY: ${vendasta.rawSummary || "(none)"}
EXISTING KEYWORD EVIDENCE: ${JSON.stringify(keysearch.slice(0, 30).map((row) => row.keyword))}

Rules:
- Return 3 to 6 concise service or provider phrases customers would use when ready to hire or buy.
- Include only services supported by the supplied business evidence.
- Do not add city names, state names, "near me", the business name, or informational questions.
- Do not invent services. If evidence is thin, use the industry category itself.
- Lowercase, 2 to 5 words each, with no punctuation.`;
  try {
    const txt = await chatJSON(sys, usr, 512);
    const parsed = extractJson<{ serviceThemes?: string[] }>(txt, {});
    const themes = Array.from(
      new Set(
        (parsed.serviceThemes || [])
          .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
          .filter(Boolean),
      ),
    ).slice(0, 6);
    if (themes.length > 0) return themes;
  } catch (err) {
    console.warn("[keyword-research] service-theme extraction failed", err);
  }
  return industry ? [industry.toLowerCase()] : [];
}

async function buildLocalOpportunityKeywords(
  intake: IntakeData,
  vendasta: VendastaData,
  keysearch: KeywordRow[],
): Promise<{ rows: KeywordRow[]; summary: KeywordResearchSummary }> {
  const state = intake.state?.trim() || undefined;
  let metroArea = intake.metroArea?.trim();
  let surroundingCities = intake.surroundingCities || [];
  if ((!metroArea || surroundingCities.length === 0) && (intake.city || intake.location)) {
    const geo = await enrichIntakeGeo({ city: intake.city, state, location: intake.location });
    metroArea ||= geo.metroArea;
    if (surroundingCities.length === 0) surroundingCities = geo.surroundingCities || [];
  }

  const serviceThemes = await deriveServiceThemes(intake, vendasta, keysearch);
  const markets: ResearchMarket[] = [];
  const addMarket = (city: string | undefined, geoLayer: ResearchMarket["geoLayer"]) => {
    const clean = city?.trim();
    if (!clean || markets.some((market) => market.city.toLowerCase() === clean.toLowerCase())) return;
    markets.push({ city: clean, state, geoLayer });
  };
  addMarket(intake.city || intake.location?.split(",")[0], "local");
  surroundingCities.slice(0, 5).forEach((city) => addMarket(city, "adjacent"));

  const summaryBase = {
    markets: markets.map((market) => state ? `${market.city}, ${state}` : market.city),
    serviceThemes,
    minimumVolume: 5,
  };
  if (!isGoogleAdsEnabled()) {
    return {
      rows: [],
      summary: {
        ...summaryBase,
        status: "unavailable",
        measuredKeywords: 0,
        positiveKeywords: 0,
        note: "Live keyword research is not configured. No search-volume estimates were invented.",
      },
    };
  }
  if (markets.length === 0 || serviceThemes.length === 0) {
    return {
      rows: [],
      summary: {
        ...summaryBase,
        status: "partial",
        measuredKeywords: 0,
        positiveKeywords: 0,
        note: "The audit did not contain enough verified service and location detail to run local keyword research.",
      },
    };
  }

  const matrix = buildPreSaleKeywordMatrix(serviceThemes, markets);
  const measured: ResearchCandidate[] = [];
  for (const market of markets) {
    const marketRows = matrix.filter((row) => row.market.city === market.city);
    const overview = await fetchKeywordOverviewAt(
      marketRows.map((row) => row.keyword),
      { city: market.city, state },
    );
    const byKeyword = new Map<string, KeywordOverviewResult>();
    overview.forEach((row) => byKeyword.set(row.keyword.toLowerCase(), row));
    for (const candidate of marketRows) {
      const live = byKeyword.get(candidate.keyword.toLowerCase());
      measured.push({
        keyword: candidate.keyword,
        market: candidate.market.city,
        serviceTheme: candidate.serviceTheme,
        volume: live?.searchVolume ?? undefined,
        cpc: live?.cpc ?? undefined,
        competition: live?.competition ?? undefined,
        difficulty: live?.difficulty ?? undefined,
        intent: live?.intent || "commercial",
        geoLayer: candidate.market.geoLayer,
        volumeGeo: state ? `${candidate.market.city}, ${state}` : candidate.market.city,
      });
    }
  }

  const positiveKeywords = measured.filter((row) => (row.volume ?? 0) >= 5).length;
  const rows = selectPreSaleOpportunities(measured);
  return {
    rows,
    summary: {
      ...summaryBase,
      status: rows.length > 0 ? "live" : "no-demand",
      measuredKeywords: measured.length,
      positiveKeywords,
      note: rows.length > 0
        ? "A bounded pre-sale scan measured verified service themes across the home city and nearby cities within an approximate 30-mile radius, including near-me searches. Only terms with at least five monthly searches are shown. Full campaign research begins after engagement."
        : "Live research completed, but no exact service-market phrase met the five-search reporting threshold.",
    },
  };
}

/**
 * Live-enrich ranking-keyword rows the LLM proposed by overriding their
 * volume / CPC / competition / geoLayer with DataForSEO Keywords Data results.
 *
 * Per Dwayne's directive (June 14, 2026): live keyword API data is the source
 * of truth. The keyword CSV is the research feed. The snapshot PDF is only
 * supporting context, never the primary numeric source.
 *
 * Strategy:
 *   - Keep the keyword strings and positions the LLM gave us (positions come
 *     from the snapshot/CSV; live API does not return rank).
 *   - Replace every numeric metric (volume, cpc, competition) with the live
 *     result from the geo cascade.
 *   - If a row had no DataForSEO hit at any layer, leave the LLM's number in
 *     place rather than blanking it out, so the report still reads.
 */
async function enrichRankingKeywordsLive(
  rows: KeywordRow[],
  intake: IntakeData,
): Promise<KeywordRow[]> {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  if (!isGoogleAdsEnabled()) return rows;

  // Use the same geo cascade we built for opportunity keywords.
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
    } catch (err) {
      console.warn("[ranking-keywords] on-the-fly geo enrichment failed", err);
    }
  }
  const cascade: GeoCascade = {
    city: intake.city || undefined,
    state: intake.state || undefined,
    adjacentCity: surroundingCities?.[0],
    metroArea: metroArea || undefined,
    surroundingCities,
  };
  const kws = rows.map((r) => r.keyword).filter(Boolean);
  if (kws.length === 0) return rows;
  try {
    const enriched = await enrichKeywords(kws, cascade, {
      threshold: 0,
      acceptAnyNonNull: true,
    });
    const byKw = new Map<string, (typeof enriched)[number]>();
    enriched.forEach((e) => byKw.set(e.keyword.toLowerCase(), e));
    const hits = enriched.filter((e) => (e.metrics.sv ?? null) !== null).length;
    console.log(
      `[ranking-keywords] enrichment hits=${hits}/${enriched.length} ` +
        `layers=${enriched.map((e) => e.metrics.geo_layer).join(",")}`,
    );
    return rows.map((r) => {
      const e = byKw.get((r.keyword || "").toLowerCase());
      if (!e) return r;
      const live = (e.metrics.sv ?? null) !== null;
      if (!live) return r;
      return {
        ...r,
        volume: e.metrics.sv ?? r.volume,
        cpc: e.metrics.cpc ?? r.cpc,
        competition: e.metrics.comp ?? r.competition,
        geoLayer: e.metrics.geo_layer,
        volumeGeo: e.volumeGeo,
      };
    });
  } catch (err) {
    console.warn("[ranking-keywords] DataForSEO enrichment failed", err);
    return rows;
  }
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

DIGITAL PRESENCE SNAPSHOT DATA:
${JSON.stringify(vendasta, null, 2)}

KEYWORD RESEARCH DATA (${keysearch.length} rows):
${keysearch.length > 0 ? JSON.stringify(keysearch.slice(0, 80), null, 2) : "(No keyword CSV provided; infer ranking and opportunity keywords from the snapshot data, the client's industry, and location.)"}

REQUIREMENTS:
- SEO + Listings is the DEEPEST pillar; give it the most detail.
- For seoDeep.domainAuthority: use the snapshot value if present, otherwise estimate from the website's age, backlink profile, and industry. Always return a number.
- DATA PRECEDENCE for keywords (STRICT): treat live keyword API data as the source of truth, treat the keyword research CSV as the research feed, and treat the snapshot PDF only as supporting context, never as the primary numeric source. The server will hard-override opportunityKeywords with measured local research after your output is parsed. Do not invent volume, CPC, competition, or difficulty values.
- For seoDeep.rankingKeywords: include up to 15 rows only when the keyword and position or volume are explicitly present in the keyword research data or snapshot. Do not infer rankings or numeric metrics. Sort verified positions ascending.
- BRAND NAMING: NEVER use the words "Vendasta", "Manus", or any third-party platform brand name in any string field of the report. If you need to refer to the source platform, use "SMB Solutions CRM" or simply "our system". This is a strict requirement.
- For seoDeep.opportunityKeywords: return an empty array. The server supplies only live-measured local opportunities with at least five monthly searches.
- Listings: cover Google, Bing, Facebook, Yelp, Apple Maps, Instagram, BBB, and 5+ industry-specific directories.
- AI Automation platforms array MUST include all SIX platforms in the order shown above (ChatGPT, Google Gemini, Perplexity, Grok, Microsoft Copilot, Claude). For each, judge whether the business is likely to be surfaced/cited when someone asks that AI for a recommendation in this category and market. Notes should be plain-English and specific (e.g., "Not cited when prompting ChatGPT for HVAC contractors near Macon, GA. The site has no schema.org markup and no AI-readable FAQ content.").
- Recommendations and Immediate Action Plan tasks must be concrete and specific (e.g., "Claim and optimize Google Business Profile with 10 photos and service categories" not "improve Google listing").
- The Immediate Action Plan replaces any 90-day plan. Do NOT use phrases like "in 30 days", "by week 4", "phase 2", or any week/day/month timeline. Do NOT recommend paid ads, Google Ads, Facebook Ads, or any paid media spend. SMB Solutions does not run paid-ad services.
- PUNCTUATION: Do NOT use em-dashes (—) or en-dashes (–) ANYWHERE in the report copy. This applies to every string field: diagnosis, summaries, strengths, gaps, recommendations, immediate-action items, notes, taglines, NAP variants, listings notes, voiceover phrasing, etc. Use commas, semicolons, colons, periods, or parentheses instead. Hyphens inside compound words ("high-value", "long-tail", "24/7") are fine, but never the long em-dash or en-dash.
- Use real data where available; make reasonable industry-informed estimates only when data is missing.

Return ONLY the JSON object.`;

  // Kick off the DataForSEO-backed local opportunity keywords in parallel with the
  // main report generation. Whichever finishes first waits for the other.
  const opportunityKeywordsPromise = buildLocalOpportunityKeywords(intake, vendasta, keysearch);

  // Kick off the live-Google validation pass in parallel. This is what saves us
  // from claiming "no GBP" or "no reviews" when Google clearly shows otherwise.
  // Non-blocking: if it fails, we still ship a report from snapshot data.
  const liveValidationPromise = isLiveValidationEnabled()
    ? validateBusinessLive({
        businessName: clientName,
        city: intake.city,
        state: intake.state,
        website,
        address: intake.address,
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

  // Always hard-override opportunity keywords. Empty live research stays empty;
  // the report never substitutes AI-invented search volume.
  try {
    const keywordResearch = await opportunityKeywordsPromise;
    parsed.seoDeep = parsed.seoDeep || ({} as ReportData["seoDeep"]);
    parsed.seoDeep.opportunityKeywords = keywordResearch.rows;
    parsed.seoDeep.keywordResearch = keywordResearch.summary;
  } catch (err) {
    console.warn("[generateReport] opportunity-keywords promise rejected", err);
    parsed.seoDeep.opportunityKeywords = [];
    parsed.seoDeep.keywordResearch = {
      status: "partial",
      markets: [],
      serviceThemes: [],
      measuredKeywords: 0,
      positiveKeywords: 0,
      minimumVolume: 5,
      note: "Live keyword research did not complete. No estimated volume was substituted.",
    };
  }

  // Enrich rankingKeywords with live DataForSEO Keywords Data so volume / CPC /
  // competition reflect the live API rather than snapshot-PDF numbers or model
  // guesses. Per directive: live keyword API is the source of truth; the
  // snapshot is only context.
  try {
    if (parsed.seoDeep?.rankingKeywords?.length) {
      parsed.seoDeep.rankingKeywords = await enrichRankingKeywordsLive(
        parsed.seoDeep.rankingKeywords,
        intake,
      );
    }
  } catch (err) {
    console.warn("[generateReport] ranking-keywords enrichment failed", err);
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

      // Override the Reputation pillar copy whenever live confirms a GBP
      // exists. Even if reviewCount is null/0 (rare for established
      // businesses), the LLM's "no Google Business Profile" framing is still
      // false and would tank credibility. We rewrite the summary from scratch
      // using verified facts and prune any contradicting gaps/strengths.
      if (live.gbp.present && parsed.pillars?.reputation) {
        const rc = live.gbp.reviewCount ?? 0;
        const rt = live.gbp.rating ?? null;
        const today = new Date().toISOString().slice(0, 10);
        const verifiedFacts =
          rc > 0
            ? `Verified via live Google search on ${today}: Google Business Profile is active with ${rc} review${rc === 1 ? "" : "s"}${rt ? ` at ${rt} stars` : ""}.`
            : `Verified via live Google search on ${today}: Google Business Profile is active${rt ? ` (${rt} stars)` : ""}.`;

        // Always lead the summary with the verified facts, then keep any
        // legitimate (non-contradicting) coaching the LLM already wrote.
        // Match plain "no reviews" / "zero reviews" AND multi-platform variants
        // like "Zero Google reviews, zero Yelp reviews, zero Facebook reviews".
        // The (?:\w+\s+){0,4} allows up to 4 words (platform names, commas) between
        // the negation word and "reviews".
        const badClaimRe = /(no\s+verified\s+online\s+reviews|(?:no|zero)\s+(?:\w+[,\s]+){0,4}reviews|no\s+google\s+business\s+profile|no\s+gbp|missing\s+google\s+business|no\s+average\s+rating|invisible\s+from\s+a\s+social\s+proof|will\s+find\s+nothing|suppresses\s+purchasing|no\s+star\s+rating)/i;
        const stripBadClaims = (arr?: string[]) =>
          (arr || []).filter((g) => !badClaimRe.test(g));
        const stripBadSummary = (s?: string) =>
          (s || "").replace(
            /[^.!?]*\b(no\s+verified\s+online\s+reviews|(?:no|zero)\s+(?:\w+[,\s]+){0,4}reviews|no\s+google\s+business\s+profile|no\s+gbp|missing\s+google\s+business|no\s+average\s+rating|invisible\s+from\s+a\s+social\s+proof|will\s+find\s+nothing|suppresses\s+purchasing|no\s+star\s+rating)[^.!?]*[.!?]/gi,
            "",
          ).replace(/\s{2,}/g, " ").trim();
        parsed.pillars.reputation.summary = (verifiedFacts + " " + stripBadSummary(parsed.pillars.reputation.summary)).trim();
        parsed.pillars.reputation.gaps = stripBadClaims(parsed.pillars.reputation.gaps);
        const strengthLine =
          rc > 0
            ? `Active Google Business Profile with ${rc} review${rc === 1 ? "" : "s"}${rt ? ` at ${rt} stars` : ""}.`
            : `Active Google Business Profile${rt ? ` rated ${rt} stars` : ""} (foundation already in place).`;
        parsed.pillars.reputation.strengths = [
          strengthLine,
          ...stripBadClaims(parsed.pillars.reputation.strengths),
        ];
        // If review count is healthy, soft-boost the reputation score so the
        // grade reflects reality. Cap at 75 so meaningful response-rate /
        // platform-coverage gaps still pull the grade down.
        if (rc >= 10 && typeof parsed.pillars.reputation.score === "number" && parsed.pillars.reputation.score < 60) {
          parsed.pillars.reputation.score = Math.min(75, 50 + Math.min(25, rc));
          parsed.pillars.reputation.grade = scoreToGrade(parsed.pillars.reputation.score);
        }
        // Backfill at least one constructive gap if we stripped everything,
        // so the section still gives the user something to act on.
        if ((parsed.pillars.reputation.gaps || []).length === 0) {
          parsed.pillars.reputation.gaps = [
            "No documented review-request automation in place to consistently grow review count month over month.",
            "No public review response workflow established (every new review should get a branded reply within 48 hours).",
            "Review presence is concentrated on Google only; Yelp / Trustpilot / Facebook coverage would broaden discovery.",
          ];
        }
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

  // Server-side safety net: strip em-dashes / en-dashes AND scrub forbidden
  // brand names from every string field. The model is instructed not to use them,
  // but this guarantees clean output.
  return stripForbiddenWords(stripDashes(parsed));
}

/**
 * Recursively walks a parsed value and replaces forbidden brand names inside
 * every string. Per Dwayne's directive: client-facing materials must NEVER
 * mention "Vendasta" or "Manus". Replace with "SMB Solutions CRM".
 */
function stripForbiddenWords<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(/\bvendasta\b/gi, "SMB Solutions CRM")
      .replace(/\bmanus\b/gi, "SMB Solutions CRM") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripForbiddenWords(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripForbiddenWords(v);
    }
    return out as T;
  }
  return value;
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
