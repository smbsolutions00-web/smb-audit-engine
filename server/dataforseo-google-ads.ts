/**
 * DataForSEO Google Ads search-volume client with cascading geo lookup.
 *
 * Endpoint:
 *   POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live
 *
 * Goal: enrich a list of locally-prioritized keywords with real Google Ads
 * data so the audit can rank opportunity instead of guessing.
 *
 * For each keyword we want back:
 *   - search_volume  (integer or null)        - avg Google monthly searches
 *   - cpc            (number or null, USD)    - avg advertiser cost-per-click
 *   - competition    (number or null, 0..1)   - Google Ads competition index
 *
 * Geo targeting is a CASCADING lookup. A single national lookup is useless
 * for local service businesses, so we query progressively broader location_name
 * values and stop at the first layer that returns a usable number. Escalate
 * when volume is null OR below a configurable threshold (default 20/mo).
 *
 * Order:
 *   1. Local city            "Frisco,Texas,United States"
 *   2. Adjacent city         nearest large neighbor
 *   3. Metro anchor          dominant metro for the area (e.g. Dallas)
 *   4. State                 "Texas,United States"
 *   5. Root-phrase retry     strip trailing place tokens
 *      ("endocrinologist plano" -> "endocrinologist") and re-query at the
 *      best available geo. Catches long "service + city" tails where
 *      DataForSEO has no city-scoped data.
 *
 * We record which layer produced the displayed number ("geo_layer") so the
 * report can show whether a value is truly local or escalated.
 *
 * Auth: HTTP Basic with DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD env vars.
 * Both secrets are sanitized for BOMs, whitespace, and stray quotes before
 * base64-encoding, because env vars routinely pick up these characters.
 *
 * Failure behavior: NON-BLOCKING. If credentials are missing, auth fails, or
 * the network call errors out, we return null metrics and the audit still
 * generates. We never break the pipeline because of DataForSEO.
 */

const API_BASE = "https://api.dataforseo.com";
const ENDPOINT = "/v3/keywords_data/google_ads/search_volume/live";
const REQUEST_TIMEOUT_MS = 30_000;
const LOW_VOLUME_THRESHOLD_DEFAULT = 20; // escalate if volume is null or below this

export type GeoLayer = "local" | "adjacent" | "metro" | "state" | "root" | "none";

export interface KeywordMetrics {
  sv: number | null;
  cpc: number | null;
  comp: number | null;
  geo_layer: GeoLayer;
}

export interface KeywordEnrichmentResult {
  keyword: string;
  metrics: KeywordMetrics;
  /** Human-readable label of the location_name that produced the displayed value (or "" if none). */
  volumeGeo: string;
}

export interface GeoCascade {
  /** Local city, e.g. "Frisco" */
  city?: string;
  /** State (full name preferred, e.g. "Texas" - postal codes also accepted) */
  state?: string;
  /** Adjacent city (nearest large neighbor for local-service businesses) */
  adjacentCity?: string;
  /** Metro anchor city, e.g. "Dallas" */
  metroArea?: string;
  /** Optional extra surrounding cities to try before falling back to state. */
  surroundingCities?: string[];
}

export interface EnrichOptions {
  /** Threshold below which we escalate to a broader geo. Default 20. */
  threshold?: number;
  /** Override low-volume escalation logic and trust the first non-null result. */
  acceptAnyNonNull?: boolean;
  /** Language code, default "en". */
  languageCode?: string;
}

/* ---------------------- secret hygiene ---------------------- */

function cleanSecret(v?: string): string {
  if (!v) return "";
  let s = v.replace(/^\uFEFF/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function authHeader(): string {
  const login = cleanSecret(process.env.DATAFORSEO_LOGIN);
  const password = cleanSecret(process.env.DATAFORSEO_PASSWORD);
  const token = Buffer.from(`${login}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

export function isGoogleAdsEnabled(): boolean {
  return !!(cleanSecret(process.env.DATAFORSEO_LOGIN) && cleanSecret(process.env.DATAFORSEO_PASSWORD));
}

/* ---------------------- low-level request ---------------------- */

interface RawResult {
  keyword?: string;
  search_volume?: number | null;
  cpc?: number | null;
  competition?: number | null;
}

async function fetchVolumesAt(
  keywords: string[],
  locationName: string,
  languageCode: string,
): Promise<Map<string, RawResult>> {
  const out = new Map<string, RawResult>();
  if (keywords.length === 0) return out;

  const url = `${API_BASE}${ENDPOINT}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Lowercase + dedupe before sending; match back by .toLowerCase().
  const dedup = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify([
        {
          keywords: dedup,
          location_name: locationName,
          language_code: languageCode,
        },
      ]),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // 401 / 403 -> bad creds. Treat as a soft failure: no enrichment.
      console.warn(`[google-ads] HTTP ${res.status} at ${locationName}`);
      return out;
    }
    const json: any = await res.json();
    const task = json?.tasks?.[0];
    const apiCode = task?.status_code ?? json?.status_code;
    // 40100 / 40200 / 40300 == auth/billing failure. 20000 == OK.
    if (apiCode && apiCode >= 40000 && apiCode < 50000) {
      console.warn(`[google-ads] API code ${apiCode} at ${locationName}: ${task?.status_message || json?.status_message}`);
      return out;
    }
    const rows: RawResult[] = Array.isArray(task?.result) ? task.result : [];
    for (const r of rows) {
      if (r?.keyword) out.set(r.keyword.toLowerCase(), r);
    }
    return out;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      console.warn(`[google-ads] timeout at ${locationName}`);
    } else {
      console.warn(`[google-ads] network error at ${locationName}: ${err?.message || err}`);
    }
    return out;
  }
}

