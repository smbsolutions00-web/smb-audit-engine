/**
 * DataForSEO client for the SMB Audit Engine.
 *
 * Replaces the fragile Keysearch browser-automation scraper with a clean
 * JSON API. Produces output in the SAME shape as KeysearchExplorerResult
 * so the rest of the audit pipeline (routes, report generator, PDF) does
 * not need to change.
 *
 * Endpoints used:
 *  - /v3/dataforseo_labs/google/domain_rank_overview/live
 *      → DA-equivalent score, organic keyword count, est. monthly traffic
 *  - /v3/dataforseo_labs/google/ranked_keywords/live
 *      → top organic keywords with position / search volume / CPC / KD
 *  - /v3/backlinks/summary/live
 *      → total / dofollow / nofollow backlink counts, referring domains
 *  - /v3/dataforseo_labs/google/competitors_domain/live
 *      → top competing domains
 *
 * Auth: HTTP Basic with DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD env vars.
 *
 * Cost reference (April 2026): ~$0.05 per audit total.
 */

import type { KeysearchExplorerResult } from "./keysearch-scraper";

const API_BASE = "https://api.dataforseo.com";
const REQUEST_TIMEOUT_MS = 60_000;

function log(msg: string, ...rest: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(`[dataforseo] ${msg}`, ...rest);
}

export class DataForSEOError extends Error {
  step: string;
  detail?: string;
  statusCode?: number;
  constructor(step: string, message: string, opts: { detail?: string; statusCode?: number } = {}) {
    super(message);
    this.name = "DataForSEOError";
    this.step = step;
    this.detail = opts.detail;
    this.statusCode = opts.statusCode;
  }
}

export function isDataForSEOEnabled(): boolean {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN || "";
  const password = process.env.DATAFORSEO_PASSWORD || "";
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

/**
 * POST a task to DataForSEO with timeout + retry handling.
 * `payload` should be the array body the endpoint expects.
 */
async function postLive<T = any>(
  endpoint: string,
  payload: unknown[],
  step: string,
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      throw new DataForSEOError(step, `Request timed out after ${REQUEST_TIMEOUT_MS}ms`, {
        detail: endpoint,
      });
    }
    throw new DataForSEOError(step, `Network error: ${err?.message || err}`, {
      detail: endpoint,
    });
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DataForSEOError(
      step,
      `DataForSEO HTTP ${res.status}`,
      { detail: body.slice(0, 500), statusCode: res.status },
    );
  }

  const json: any = await res.json();
  // DataForSEO wraps everything in { status_code, status_message, tasks: [...] }
  // Each task has its own status_code. 20000 = OK.
  if (json.status_code && json.status_code !== 20000) {
    throw new DataForSEOError(
      step,
      `DataForSEO API error: ${json.status_message || json.status_code}`,
      { detail: JSON.stringify(json).slice(0, 500), statusCode: json.status_code },
    );
  }
  const task = json.tasks?.[0];
  if (task && task.status_code && task.status_code !== 20000) {
    throw new DataForSEOError(
      step,
      `DataForSEO task error: ${task.status_message || task.status_code}`,
      { detail: JSON.stringify(task).slice(0, 500), statusCode: task.status_code },
    );
  }
  return json as T;
}

/**
 * Strip protocol, www., paths from a domain. DataForSEO wants bare hostnames.
 */
function cleanDomain(input: string): string {
  let d = input.trim();
  if (d.includes("://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      /* fall through */
    }
  }
  return d.replace(/^www\./i, "").split("/")[0].toLowerCase();
}

/**
 * Map DataForSEO's keyword_difficulty (0-100) to a competition level label
 * matching what the existing audit engine + UI expects from Keysearch.
 */
function competitionLevelFromScore(score: number | null): string | null {
  if (score == null) return null;
  if (score < 30) return "easy";
  if (score < 50) return "easy-moderate";
  if (score < 70) return "moderate";
  if (score < 85) return "moderate-hard";
  return "hard";
}

