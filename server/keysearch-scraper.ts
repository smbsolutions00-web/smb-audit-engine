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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Solver } from "2captcha-ts";

const KEYSEARCH_LOGIN_URL = "https://www.keysearch.co/user";
const KEYSEARCH_EXPLORER_URL = "https://www.keysearch.co/explorer";
// 90s — residential proxies add ~2-3s per resource and Keysearch is
// asset-heavy. The browser keeps loading in the background after
// `commit` so we don't actually wait this long; this is the upper bound.
const NAV_TIMEOUT_MS = 90_000;
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

/** Detect whether we landed on a signed-in Explorer view.
   This is stricter than "no login form on the page": if Keysearch bounces
   an unauthenticated session to the marketing homepage, that page also has
   no login form, but it's clearly not a signed-in state.

   Returns true only when:
     1) URL contains /explorer (we got the Explorer page, not redirected away), AND
     2) No login input is visible, AND
     3) Page does not look like the marketing homepage (no "Start your free trial"
        / "affordable SEO tool" markers). */
async function isSignedInOnExplorer(page: Page): Promise<boolean> {
  const url = page.url();
  // Bounced to login
  if (url.includes("/user/login") || url.replace(/\/$/, "") === "https://www.keysearch.co/user") {
    return false;
  }
  // Bounced to marketing homepage
  if (/^https:\/\/(www\.)?keysearch\.co\/?$/.test(url)) {
    return false;
  }
  // Must be on /explorer
  if (!url.includes("/explorer")) {
    return false;
  }
  // Marketing-page text markers (defensive — sometimes redirects keep the URL)
  const isMarketing = await page
    .locator(
      'text="Start your free trial", text="affordable SEO tool", text="Free Trial"',
    )
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (isMarketing) return false;

  // Login form visible
  const hasLoginInput = await page
    .locator('input[placeholder="Email" i], input[placeholder="Password" i]')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  return !hasLoginInput;
}

/** Wipe the cached cookie jar so the next run starts clean. */
function clearCookieJar() {
  try {
    const path = cookieJarPath();
    if (existsSync(path)) {
      unlinkSync(path);
      log("Cleared expired cookie jar");
    }
  } catch (err) {
    log("Failed to clear cookie jar:", err);
  }
}

/** True when a 2Captcha API key is configured. */
function isCaptchaSolverEnabled(): boolean {
  return !!process.env.TWOCAPTCHA_API_KEY;
}

/**
 * Parse PROXY_URL into Playwright's launch-time proxy config and
 * 2Captcha's `proxy` + `proxytype` parameters. Supports the formats:
 *   - http://user:pass@host:port
 *   - https://user:pass@host:port
 *   - socks5://user:pass@host:port
 *   - host:port:user:pass         (Smartproxy/Decodo "flat" format)
 *   - user:pass@host:port         (no scheme — we default to http)
 *   - host:port                   (no auth — IP allowlisted)
 *
 * Returns null when PROXY_URL is unset or unparsable so callers can
 * fall back to direct (no proxy) mode.
 */