/* ---------------------- helpers ---------------------- */

/**
 * Build the DataForSEO location_name string. The API expects exact city/state
 * names — "City,State,United States" or "State,United States" or "United States".
 */
function locationName(city: string | null | undefined, state: string | undefined): string {
  const c = city?.trim();
  const s = state?.trim();
  if (c && s) return `${c},${s},United States`;
  if (s) return `${s},United States`;
  return "United States";
}

/**
 * Strip trailing geographic tokens from a keyword for the root-phrase retry.
 *   "endocrinologist plano" -> "endocrinologist"
 *   "dentist frisco tx"     -> "dentist"
 *   "best plumber"          -> "best plumber" (no change; we only strip the geo tail)
 *
 * Strategy: split on whitespace, walk from the right end, drop any token that
 * matches the local city, adjacent city, metro, surrounding cities, state name,
 * or a US state postal code. Stop as soon as we hit a non-geo token.
 */
function stripGeoTail(keyword: string, cascade: GeoCascade): string {
  const geoTokens = new Set<string>();
  const addToken = (s?: string) => {
    if (!s) return;
    geoTokens.add(s.trim().toLowerCase());
  };
  addToken(cascade.city);
  addToken(cascade.adjacentCity);
  addToken(cascade.metroArea);
  for (const c of cascade.surroundingCities || []) addToken(c);
  if (cascade.state) {
    addToken(cascade.state);
    const pc = STATE_POSTAL[cascade.state.trim().toLowerCase()];
    if (pc) geoTokens.add(pc);
  }
  // Generic geo tail tokens that should also get stripped if present.
  ["tx", "ca", "ny", "fl", "ga", "ma", "il", "co", "az", "wa", "or", "pa", "nc", "sc", "va", "md", "nj", "oh", "mi", "mn", "wi", "mo", "in", "tn", "ky", "al", "ms", "la", "ar", "ok", "ks", "ne", "ia", "nd", "sd", "mt", "wy", "id", "ut", "nv", "nm", "ak", "hi", "me", "nh", "vt", "ri", "ct", "de", "wv"]
    .forEach((p) => geoTokens.add(p));

  const tokens = keyword.split(/\s+/).filter(Boolean);
  let end = tokens.length;
  while (end > 1 && geoTokens.has(tokens[end - 1].toLowerCase())) {
    end -= 1;
  }
  return tokens.slice(0, end).join(" ");
}

/**
 * Approximate state -> postal code map for stripGeoTail.
 * Just the lowercase full-state-name -> 2-letter code mapping we use to detect
 * trailing state-code tokens.
 */
