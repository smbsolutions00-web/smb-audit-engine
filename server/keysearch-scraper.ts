/**
 * Keysearch Explorer scraper.
 *
 * Logs into keysearch.co with KEYSEARCH_EMAIL/KEYSEARCH_PASSWORD,
 * navigates to /explorer, runs a domain lookup, and extracts the
 * visible domain profile. Persists cookies to disk to avoid re-login
 * on every audit.
 *
 * Designed to run on Render Starter (512 MB RAM) with conservative
 * Chromium flags. Falls back gracefully — never throws back to the
 * caller; returns null on any failure and logs the reason.
 */
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEYSEARCH_LOGIN_URL = "https://www.keysearch.co/user";
const KEYSEARCH_EXPLORER_URL = "https://www.keysearch.co/explorer";
const NAV_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 60_000;

/** Where to cache the logged-in cookies between runs. */
function cookieJarPath(): string {
  const dataDir = process.env.DATA_DIR || process.cwd();
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "keysearch-session.json");
}

export interface KeysearchExplorerResult {
  domain: string;
  domainStrength: number | null;          // 0-10
  competitionLevel: string | null;        // "easy-moderate", "moderate", etc.
  competitionScore: number | null;        // 0-100
  backlinks: {
    total: number | null;
    dofollow: number | null;
    nofollow: number | null;
  };
  referringDomains: {
    total: number | null;
    keysearchRank: number | null;
    keysearchDS: number | null;
  };
  organicKeywords: {
    count: number | null;
    estimatedTraffic: number | null;
    topKeywords: Array<{
      keyword: string;
      position: number | null;
      volume: number | null;
      traffic: number | null;
      cpc: number | null;
      score: number | null;
    }>;
  };
  topCompetitors: Array<{
    site: string;
    ds: number | null;
    links: number | null;
    domains: number | null;
    keywords: number | null;
  }>;
  fetchedAt: string;
}

/** Conservative Chromium flags for low-memory environments. */
const CHROMIUM_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--single-process",                 // critical: saves ~150 MB on small instances
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-blink-features=AutomationControlled",
];

function log(msg: string, ...rest: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(`[keysearch-scraper] ${msg}`, ...rest);
}

function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  // strip everything except digits, decimal, minus
  const cleaned = s.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function loadStoredCookies(context: BrowserContext): Promise<boolean> {
  const path = cookieJarPath();
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await context.addCookies(cookies);
    log(`Loaded ${cookies.length} cookies from cache`);
    return true;
  } catch (err) {
    log("Failed to load stored cookies:", err);
    return false;
  }
}

async function saveCookies(context: BrowserContext) {
  try {
    const cookies = await context.cookies();
    writeFileSync(cookieJarPath(), JSON.stringify(cookies, null, 2));
    log(`Saved ${cookies.length} cookies for next run`);
  } catch (err) {
    log("Failed to save cookies:", err);
  }
}