type ParsedProxy = {
  playwright: { server: string; username?: string; password?: string };
  twoCaptcha: { proxy: string; proxytype: "HTTP" | "HTTPS" | "SOCKS5" };
  hostPort: string; // for logging without leaking creds
};
function parseProxyUrl(): ParsedProxy | null {
  const raw = (process.env.PROXY_URL || "").trim();
  if (!raw) return null;

  let scheme: "http" | "https" | "socks5" = "http";
  let body = raw;
  const schemeMatch = raw.match(/^(http|https|socks5):\/\/(.*)$/i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase() as any;
    body = schemeMatch[2];
  }

  let username: string | undefined;
  let password: string | undefined;
  let hostPort: string;

  if (body.includes("@")) {
    // user:pass@host:port
    const at = body.lastIndexOf("@");
    const cred = body.slice(0, at);
    hostPort = body.slice(at + 1);
    const colon = cred.indexOf(":");
    if (colon === -1) {
      username = cred;
    } else {
      username = cred.slice(0, colon);
      password = cred.slice(colon + 1);
    }
  } else {
    // Could be host:port  OR  host:port:user:pass
    const parts = body.split(":");
    if (parts.length === 4) {
      hostPort = `${parts[0]}:${parts[1]}`;
      username = parts[2];
      password = parts[3];
    } else {
      hostPort = body;
    }
  }

  // 2Captcha wants "login:password@host:port" (no scheme prefix). If
  // the proxy has no auth, just "host:port".
  const twoCaptchaProxy =
    username !== undefined
      ? `${username}:${password ?? ""}@${hostPort}`
      : hostPort;

  return {
    playwright: {
      server: `${scheme}://${hostPort}`,
      username,
      password,
    },
    twoCaptcha: {
      proxy: twoCaptchaProxy,
      proxytype:
        scheme === "socks5" ? "SOCKS5" : scheme === "https" ? "HTTPS" : "HTTP",
    },
    hostPort,
  };
}

/** True when a residential/datacenter proxy is configured for outbound traffic. */
function isProxyEnabled(): boolean {
  return parseProxyUrl() !== null;
}

/**
 * Detect an hCaptcha challenge on the current page and — if 2Captcha is
 * configured — solve it via 2Captcha and inject the token into the
 * h-captcha-response textarea. Returns:
 *   - "solved"     : a captcha was present AND solved
 *   - "not-needed" : no captcha detected
 *   - "unsolvable" : captcha present but no solver configured / solver failed
 */
