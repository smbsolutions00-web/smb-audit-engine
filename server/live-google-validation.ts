/**
 * Live Google validation pass.
 *
 * Why this exists: the Vendasta/Manus snapshot data we extract from PDFs is
 * routinely WRONG about whether a business has a Google Business Profile,
 * how many reviews they have, and which social channels they're on. When the
 * audit tells an owner "you have no GBP and no reviews" but they actually
 * have a 5.0 rating with 15 reviews, the entire audit's credibility dies.
 *
 * This module runs a small set of Google SERP queries against the LIVE web
 * BEFORE the narration is generated, and returns verified facts that ALWAYS
 * override conflicting snapshot data. Per Dwayne's directive (June 2026):
 * "Live Google data ALWAYS wins, silently override."
 *
 * Primary data source: DataForSEO SERP API (Google Organic, Live, Advanced)
 *   POST /v3/serp/google/organic/live/advanced
 *   - returns knowledge_graph item with rating/review_count + the organic
 *     blocks we need to confirm social profiles exist.
 *
 * Fallback: Serper.dev (if SERPER_API_KEY is set). Cheaper, fast, JSON-clean.
 *
 * Failure behavior: NON-BLOCKING. If both providers fail, we return an empty
 * result and the audit continues with snapshot data (the original behavior).
 * We never break the pipeline because of validation.
 */

import { dataForSeoAuthHeader, isDataForSeoEnabled } from "./lib/dataforseo-auth";

const DFS_BASE = "https://api.dataforseo.com";
const DFS_SERP_ENDPOINT = "/v3/serp/google/organic/live/advanced";
const DFS_MAPS_ENDPOINT = "/v3/serp/google/maps/live/advanced";
const SERPER_ENDPOINT = "https://google.serper.dev/search";
const REQUEST_TIMEOUT_MS = 25_000;

export interface GoogleBusinessProfile {
  /** True when a knowledge panel was found for this business name. */
  present: boolean;
  /** Star rating shown on the knowledge panel, e.g. 5.0. */
  rating: number | null;
  /** Total review count shown on the knowledge panel, e.g. 15. */
  reviewCount: number | null;
  /** Phone number shown on the panel, if any. */
  phone: string | null;
  /** Address shown on the panel, if any. */
  address: string | null;
  /** Hours summary if exposed (rarely available via SERP API). */
  hours: string | null;
  /** Direct link to Google reviews if the SERP exposes one. */
  reviewsUrl: string | null;
  /** Which provider returned this data. */
  source: "dataforseo" | "serper" | "none";
}

export interface SocialPresenceCheck {
  platform: "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube";
  /** True if we found at least one organic result pointing at the business's profile. */
  present: boolean;
  /** First URL we believe belongs to the business. */
  url: string | null;
}

export interface LiveValidationResult {
  /** What we confirmed about the business via live Google search. */
  gbp: GoogleBusinessProfile;
  /** Per-platform social presence findings. */
  social: SocialPresenceCheck[];
  /** Any discrepancies the caller should know about (e.g. snapshot said no GBP but live says yes). */
  discrepancies: string[];
  /** Which provider answered the GBP lookup (for logging). */
  provider: "dataforseo" | "serper" | "none";
  /** True when we got any live data at all. False means everything failed and snapshot data should stand. */
  ok: boolean;
}

const EMPTY_GBP: GoogleBusinessProfile = {
  present: false,
  rating: null,
  reviewCount: null,
  phone: null,
  address: null,
  hours: null,
  reviewsUrl: null,
  source: "none",
};

const EMPTY_RESULT: LiveValidationResult = {
  gbp: EMPTY_GBP,
  social: [],
  discrepancies: [],
  provider: "none",
  ok: false,
};

export function isSerperEnabled(): boolean {
  return !!(process.env.SERPER_API_KEY && process.env.SERPER_API_KEY.trim().length > 0);
}

export function isLiveValidationEnabled(): boolean {
  return isDataForSeoEnabled() || isSerperEnabled();
}

/* ---------------------- DataForSEO SERP ---------------------- */

interface DfsSerpItem {
  type?: string;
  title?: string;
  url?: string;
  domain?: string;
  description?: string;
  // knowledge_graph
  rating?: { value?: number; votes_count?: number };
  reviews_count?: number;
  phone?: string;
  address?: string;
  work_hours?: any;
  items?: DfsSerpItem[]; // knowledge_graph nested items
  links?: { type?: string; text?: string; url?: string }[];
}

interface DfsSerpTask {
  status_code?: number;
  status_message?: string;
  result?: {
    items?: DfsSerpItem[];
    item_types?: string[];
  }[];
}