/** Detect whether the page state implies a signed-in user. */
async function isSignedIn(page: Page): Promise<boolean> {
  // Heuristic: signed-in pages don't show the "Sign In" submit button.
  // The Explorer page itself redirects to /user when unauthenticated.
  const url = page.url();
  if (url.includes("/user/login") || url === "https://www.keysearch.co/user") {
    return false;
  }
  // Belt + suspenders: look for any node hinting at the login form
  const hasLoginInput = await page
    .locator('input[placeholder="Email" i], input[placeholder="Password" i]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return !hasLoginInput;
}

async function performLogin(page: Page, email: string, password: string): Promise<boolean> {
  log("Performing fresh login");
  await page.goto(KEYSEARCH_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for either the login form OR a signed-in landing
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  if (await isSignedIn(page)) {
    log("Already signed in (cookies still valid)");
    return true;
  }

  try {
    await page.fill('input[placeholder="Email" i]', email, { timeout: 10_000 });
    await page.fill('input[placeholder="Password" i]', password, { timeout: 10_000 });
    await page.click('button:has-text("Sign In")', { timeout: 10_000 });
    // Wait for navigation away from the login page
    await page.waitForURL(
      (u) => !u.toString().includes("/user/login") && !u.toString().endsWith("/user"),
      { timeout: NAV_TIMEOUT_MS }
    );
    log("Login successful, landed at:", page.url());
    return true;
  } catch (err) {
    log("Login failed:", err);
    return false;
  }
}

/**
 * Pull all visible Explorer data. Each section is best-effort —
 * if Keysearch reshuffles the layout, we want to return what we
 * could parse rather than fail the whole call.
 */
async function extractExplorerData(page: Page, domain: string): Promise<KeysearchExplorerResult> {
  const result: KeysearchExplorerResult = {
    domain,
    domainStrength: null,
    competitionLevel: null,
    competitionScore: null,
    backlinks: { total: null, dofollow: null, nofollow: null },
    referringDomains: { total: null, keysearchRank: null, keysearchDS: null },
    organicKeywords: { count: null, estimatedTraffic: null, topKeywords: [] },
    topCompetitors: [],
    fetchedAt: new Date().toISOString(),
  };

  // Run all extractors in a single page.evaluate for one round-trip.
  const extracted = await page.evaluate(() => {
    const txt = (el: Element | null | undefined) => (el?.textContent || "").trim();
    const findCardByHeading = (headingText: string): Element | null => {
      const heads = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span"));
      for (const h of heads) {
        const t = (h.textContent || "").trim();
        if (t === headingText || t.toLowerCase() === headingText.toLowerCase()) {
          // walk up to find the card container
          let cur: Element | null = h;
          for (let i = 0; i < 5 && cur; i++) {
            cur = cur.parentElement;
            if (cur && (cur as HTMLElement).offsetWidth > 200) return cur;
          }
          return h.parentElement;
        }
      }
      return null;
    };

    // Domain Strength card — gauge with a number 0-10
    let domainStrengthRaw: string | null = null;
    const dsCard = findCardByHeading("Domain Strength");
    if (dsCard) {
      // Look for a large number inside the card
      const nums = Array.from(dsCard.querySelectorAll("*"))
        .map((el) => txt(el))
        .filter((t) => /^\d+(\.\d+)?$/.test(t) && parseFloat(t) <= 10);
      if (nums.length) domainStrengthRaw = nums[0];
    }

    // Competition Level box
    let competitionLevel: string | null = null;
    let competitionScore: string | null = null;
    {
      const allText = document.body.textContent || "";
      const levelMatch = allText.match(/Competition\s+(easy-moderate|easy|moderate|hard-moderate|hard)/i);
      if (levelMatch) competitionLevel = levelMatch[1];
      // Competition score is the small number near the gauge
      const scoreMatch = allText.match(/Competition[^\d]{0,30}(\d+)/);
      if (scoreMatch) competitionScore = scoreMatch[1];
    }

    // Backlinks card
    const backlinksCard = findCardByHeading("Backlinks");
    let backlinksTotal: string | null = null;
    let backlinksDofollow: string | null = null;
    let backlinksNofollow: string | null = null;
    if (backlinksCard) {
      const cardText = backlinksCard.textContent || "";
      const totalMatch = cardText.match(/([\d,]+)\s*Total Backlinks/i);
      if (totalMatch) backlinksTotal = totalMatch[1];
      const dofollowMatch = cardText.match(/Dofollow[^\d]*([\d,]+)/i);
      if (dofollowMatch) backlinksDofollow = dofollowMatch[1];
      const nofollowMatch = cardText.match(/Nofollow[^\d]*([\d,]+)/i);
      if (nofollowMatch) backlinksNofollow = nofollowMatch[1];
    }

    // Referring Domains card
    const refCard = findCardByHeading("Referring Domains");
    let refTotal: string | null = null;
    let keysearchRank: string | null = null;
    let keysearchDS: string | null = null;
    if (refCard) {
      const cardText = refCard.textContent || "";
      const totalMatch = cardText.match(/([\d,]+)\s*Total Domains/i);
      if (totalMatch) refTotal = totalMatch[1];
      const rankMatch = cardText.match(/Keysearch Rank[^\d]*([\d,]+)/i);
      if (rankMatch) keysearchRank = rankMatch[1];
      const dsMatch = cardText.match(/Keysearch DS[^\d]*([\d.]+)/i);
      if (dsMatch) keysearchDS = dsMatch[1];
    }

    // Organic Keywords card
    const okCard = findCardByHeading("Organic Keywords");
    let okCount: string | null = null;
    let okTraffic: string | null = null;
    const topKeywords: Array<{
      keyword: string;
      position: string | null;
      volume: string | null;
      traffic: string | null;
      cpc: string | null;
      score: string | null;
    }> = [];
    if (okCard) {
      const cardText = okCard.textContent || "";
      const countMatch = cardText.match(/^\s*(\d+)\s*\n?\s*(?:Top Keywords By Position|Estimated Traffic)/m)
        || cardText.match(/(\d+)\s*Top Keywords/i);
      if (countMatch) okCount = countMatch[1];
      const trafficMatch = cardText.match(/Estimated Traffic[^\d]*([\d,]+)/i);
      if (trafficMatch) okTraffic = trafficMatch[1];

      // Pull the visible keyword table rows
      const rows = okCard.querySelectorAll("table tr, [role='row']");
      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll("td, [role='cell']"))
          .map((c) => txt(c))
          .filter(Boolean);
        // Expected: Keyword | Position | Volume | Traffic | CPC | Score
        if (cells.length >= 5 && cells[0] && cells[0].length > 1 && !/^Keyword$/i.test(cells[0])) {
          topKeywords.push({
            keyword: cells[0],
            position: cells[1] || null,
            volume: cells[2] || null,
            traffic: cells[3] || null,
            cpc: cells[4] || null,
            score: cells[5] || null,
          });
        }
      });
    }

    // Top Competitors table
    const competitorsCard = findCardByHeading("Top Competitors");
    const topCompetitors: Array<{
      site: string;
      ds: string | null;
      links: string | null;
      domains: string | null;
      keywords: string | null;
    }> = [];
    if (competitorsCard) {
      const rows = competitorsCard.querySelectorAll("table tr, [role='row']");
      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll("td, [role='cell']"))
          .map((c) => txt(c))
          .filter(Boolean);
        // Expected: Site | DS | Links | Domains | Keywords
        if (cells.length >= 4 && cells[0] && !/^Site$/i.test(cells[0])) {
          topCompetitors.push({
            site: cells[0],
            ds: cells[1] || null,
            links: cells[2] || null,
            domains: cells[3] || null,
            keywords: cells[4] || null,
          });
        }
      });
    }

    return {
      domainStrengthRaw,
      competitionLevel,
      competitionScore,
      backlinksTotal,
      backlinksDofollow,
      backlinksNofollow,
      refTotal,
      keysearchRank,
      keysearchDS,
      okCount,
      okTraffic,
      topKeywords,
      topCompetitors,
    };
  });

  result.domainStrength = parseNumber(extracted.domainStrengthRaw);
  result.competitionLevel = extracted.competitionLevel;
  result.competitionScore = parseNumber(extracted.competitionScore);
  result.backlinks.total = parseNumber(extracted.backlinksTotal);
  result.backlinks.dofollow = parseNumber(extracted.backlinksDofollow);
  result.backlinks.nofollow = parseNumber(extracted.backlinksNofollow);
  result.referringDomains.total = parseNumber(extracted.refTotal);
  result.referringDomains.keysearchRank = parseNumber(extracted.keysearchRank);
  result.referringDomains.keysearchDS = parseNumber(extracted.keysearchDS);
  result.organicKeywords.count = parseNumber(extracted.okCount);
  result.organicKeywords.estimatedTraffic = parseNumber(extracted.okTraffic);
  result.organicKeywords.topKeywords = extracted.topKeywords.map((kw: any) => ({
    keyword: kw.keyword,
    position: parseNumber(kw.position),
    volume: parseNumber(kw.volume),
    traffic: parseNumber(kw.traffic),
    cpc: parseNumber(kw.cpc),
    score: parseNumber(kw.score),
  }));
  result.topCompetitors = extracted.topCompetitors.map((c: any) => ({
    site: c.site,
    ds: parseNumber(c.ds),
    links: parseNumber(c.links),
    domains: parseNumber(c.domains),
    keywords: parseNumber(c.keywords),
  }));

  return result;
}