type CaptchaResult = "solved" | "not-needed" | "unsolvable";
type CaptchaKind = "hcaptcha" | "recaptcha";
async function solveCaptchaIfPresent(page: Page): Promise<{ result: CaptchaResult; detail?: string }> {
  // Detect either reCAPTCHA v2 or hCaptcha. They look visually similar
  // (image grid challenges) but have different sitekey formats and 2Captcha
  // task types: reCAPTCHA sitekeys start with "6L", hCaptcha sitekeys are UUIDs.
  const detected = await page.evaluate(() => {
    type Hit = { kind: "hcaptcha" | "recaptcha"; sitekey: string };

    // Strategy 1: explicit class hints
    const hCap = document.querySelector(".h-captcha[data-sitekey]") as HTMLElement | null;
    if (hCap?.dataset.sitekey) return { kind: "hcaptcha", sitekey: hCap.dataset.sitekey } as Hit;
    const gCap = document.querySelector(".g-recaptcha[data-sitekey]") as HTMLElement | null;
    if (gCap?.dataset.sitekey) return { kind: "recaptcha", sitekey: gCap.dataset.sitekey } as Hit;

    // Strategy 2: any [data-sitekey], classify by the sitekey shape
    const widget = document.querySelector("[data-sitekey]") as HTMLElement | null;
    if (widget?.getAttribute("data-sitekey")) {
      const k = widget.getAttribute("data-sitekey")!;
      // reCAPTCHA sitekeys always start with "6L". hCaptcha sitekeys are UUIDs.
      const kind = k.startsWith("6L") ? "recaptcha" : "hcaptcha";
      return { kind, sitekey: k } as Hit;
    }

    // Strategy 3: parse sitekey from challenge iframe URL
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const f of iframes) {
      const src = f.getAttribute("src") || "";
      if (src.includes("hcaptcha.com")) {
        const m = src.match(/[?&]sitekey=([^&]+)/);
        if (m) return { kind: "hcaptcha", sitekey: decodeURIComponent(m[1]) } as Hit;
      }
      if (src.includes("google.com/recaptcha") || src.includes("recaptcha.net")) {
        const m = src.match(/[?&]k=([^&]+)/);
        if (m) return { kind: "recaptcha", sitekey: decodeURIComponent(m[1]) } as Hit;
      }
    }
    return null;
  }) as { kind: CaptchaKind; sitekey: string } | null;

  if (!detected) {
    return { result: "not-needed" };
  }

  const { kind, sitekey } = detected;
  log(`${kind} detected (sitekey=${sitekey.slice(0, 12)}…)`);
  if (!isCaptchaSolverEnabled()) {
    return {
      result: "unsolvable",
      detail: `${kind} challenge present but TWOCAPTCHA_API_KEY is not set on the server.`,
    };
  }

  const solver = new Solver(process.env.TWOCAPTCHA_API_KEY as string);

  // Pre-check balance so we surface a clear, actionable error when the
  // 2Captcha account is empty or the API key is wrong, instead of the
  // generic "An Unexpected Error has occurred" the library throws.
  try {
    const balance = await solver.balance();
    log(`2Captcha balance: $${balance}`);
    if (typeof balance === "number" && balance <= 0) {
      return {
        result: "unsolvable",
        detail: `2Captcha balance is $${balance}. Add funds at https://2captcha.com/enterpage`,
      };
    }
  } catch (err: any) {
    const raw = err?.message || err?.error || err?.code || JSON.stringify(err) || String(err);
    log(`2Captcha balance check failed: ${raw}`);
    return {
      result: "unsolvable",
      detail: `2Captcha API rejected the key (balance check). Raw error: ${raw}`,
    };
  }

  // Pass our proxy to 2Captcha so the worker that solves the captcha
  // and the browser submitting the token both come from the same IP —
  // critical for reCAPTCHA v2 trust, since Google ties the token to
  // the IP that solved it.
  const proxy = parseProxyUrl();
  const proxyParams = proxy
    ? { proxy: proxy.twoCaptcha.proxy, proxytype: proxy.twoCaptcha.proxytype }
    : {};
  if (proxy) log(`Routing 2Captcha through proxy ${proxy.hostPort}`);

  log(`Submitting ${kind} to 2Captcha…`);
  let token: string;
  try {
    const res =
      kind === "recaptcha"
        ? await solver.recaptcha({ pageurl: page.url(), googlekey: sitekey, ...proxyParams })
        : await solver.hcaptcha({ pageurl: page.url(), sitekey, ...proxyParams });
    token = res.data;
    log(`2Captcha returned ${kind} token (length=${token.length})`);
  } catch (err: any) {
    const raw =
      err?.error ||
      err?.code ||
      err?.err ||
      err?.message ||
      (typeof err === "object" ? JSON.stringify(err) : String(err));
    log(`2Captcha ${kind} solve threw: ${raw}`);
    return {
      result: "unsolvable",
      detail: `2Captcha ${kind} solve failed. Raw error: ${raw}`,
    };
  }

  // Inject the token. reCAPTCHA puts it in g-recaptcha-response,
  // hCaptcha in h-captcha-response. We set both to be safe — some
  // sites mirror them.
  await page.evaluate((tok) => {
    const setOrCreate = (name: string) => {
      let ta = document.querySelector(`textarea[name="${name}"]`) as HTMLTextAreaElement | null;
      if (!ta) {
        ta = document.createElement("textarea");
        ta.name = name;
        ta.style.display = "none";
        document.body.appendChild(ta);
      }
      ta.value = tok;
      ta.style.display = "block";
    };
    setOrCreate("h-captcha-response");
    setOrCreate("g-recaptcha-response");
  }, token);

  log(`Injected ${kind} token into form`);
  return { result: "solved" };
}