async function dfsSerpQuery(query: string, locationName?: string): Promise<DfsSerpItem[] | null> {
  if (!isDataForSeoEnabled()) return null;
  const body = [
    {
      keyword: query,
      language_code: "en",
      location_name: locationName || "United States",
      device: "desktop",
      depth: 10,
    },
  ];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${DFS_BASE}${DFS_SERP_ENDPOINT}`, {
      method: "POST",
      headers: {
        Authorization: dataForSeoAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[live-validation] DataForSEO SERP returned ${res.status} for "${query}"`);
      return null;
    }
    const json: any = await res.json();
    const task: DfsSerpTask | undefined = json?.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      console.warn(`[live-validation] DataForSEO task error: ${task?.status_message}`);
      return null;
    }
    return task.result?.[0]?.items || [];
  } catch (err: any) {
    console.warn(`[live-validation] DataForSEO SERP failed for "${query}":`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Google Maps SERP lookup via DataForSEO. Returns the best-matching local-pack
 * result as a GoogleBusinessProfile.
 *
 * Why Maps and not just organic SERP? The /serp/google/organic endpoint exposes
 * a knowledge_graph item that is often the website (with no rating/reviews
 * fields populated) for e-commerce / supplement brands. The Maps endpoint
 * returns local-business items with reliable rating + rating.votes_count.
 *
 * Match strategy: case-insensitive title contains business name. If multiple
 * results match, prefer the one with the most reviews (more established).
 */
async function dfsMapsQuery(
  query: string,
  locationName: string | undefined,
  businessName: string,
): Promise<GoogleBusinessProfile | null> {
  if (!isDataForSeoEnabled()) return null;
  const body = [
    {
      keyword: query,
      language_code: "en",
      location_name: locationName || "United States",
      depth: 20,
    },
  ];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${DFS_BASE}${DFS_MAPS_ENDPOINT}`, {
      method: "POST",
      headers: {
        Authorization: dataForSeoAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[live-validation] DataForSEO Maps returned ${res.status} for "${query}"`);
      return null;
    }
    const json: any = await res.json();
    const task = json?.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      console.warn(`[live-validation] DataForSEO Maps task error: ${task?.status_message}`);
      return null;
    }
    const items: any[] = task.result?.[0]?.items || [];
    if (items.length === 0) {
      console.log(`[live-validation] Maps returned 0 items for "${query}"`);
      return null;
    }
    // Find best matching business by title (case-insensitive contains). Compare
    // on normalized strings (strip non-alphanum) so "FiorinaBeauty" matches
    // "Fiorina Beauty" or "Fiorina Beauty LLC".
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const bn = norm(businessName);
    const matches = items.filter((it) => {
      const title = it?.title || it?.name;
      if (typeof title !== "string") return false;
      return norm(title).includes(bn);
    });
    // If no title match, the first result is the best guess (Google's top pick).
    const candidates = matches.length > 0 ? matches : items.slice(0, 1);
    // Prefer the candidate with the most votes (most established listing).
    const best = candidates.sort((a, b) => {
      const av = a?.rating?.votes_count ?? a?.votes_count ?? 0;
      const bv = b?.rating?.votes_count ?? b?.votes_count ?? 0;
      return bv - av;
    })[0];
    if (!best) return null;
    const rating = typeof best.rating?.value === "number" ? best.rating.value : null;
    const reviewCount =
      typeof best.rating?.votes_count === "number"
        ? best.rating.votes_count
        : typeof best.votes_count === "number"
          ? best.votes_count
          : null;
    console.log(
      `[live-validation] Maps best match: title="${best?.title || best?.name}" rating=${rating} reviews=${reviewCount}`,
    );
    return {
      present: true,
      rating,
      reviewCount,
      phone: best.phone || null,
      address: best.address || best.address_info?.address || null,
      hours: null,
      reviewsUrl: best.url || null,
      source: "dataforseo",
    };
  } catch (err: any) {
    console.warn(`[live-validation] DataForSEO Maps failed for "${query}":`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseGbpFromDfs(items: DfsSerpItem[]): GoogleBusinessProfile | null {
  // DataForSEO returns the knowledge panel as items with type === "knowledge_graph".
  // Some accounts get nested structures, so we flatten one level deep.
  const flat: DfsSerpItem[] = [];
  for (const it of items) {
    flat.push(it);
    if (Array.isArray(it.items)) flat.push(...it.items);
  }
  const kg = flat.find((it) => it.type === "knowledge_graph");
  if (!kg) return null;
  const rating = typeof kg.rating?.value === "number" ? kg.rating.value : null;
  const reviewCount =
    typeof kg.rating?.votes_count === "number"
      ? kg.rating.votes_count
      : typeof kg.reviews_count === "number"
        ? kg.reviews_count
        : null;
  const reviewsUrl =
    kg.links?.find((l) => /review/i.test(l.type || "") || /review/i.test(l.text || ""))?.url ||
    null;
  return {
    present: true,
    rating,
    reviewCount,
    phone: kg.phone || null,
    address: kg.address || null,
    hours: null, // DFS exposes work_hours as a complex object; we skip for now
    reviewsUrl,
    source: "dataforseo",
  };
}

/* ---------------------- Serper.dev fallback ---------------------- */

interface SerperResponse {
  knowledgeGraph?: {
    title?: string;
    type?: string;
    rating?: number;
    ratingCount?: number;
    phoneNumber?: string;
    address?: string;
    hours?: string;
    attributes?: Record<string, string>;
  };
  organic?: { title?: string; link?: string; snippet?: string }[];
}

async function serperQuery(query: string): Promise<SerperResponse | null> {
  if (!isSerperEnabled()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY!.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 10 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[live-validation] Serper returned ${res.status} for "${query}"`);
      return null;
    }
    return (await res.json()) as SerperResponse;
  } catch (err: any) {
    console.warn(`[live-validation] Serper failed for "${query}":`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseGbpFromSerper(resp: SerperResponse): GoogleBusinessProfile | null {
  const kg = resp.knowledgeGraph;
  if (!kg) return null;
  return {
    present: true,
    rating: typeof kg.rating === "number" ? kg.rating : null,
    reviewCount: typeof kg.ratingCount === "number" ? kg.ratingCount : null,
    phone: kg.phoneNumber || null,
    address: kg.address || null,
    hours: kg.hours || null,
    reviewsUrl: null,
    source: "serper",
  };
}

/* ---------------------- Social presence ---------------------- */

const SOCIAL_DOMAINS: Record<SocialPresenceCheck["platform"], RegExp[]> = {
  facebook: [/facebook\.com/i],
  instagram: [/instagram\.com/i],
  linkedin: [/linkedin\.com\/(company|in|school)/i],
  tiktok: [/tiktok\.com/i],
  youtube: [/youtube\.com\/(channel|@|user)/i, /youtu\.be/i],
};

function findSocialUrl(items: { url?: string; link?: string }[], platform: SocialPresenceCheck["platform"]): string | null {
  const patterns = SOCIAL_DOMAINS[platform];
  for (const it of items) {
    const u = it.url || it.link;
    if (u && patterns.some((p) => p.test(u))) return u;
  }
  return null;
}

/* ---------------------- Public entry point ---------------------- */

export interface ValidateInput {
  businessName: string;
  city?: string;
  state?: string;
  website?: string;
  /** Street address from intake. Highly disambiguating for the Maps lookup. */
  address?: string;
}

/**
 * Run the live Google validation pass.
 *
 * Strategy:
 *   1. Primary brand query: "{businessName} {city} {state}" - try DataForSEO first,
 *      fall back to Serper. Extract knowledge panel for rating/reviews/phone.
 *   2. Social queries: "{businessName} facebook", "{businessName} instagram", etc.
 *      We piggyback on whichever provider succeeded in step 1 to keep cost down.
 *
 * Always returns a result object; check .ok to know if anything actually came back.
 */
export async function validateBusinessLive(input: ValidateInput): Promise<LiveValidationResult> {
  const businessName = input.businessName?.trim();
  if (!businessName) {
    console.warn("[live-validation] no business name provided, skipping");
    return EMPTY_RESULT;
  }
  if (!isLiveValidationEnabled()) {
    console.warn("[live-validation] no provider credentials, skipping");
    return EMPTY_RESULT;
  }

  const locationParts = [input.city, input.state].filter(Boolean).join(", ");
  const brandQuery = locationParts ? `${businessName} ${locationParts}` : businessName;
  const locationName = locationParts
    ? `${input.city ? input.city + "," : ""}${input.state || ""},United States`.replace(/,+/g, ",")
    : "United States";

  console.log(`[live-validation] brand query: "${brandQuery}" @ "${locationName}"`);

  let provider: "dataforseo" | "serper" | "none" = "none";
  let gbp: GoogleBusinessProfile = EMPTY_GBP;
  let allItems: { url?: string; link?: string }[] = [];

  // 1a) DataForSEO Google Maps lookup - the most reliable source of GBP review
  // count. The Maps SERP returns local-pack results with rating + votes_count
  // even when the knowledge_graph item is just the website (no review fields).
  // Try address-first if we have one (very disambiguating), else name + city.
  const mapsQuery = input.address
    ? `${businessName} ${input.address}`
    : locationParts
      ? `${businessName} ${locationParts}`
      : businessName;
  const mapsGbp = await dfsMapsQuery(mapsQuery, locationName, businessName);
  if (mapsGbp) {
    gbp = mapsGbp;
    provider = "dataforseo";
    console.log(`[live-validation] Maps hit: rating=${mapsGbp.rating} reviews=${mapsGbp.reviewCount}`);
  }

  // 1b) DataForSEO organic SERP - used for social discovery and as a knowledge
  // graph fallback if Maps came back empty.
  const dfsItems = await dfsSerpQuery(brandQuery, locationName);
  if (dfsItems && dfsItems.length > 0) {
    if (!gbp.present) {
      const parsed = parseGbpFromDfs(dfsItems);
      if (parsed) {
        gbp = parsed;
        provider = "dataforseo";
      }
    } else {
      // Maps gave us GBP. Backfill phone / address / reviewsUrl from the
      // organic knowledge panel if Maps did not provide them.
      const parsed = parseGbpFromDfs(dfsItems);
      if (parsed) {
        if (!gbp.phone && parsed.phone) gbp.phone = parsed.phone;
        if (!gbp.address && parsed.address) gbp.address = parsed.address;
        if (!gbp.reviewsUrl && parsed.reviewsUrl) gbp.reviewsUrl = parsed.reviewsUrl;
      }
    }
    allItems = dfsItems.map((i) => ({ url: i.url }));
  }

  // 2) Serper fallback if DFS didn't find a knowledge panel
  if (!gbp.present && isSerperEnabled()) {
    const sResp = await serperQuery(brandQuery);
    if (sResp) {
      const parsed = parseGbpFromSerper(sResp);
      if (parsed) {
        gbp = parsed;
        provider = "serper";
      }
      allItems = (sResp.organic || []).map((o) => ({ url: o.link }));
    }
  }

  // 3) Social presence checks - one query per platform, prefer the provider that worked.
  const social: SocialPresenceCheck[] = [];
  const platforms: SocialPresenceCheck["platform"][] = [
    "facebook",
    "instagram",
    "linkedin",
    "tiktok",
    "youtube",
  ];
  // First pass: scan organic results from the brand query
  for (const p of platforms) {
    const url = findSocialUrl(allItems, p);
    if (url) social.push({ platform: p, present: true, url });
  }
  // Second pass: explicit query for any platform we didn't find
  for (const p of platforms) {
    if (social.find((s) => s.platform === p)) continue;
    const q = `${businessName} ${p}`;
    let url: string | null = null;
    if (provider === "dataforseo" || (provider === "none" && isDataForSeoEnabled())) {
      const items = await dfsSerpQuery(q, "United States");
      if (items) url = findSocialUrl(items.map((i) => ({ url: i.url })), p);
    }
    if (!url && (provider === "serper" || (!url && isSerperEnabled()))) {
      const resp = await serperQuery(q);
      if (resp) url = findSocialUrl((resp.organic || []).map((o) => ({ link: o.link })), p);
    }
    social.push({ platform: p, present: !!url, url });
  }

  const ok = gbp.present || social.some((s) => s.present);
  const result: LiveValidationResult = {
    gbp,
    social,
    discrepancies: [],
    provider: provider === "none" && ok ? "dataforseo" : provider,
    ok,
  };
  console.log("[live-validation] result:", {
    provider: result.provider,
    gbpPresent: gbp.present,
    rating: gbp.rating,
    reviewCount: gbp.reviewCount,
    socialPresent: social.filter((s) => s.present).map((s) => s.platform),
  });
  return result;
}

/**
 * Reconcile snapshot data against live validation. Per directive: live always
 * wins. Returns the discrepancies it found so the caller can log them.
 */
export function reconcile(
  live: LiveValidationResult,
  snapshot: { reviewCount?: number; averageRating?: number; hasGbp?: boolean },
): string[] {
  const out: string[] = [];
  if (!live.ok) return out;

  if (live.gbp.present && snapshot.hasGbp === false) {
    out.push("Snapshot reported no Google Business Profile, but live Google shows one exists.");
  }
  if (
    live.gbp.reviewCount &&
    live.gbp.reviewCount > 0 &&
    (snapshot.reviewCount == null || snapshot.reviewCount === 0)
  ) {
    out.push(
      `Snapshot reported ${snapshot.reviewCount ?? 0} reviews, but live Google shows ${live.gbp.reviewCount} reviews${live.gbp.rating ? ` at ${live.gbp.rating} stars` : ""}.`,
    );
  }
  if (
    live.gbp.rating &&
    snapshot.averageRating != null &&
    Math.abs(snapshot.averageRating - live.gbp.rating) > 0.5
  ) {
    out.push(
      `Snapshot reported ${snapshot.averageRating} star average, but live Google shows ${live.gbp.rating}.`,
    );
  }
  return out;
}