/** Stages the scraper goes through, surfaced on errors so the UI can
   tell login failures from rate-limits from selector breakage. */
export type KeysearchScrapeStep =
  | "config"
  | "launch"
  | "navigate"
  | "login"
  | "explorer-search"
  | "results-timeout"
  | "extraction";

export class KeysearchScrapeError extends Error {
  step: KeysearchScrapeStep;
  pageUrl?: string;
  screenshotPath?: string;
  detail?: string;
  constructor(step: KeysearchScrapeStep, message: string, opts: { pageUrl?: string; screenshotPath?: string; detail?: string } = {}) {
    super(message);
    this.name = "KeysearchScrapeError";
    this.step = step;
    this.pageUrl = opts.pageUrl;
    this.screenshotPath = opts.screenshotPath;
    this.detail = opts.detail;
  }
}

/** Where to dump screenshots on failure for debugging. */
function debugScreenshotPath(label: string): string {
  const dataDir = process.env.DATA_DIR || process.cwd();
  mkdirSync(dataDir, { recursive: true });
  const safe = label.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return join(dataDir, `keysearch-debug-${safe}-${Date.now()}.png`);
}

async function captureDebugScreenshot(page: Page | null, label: string): Promise<string | undefined> {
  if (!page) return undefined;
  try {
    const path = debugScreenshotPath(label);
    await page.screenshot({ path, fullPage: true });
    log(`Debug screenshot: ${path}`);
    return path;
  } catch (err) {
    log("Debug screenshot failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * Public entry point. Throws KeysearchScrapeError on failure with a
 * machine-readable `step` so the API/UI can show a useful message and
 * we can dump a debug screenshot of whatever Keysearch returned.
 *
 * Returns null only when the feature is intentionally disabled or creds
 * are missing (so the caller can route to a different message).
 */
export async function fetchKeysearchExplorer(domain: string): Promise<KeysearchExplorerResult | null> {
  if (process.env.KEYSEARCH_AUTOFETCH_ENABLED !== "true") {
    log("Auto-fetch disabled (KEYSEARCH_AUTOFETCH_ENABLED is not 'true')");
    return null;
  }
  const email = process.env.KEYSEARCH_EMAIL;
  const password = process.env.KEYSEARCH_PASSWORD;
  if (!email || !password) {
    log("Missing KEYSEARCH_EMAIL or KEYSEARCH_PASSWORD");
    return null;
  }

  // Strip protocol if user pasted a full URL
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();
  if (!cleanDomain || !cleanDomain.includes(".")) {
    throw new KeysearchScrapeError("config", `Invalid domain: ${domain}`);
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    log(`Launching Chromium for ${cleanDomain}`);
    try {
      browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_LAUNCH_ARGS,
      });
    } catch (err: any) {
      throw new KeysearchScrapeError(
        "launch",
        "Could not start Chromium on the server.",
        { detail: err?.message || String(err) },
      );
    }
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    await loadStoredCookies(context);
    page = await context.newPage();

    // Try going straight to Explorer. If we get bounced to login, do a fresh login.
    try {
      await page.goto(KEYSEARCH_EXPLORER_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    } catch (err: any) {
      const screenshotPath = await captureDebugScreenshot(page, "navigate");
      throw new KeysearchScrapeError(
        "navigate",
        "Could not reach keysearch.co Explorer page.",
        { detail: err?.message || String(err), pageUrl: page.url(), screenshotPath },
      );
    }

    if (!(await isSignedIn(page))) {
      const ok = await performLogin(page, email, password);
      if (!ok) {
        const screenshotPath = await captureDebugScreenshot(page, "login");
        throw new KeysearchScrapeError(
          "login",
          "Keysearch login failed. Check KEYSEARCH_EMAIL/KEYSEARCH_PASSWORD or look for a captcha/2FA prompt in the screenshot.",
          { pageUrl: page.url(), screenshotPath },
        );
      }
      await saveCookies(context);
      // Now navigate to Explorer
      await page.goto(KEYSEARCH_EXPLORER_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    } else {
      log("Reused existing session");
    }

    // Fill the domain input on Explorer and submit. Keysearch tweaks this
    // page often, so try several locator strategies in order and fall back
    // to pressing Enter if no Search button matches.
    log(`Running Explorer lookup on ${cleanDomain}`);
    try {
      const inputCandidates = [
        'input[placeholder*="domain" i]',
        'input[placeholder*="url" i]',
        'input[placeholder*="website" i]',
        'input[name*="domain" i]',
        'input[name*="url" i]',
        'input[id*="domain" i]',
        'input[type="search"]',
        'main input[type="text"]:visible',
        'form input[type="text"]:visible',
        'input[type="text"]:visible',
      ];
      let filled = false;
      let lastInputErr: unknown = null;
      for (const sel of inputCandidates) {
        const loc = page.locator(sel).first();
        try {
          await loc.waitFor({ state: "visible", timeout: 2000 });
          await loc.click({ timeout: 2000 }).catch(() => {});
          // clear any prefilled text first
          await loc.fill("", { timeout: 2000 }).catch(() => {});
          await loc.fill(cleanDomain, { timeout: 5000 });
          log(`Filled domain via selector: ${sel}`);
          filled = true;
          break;
        } catch (err) {
          lastInputErr = err;
        }
      }
      if (!filled) {
        throw new Error(
          `Could not find domain input. Last error: ${
            lastInputErr instanceof Error ? lastInputErr.message : String(lastInputErr)
          }`,
        );
      }

      // Try clicking a Search button; if none, fall back to Enter.
      const buttonCandidates = [
        'button:has-text("Check Domain")',
        'button:has-text("Analyze")',
        'button:has-text("Search Domain")',
        'button[type="submit"]:has-text("Search")',
        'form button[type="submit"]',
        'button:has-text("Search")',
      ];
      let clicked = false;
      for (const sel of buttonCandidates) {
        try {
          await page.click(sel, { timeout: 2000 });
          log(`Submitted via button: ${sel}`);
          clicked = true;
          break;
        } catch {
          /* try next */
        }
      }
      if (!clicked) {
        log("No Search button matched, pressing Enter");
        await page.keyboard.press("Enter");
      }
    } catch (err: any) {
      const screenshotPath = await captureDebugScreenshot(page, "explorer-search");
      throw new KeysearchScrapeError(
        "explorer-search",
        "Found Keysearch Explorer but couldn't submit the search. The page layout may have changed.",
        { detail: err?.message || String(err), pageUrl: page.url(), screenshotPath },
      );
    }

    // Wait for results to render — the Domain Strength card is a reliable anchor
    try {
      await page.waitForFunction(
        () => {
          const text = document.body.textContent || "";
          return /Domain Strength/i.test(text) && /Backlinks/i.test(text);
        },
        undefined,
        { timeout: RESULT_TIMEOUT_MS }
      );
    } catch (err: any) {
      const screenshotPath = await captureDebugScreenshot(page, "results-timeout");
      // Pull the visible body text so we can spot rate-limit / out-of-credits messages
      let bodySnippet: string | undefined;
      try {
        bodySnippet = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 600);
      } catch {
        /* ignore */
      }
      throw new KeysearchScrapeError(
        "results-timeout",
        "Keysearch did not return Explorer results in time. You may be out of daily credits, rate-limited, or hit a captcha.",
        {
          detail: bodySnippet || err?.message || String(err),
          pageUrl: page.url(),
          screenshotPath,
        },
      );
    }
    // Give charts a moment to settle
    await page.waitForTimeout(2000);

    let data: KeysearchExplorerResult;
    try {
      data = await extractExplorerData(page, cleanDomain);
    } catch (err: any) {
      const screenshotPath = await captureDebugScreenshot(page, "extraction");
      throw new KeysearchScrapeError(
        "extraction",
        "Got Keysearch results but couldn't read them. The page layout may have changed.",
        { detail: err?.message || String(err), pageUrl: page.url(), screenshotPath },
      );
    }
    log(`Extracted: DS=${data.domainStrength}, backlinks=${data.backlinks.total}, refDomains=${data.referringDomains.total}, orgKeywords=${data.organicKeywords.count}, topKeywords=${data.organicKeywords.topKeywords.length}`);

    // Best-effort cookie refresh
    await saveCookies(context);
    return data;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * True when the server is configured to scrape Keysearch on demand:
 * the feature flag is on AND credentials are present.
 */
export function isKeysearchAutofetchEnabled(): boolean {
  return (
    process.env.KEYSEARCH_AUTOFETCH_ENABLED === "true" &&
    !!process.env.KEYSEARCH_EMAIL &&
    !!process.env.KEYSEARCH_PASSWORD
  );
}

/**
 * Convert Explorer result into the same KeywordRow[] shape that the
 * audit engine already expects from a Keysearch CSV. Lets us slot
 * scraped data into the existing pipeline with zero engine changes.
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