async function performLogin(
  page: Page,
  email: string,
  password: string,
): Promise<{ ok: boolean; captchaDetail?: string }> {
  log("Performing fresh login");
  await page.goto(KEYSEARCH_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  // If we already landed somewhere that has no login form, the cookies
  // were still good — just bail and let the caller navigate to /explorer.
  const hasLoginForm = await page
    .locator('input[placeholder="Email" i], input[placeholder="Password" i]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (!hasLoginForm) {
    log("No login form visible — assuming session still valid");
    return { ok: true };
  }

  try {
    await page.fill('input[placeholder="Email" i]', email, { timeout: 10_000 });
    await page.fill('input[placeholder="Password" i]', password, { timeout: 10_000 });

    // Solve captcha + click Sign In. If the page bounces us back with a
    // fresh challenge (cascading verification — Google distrusts the
    // proxy IP and serves a follow-up), re-solve up to MAX_ATTEMPTS times.
    const MAX_ATTEMPTS = 3;
    let lastCaptchaDetail: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log(`Login attempt ${attempt}/${MAX_ATTEMPTS}`);

      const captcha = await solveCaptchaIfPresent(page);
      if (captcha.result === "unsolvable") {
        log(`Captcha unsolvable: ${captcha.detail}`);
        return { ok: false, captchaDetail: captcha.detail };
      }
      if (captcha.result === "solved") {
        lastCaptchaDetail = captcha.detail;
        // Give the page a moment to register the injected token before submit.
        await page.waitForTimeout(1500);
      }

      // Click Sign In. The button may be the only one on the page or
      // it may have a spinner — try a couple of selectors.
      try {
        await page.click('button:has-text("Sign In")', { timeout: 8_000 });
      } catch {
        await page
          .click('button[type="submit"]', { timeout: 8_000 })
          .catch(() => {});
      }

      // Race: either we navigate away (success) OR we stay on the login
      // page long enough that we know a cascade is in play.
      const navigated = await page
        .waitForURL(
          (u) => !u.toString().includes("/user/login") && !u.toString().endsWith("/user"),
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);

      if (navigated) {
        log(`Login successful on attempt ${attempt}, landed at: ${page.url()}`);
        return { ok: true };
      }

      // Still on login page — let the page finish rendering whatever
      // it served (could be a fresh captcha widget) before next attempt.
      log(`Attempt ${attempt} did not navigate; checking for cascade challenge`);
      await page.waitForTimeout(3_000);
    }

    // All attempts exhausted
    return {
      ok: false,
      captchaDetail:
        lastCaptchaDetail ||
        `Login bounced back ${MAX_ATTEMPTS} times after captcha solves. ` +
          `Google likely distrusts the proxy IP. Try rotating the proxy or waiting.`,
    };
  } catch (err) {
    log("Login failed:", err);
    return { ok: false };
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
    const proxyConfig = parseProxyUrl();
    if (proxyConfig) {
      log(`Routing browser traffic through proxy ${proxyConfig.hostPort}`);
    }
    try {
      browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_LAUNCH_ARGS,
        proxy: proxyConfig?.playwright,
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
    // With a residential proxy, full asset loads can take 30s+, so we wait only
    // for `commit` (URL set, response started) and let assets stream in the
    // background — then poll for either the Explorer UI or the login form.
    try {
      await page.goto(KEYSEARCH_EXPLORER_URL, {
        waitUntil: "commit",
        timeout: NAV_TIMEOUT_MS,
      });
      // Best-effort wait for the page body to render. Don't block on networkidle
      // because Keysearch's analytics/marketing scripts keep the network busy.
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    } catch (err: any) {
      const screenshotPath = await captureDebugScreenshot(page, "navigate");
      throw new KeysearchScrapeError(
        "navigate",
        "Could not reach keysearch.co Explorer page.",
        { detail: err?.message || String(err), pageUrl: page.url(), screenshotPath },
      );
    }

    // We may already be signed in (cached cookies still valid) and on /explorer.
    // If not — either bounced to login OR bounced to the marketing homepage
    // because cookies expired — wipe the jar, log in fresh, and re-navigate.
    if (!(await isSignedInOnExplorer(page))) {
      log(`Not signed in on Explorer (current URL: ${page.url()}). Logging in fresh.`);
      // Cached cookies likely expired — clear them so we don't reuse a bad jar.
      await context.clearCookies().catch(() => {});
      clearCookieJar();

      const loginResult = await performLogin(page, email, password);
      if (!loginResult.ok) {
        const screenshotPath = await captureDebugScreenshot(page, "login");
        const baseMsg = loginResult.captchaDetail
          ? `Keysearch login is gated by a captcha and we couldn't solve it. ${loginResult.captchaDetail}`
          : "Keysearch login failed. Check KEYSEARCH_EMAIL/KEYSEARCH_PASSWORD or look for a captcha/2FA prompt in the screenshot.";
        throw new KeysearchScrapeError(
          "login",
          baseMsg,
          { pageUrl: page.url(), screenshotPath, detail: loginResult.captchaDetail },
        );
      }
      await saveCookies(context);
      // Now navigate to Explorer
      await page.goto(KEYSEARCH_EXPLORER_URL, {
        waitUntil: "commit",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});

      // If we STILL didn't land on Explorer, surface a clear error.
      if (!(await isSignedInOnExplorer(page))) {
        const screenshotPath = await captureDebugScreenshot(page, "login");
        throw new KeysearchScrapeError(
          "login",
          "Logged in but Keysearch did not show the Explorer page. Your account may not include Explorer, or Keysearch redirected the post-login flow elsewhere.",
          { pageUrl: page.url(), screenshotPath },
        );
      }
      log("Login successful, on Explorer page");
    } else {
      log("Reused existing session, already on Explorer");
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
        // Fallback: any visible input that isn't checkbox/radio/hidden/submit.
        // Keysearch's Explorer input has no `type` attribute, so the strict
        // `type="text"` selectors above miss it.
        'input:visible:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
      ];

      // First, give the React app time to hydrate and render any input at all.
      // With residential proxy latency this can take 10-20s after navigation.
      try {
        await page.locator('input:visible').first().waitFor({ state: "visible", timeout: 30_000 });
      } catch {
        // fall through; per-selector loop will produce a clearer error
      }

      let filled = false;
      let lastInputErr: unknown = null;
      for (const sel of inputCandidates) {
        const loc = page.locator(sel).first();
        try {
          await loc.waitFor({ state: "visible", timeout: 8_000 });
          await loc.click({ timeout: 5_000 }).catch(() => {});
          // clear any prefilled text first
          await loc.fill("", { timeout: 5_000 }).catch(() => {});
          await loc.fill(cleanDomain, { timeout: 10_000 });
          log(`Filled domain via selector: ${sel}`);
          filled = true;
          break;
        } catch (err) {
          lastInputErr = err;
        }
      }

      // Last-resort fallback: tag the widest visible input with a unique attr
      // in the page, then use a Playwright locator on that attr. This handles
      // the case where the input has no recognizable attribute at all — the
      // search box is typically the widest visible input on Explorer.
      if (!filled) {
        log("All selectors failed; falling back to widest-visible-input heuristic");
        try {
          const tagged = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
            const visible = inputs.filter((el) => {
              const r = el.getBoundingClientRect();
              const t = (el.type || "text").toLowerCase();
              return (
                r.width > 100 &&
                r.height > 10 &&
                !["checkbox", "radio", "hidden", "submit", "button", "file"].includes(t)
              );
            });
            visible.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            const target = visible[0];
            if (!target) return false;
            target.setAttribute("data-smb-search-input", "1");
            return true;
          });
          if (tagged) {
            const loc = page.locator('[data-smb-search-input="1"]').first();
            await loc.click({ timeout: 5_000 }).catch(() => {});
            await loc.fill("", { timeout: 5_000 }).catch(() => {});
            await loc.fill(cleanDomain, { timeout: 10_000 });
            log("Filled domain via widest-visible-input fallback");
            filled = true;
          }
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

/** True when 2Captcha is wired up to solve hCaptcha challenges. */
export function isKeysearchProxyEnabled(): boolean {
  return isProxyEnabled();
}

export function isKeysearchCaptchaSolverEnabled(): boolean {
  return !!process.env.TWOCAPTCHA_API_KEY;
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