const STATE_POSTAL: Record<string, string> = {
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

/* ---------------------- main API ---------------------- */

/**
 * Enrich an array of keywords with real Google Ads search volume / CPC /
 * competition. Cascades geo from local -> adjacent -> metro -> state -> root.
 *
 * Returns one result per input keyword (in input order, lowercased match).
 * On total failure (missing creds, network, etc.) returns nulls for every
 * field and geo_layer = "none" so the audit can still render.
 */
export async function enrichKeywords(
  keywords: string[],
  cascade: GeoCascade,
  opts: EnrichOptions = {},
): Promise<KeywordEnrichmentResult[]> {
  const threshold = opts.threshold ?? LOW_VOLUME_THRESHOLD_DEFAULT;
  const languageCode = opts.languageCode ?? "en";

  // Empty input or no creds: return null results immediately.
  const dedupedInput = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
  const nullResult = (kw: string): KeywordEnrichmentResult => ({
    keyword: kw,
    metrics: { sv: null, cpc: null, comp: null, geo_layer: "none" },
    volumeGeo: "",
  });
  if (dedupedInput.length === 0) return [];
  if (!isGoogleAdsEnabled()) {
    return dedupedInput.map(nullResult);
  }

  // Build the ordered cascade of layers to try. Each layer has:
  //   - label (for "geo_layer" output)
  //   - locationName (the DataForSEO location_name string)
  //   - geoHuman (human-readable label for the report's "Volume Geo" column)
  //   - keywordsAt (which list of keywords to try at this layer: the
  //     originals everywhere except the root-phrase retry layer)
  type Layer = { label: GeoLayer; locationName: string; geoHuman: string; keywordsAt: (originals: string[]) => string[] };
  const layers: Layer[] = [];
  if (cascade.city) {
    layers.push({
      label: "local",
      locationName: locationName(cascade.city, cascade.state),
      geoHuman: cascade.state ? `${cascade.city}, ${cascade.state}` : cascade.city,
      keywordsAt: (kws) => kws,
    });
  }
  if (cascade.adjacentCity) {
    layers.push({
      label: "adjacent",
      locationName: locationName(cascade.adjacentCity, cascade.state),
      geoHuman: cascade.state ? `${cascade.adjacentCity}, ${cascade.state}` : cascade.adjacentCity,
      keywordsAt: (kws) => kws,
    });
  }
  // Surrounding cities act as additional "adjacent" attempts before metro.
  for (const c of cascade.surroundingCities || []) {
    if (!c || c === cascade.adjacentCity) continue;
    layers.push({
      label: "adjacent",
      locationName: locationName(c, cascade.state),
      geoHuman: cascade.state ? `${c}, ${cascade.state}` : c,
      keywordsAt: (kws) => kws,
    });
  }
  if (cascade.metroArea) {
    layers.push({
      label: "metro",
      locationName: locationName(cascade.metroArea, cascade.state),
      geoHuman: `${cascade.metroArea} Metro`,
      keywordsAt: (kws) => kws,
    });
  }
  if (cascade.state) {
    layers.push({
      label: "state",
      locationName: locationName(undefined, cascade.state),
      geoHuman: cascade.state,
      keywordsAt: (kws) => kws,
    });
  }
  // Root-phrase retry: strip trailing geo tokens and try at the best layer (metro
  // if available, else state, else national).
  const rootLocation = cascade.metroArea
    ? locationName(cascade.metroArea, cascade.state)
    : cascade.state
      ? locationName(undefined, cascade.state)
      : "United States";
  const rootHuman = cascade.metroArea ? `${cascade.metroArea} Metro (root)` : cascade.state ? `${cascade.state} (root)` : "United States (root)";
  layers.push({
    label: "root",
    locationName: rootLocation,
    geoHuman: rootHuman,
    keywordsAt: (kws) => kws.map((k) => stripGeoTail(k, cascade)),
  });

  // Track which originals still need a usable result. Map from lowercase
  // keyword -> the current best result (with metrics + geoHuman).
  const settled = new Map<string, KeywordEnrichmentResult>();
  let pending = dedupedInput.slice();

  for (const layer of layers) {
    if (pending.length === 0) break;
    const sendKeywords = layer.keywordsAt(pending);
    // For root-phrase we may have mapped originals -> stripped versions; build
    // a map from stripped-lc -> array of originals so we can apply results.
    const strippedToOriginals = new Map<string, string[]>();
    if (layer.label === "root") {
      pending.forEach((orig, i) => {
        const stripped = sendKeywords[i] || orig;
        const k = stripped.toLowerCase();
        const arr = strippedToOriginals.get(k) || [];
        arr.push(orig);
        strippedToOriginals.set(k, arr);
      });
    }
    const results = await fetchVolumesAt(sendKeywords, layer.locationName, languageCode);

    if (layer.label === "root") {
      // Apply stripped results back to their original keywords.
      for (const [strippedLc, originals] of strippedToOriginals.entries()) {
        const r = results.get(strippedLc);
        if (!r) continue;
        const usable = (r.search_volume ?? null) !== null && (opts.acceptAnyNonNull || (r.search_volume ?? 0) >= threshold);
        if (!usable) continue;
        for (const orig of originals) {
          if (settled.has(orig.toLowerCase())) continue;
          settled.set(orig.toLowerCase(), {
            keyword: orig,
            metrics: {
              sv: r.search_volume ?? null,
              cpc: r.cpc ?? null,
              comp: r.competition ?? null,
              geo_layer: "root",
            },
            volumeGeo: layer.geoHuman,
          });
        }
      }
    } else {
      for (const orig of pending) {
        const r = results.get(orig.toLowerCase());
        if (!r) continue;
        const usable = (r.search_volume ?? null) !== null && (opts.acceptAnyNonNull || (r.search_volume ?? 0) >= threshold);
        if (!usable) continue;
        settled.set(orig.toLowerCase(), {
          keyword: orig,
          metrics: {
            sv: r.search_volume ?? null,
            cpc: r.cpc ?? null,
            comp: r.competition ?? null,
            geo_layer: layer.label,
          },
          volumeGeo: layer.geoHuman,
        });
      }
    }
    pending = dedupedInput.filter((k) => !settled.has(k.toLowerCase()));
  }

  // Anything still pending -> null result.
  for (const k of pending) {
    settled.set(k.toLowerCase(), nullResult(k));
  }

  // Preserve input order.
  return dedupedInput.map((k) => settled.get(k.toLowerCase()) || nullResult(k));
}

/* ---------------------- exports for testing ---------------------- */
export const __internal__ = { stripGeoTail, locationName, cleanSecret };