/**
 * Fetch ALL Explorer-equivalent data for a domain.
 *
 * Runs the four required endpoints in parallel and assembles a result in
 * the exact shape KeysearchExplorerResult so downstream code is unchanged.
 *
 * Returns null if DataForSEO is not configured (matches Keysearch behavior
 * when KEYSEARCH_AUTOFETCH_ENABLED is off).
 *
 * Throws DataForSEOError on partial/total API failure with a step name
 * the existing error-handling middleware can surface.
 */
export async function fetchDataForSEOExplorer(
  rawDomain: string,
): Promise<KeysearchExplorerResult | null> {
  if (!isDataForSEOEnabled()) {
    log("DataForSEO not configured (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD missing)");
    return null;
  }

  const domain = cleanDomain(rawDomain);
  if (!domain) {
    throw new DataForSEOError("validate", "Empty domain after cleaning", { detail: rawDomain });
  }

  log(`Fetching ${domain} from DataForSEO`);

  // Run all four queries in parallel — independent endpoints, ~2s each.
  const [overviewRes, keywordsRes, backlinksRes, competitorsRes] = await Promise.allSettled([
    postLive("/v3/dataforseo_labs/google/domain_rank_overview/live", [
      { target: domain, language_code: "en", location_code: 2840 /* USA */ },
    ], "overview"),
    postLive("/v3/dataforseo_labs/google/ranked_keywords/live", [
      {
        target: domain,
        language_code: "en",
        location_code: 2840,
        limit: 25,
        order_by: ["ranked_serp_element.serp_item.etv,desc"], // sort by est. traffic
        filters: [
          ["ranked_serp_element.serp_item.rank_group", "<=", 100],
        ],
      },
    ], "keywords"),
    postLive("/v3/backlinks/summary/live", [
      { target: domain, internal_list_limit: 10, include_subdomains: true },
    ], "backlinks"),
    postLive("/v3/dataforseo_labs/google/competitors_domain/live", [
      {
        target: domain,
        language_code: "en",
        location_code: 2840,
        limit: 5,
        exclude_top_domains: true,
      },
    ], "competitors"),
  ]);

  // We allow partial failures — the audit can still run with whatever we got.
  // But if EVERYTHING failed, throw the first error so the user sees something.
  const allFailed = [overviewRes, keywordsRes, backlinksRes, competitorsRes].every(
    (r) => r.status === "rejected",
  );
  if (allFailed) {
    const first = [overviewRes, keywordsRes, backlinksRes, competitorsRes].find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult | undefined;
    throw first?.reason instanceof DataForSEOError
      ? first.reason
      : new DataForSEOError("fetch", "All DataForSEO endpoints failed", {
          detail: String(first?.reason),
        });
  }

  // Helper to safely dig into the DataForSEO response shape.
  const pickResult = (r: PromiseSettledResult<any>): any =>
    r.status === "fulfilled" ? r.value?.tasks?.[0]?.result?.[0] ?? null : null;

  const overview = pickResult(overviewRes);
  const keywords = pickResult(keywordsRes);
  const backlinks = pickResult(backlinksRes);
  const competitors = pickResult(competitorsRes);

  // Log any individual failures but don't throw.
  for (const [name, r] of [
    ["overview", overviewRes],
    ["keywords", keywordsRes],
    ["backlinks", backlinksRes],
    ["competitors", competitorsRes],
  ] as const) {
    if (r.status === "rejected") {
      log(`Endpoint '${name}' failed: ${r.reason}`);
    }
  }

  // ── Domain Strength (0-10) ──────────────────────────────────────────
  // DataForSEO returns Page Rank 0-100. Keysearch's "Domain Strength" is 0-10.
  // We map DataForSEO's domain_rank (0-1000) → 0-10 by dividing by 100.
  // Fallback: derive from main_domain_rank or rank.
  const rawRank: number | null =
    overview?.metrics?.organic?.rank ??
    overview?.rank ??
    overview?.metrics?.organic?.pos_1 // fallback
      ? Math.round(((overview?.metrics?.organic?.rank ?? 0) / 100) * 10)
      : null;

  // Cleaner: domain_rank_overview returns "domain_rank" in items[0]
  const itemsRank: number | null = overview?.items?.[0]?.metrics?.organic?.rank ?? null;
  const domainStrength: number | null = (() => {
    const v = rawRank ?? itemsRank;
    if (v == null) return null;
    // DataForSEO rank scale: 0-1000. Normalize to 0-10.
    return Math.round((Math.min(v, 1000) / 1000) * 10 * 10) / 10;
  })();

  // ── Competition score (0-100) ───────────────────────────────────────
  // Use median keyword difficulty across top keywords.
  const kwItems: any[] = keywords?.items ?? [];
  const difficulties = kwItems
    .map((it) => it?.keyword_data?.keyword_properties?.keyword_difficulty)
    .filter((d): d is number => typeof d === "number");
  difficulties.sort((a, b) => a - b);
  const competitionScore: number | null = difficulties.length
    ? Math.round(difficulties[Math.floor(difficulties.length / 2)])
    : null;

  // ── Backlinks ───────────────────────────────────────────────────────
  const bl = backlinks ?? {};
  const totalBL: number | null = bl.backlinks ?? null;
  const dofollow: number | null = bl.backlinks_spam_score != null
    ? bl.dofollow ?? null
    : bl.dofollow ?? null;
  const nofollow: number | null = bl.nofollow ?? (totalBL != null && dofollow != null ? totalBL - dofollow : null);
  const refDomainsTotal: number | null = bl.referring_domains ?? null;

  // ── Top organic keywords ────────────────────────────────────────────
  const topKeywords = kwItems.slice(0, 10).map((it: any) => {
    const kd = it?.keyword_data ?? {};
    const sei = it?.ranked_serp_element?.serp_item ?? {};
    const info = kd.keyword_info ?? {};
    return {
      keyword: kd.keyword ?? "",
      position: sei.rank_group ?? null,
      volume: info.search_volume ?? null,
      traffic: sei.etv ?? null,
      cpc: info.cpc ?? null,
      score: kd.keyword_properties?.keyword_difficulty ?? null,
    };
  });

  // ── Organic keyword count + est traffic ─────────────────────────────
  const overviewMetrics = overview?.items?.[0]?.metrics?.organic ?? overview?.metrics?.organic ?? {};
  const orgKeywordCount: number | null = overviewMetrics.count ?? overviewMetrics.organic_count ?? kwItems.length ?? null;
  const estTraffic: number | null = overviewMetrics.etv ?? null;

  // ── Top competitors ─────────────────────────────────────────────────
  const compItems: any[] = competitors?.items ?? [];
  const topCompetitors = compItems.slice(0, 5).map((it: any) => {
    const m = it?.metrics?.organic ?? {};
    return {
      site: it?.domain ?? "",
      ds: null, // DataForSEO competitor endpoint doesn't include DS directly
      links: null,
      domains: null,
      keywords: m.count ?? null,
    };
  });

  const result: KeysearchExplorerResult = {
    domain,
    domainStrength,
    competitionLevel: competitionLevelFromScore(competitionScore),
    competitionScore,
    backlinks: {
      total: totalBL,
      dofollow,
      nofollow,
    },
    referringDomains: {
      total: refDomainsTotal,
      keysearchRank: null, // not provided by DataForSEO
      keysearchDS: domainStrength, // mirror domainStrength here for compatibility
    },
    organicKeywords: {
      count: orgKeywordCount,
      estimatedTraffic: estTraffic,
      topKeywords,
    },
    topCompetitors,
    fetchedAt: new Date().toISOString(),
  };

  log(
    `Fetched ${domain}: DS=${domainStrength}, BL=${totalBL}, RD=${refDomainsTotal}, KW=${orgKeywordCount}`,
  );
  return result;
}

/**
 * Convert DataForSEO result into the same KeywordRow[] shape that the
 * audit engine already expects from a Keysearch CSV.
 *
 * (Same signature as keysearch-scraper.explorerToKeywordRows so callers
 * can swap in either function.)
 */
export function explorerToKeywordRows(data: KeysearchExplorerResult): Array<{
  keyword: string;
  position: number | null;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
}> {
  return data.organicKeywords.topKeywords.map((kw) => ({
    keyword: kw.keyword,
    position: kw.position,
    volume: kw.volume,
    difficulty: kw.score,
    cpc: kw.cpc,
    intent: null,
  }));
}
