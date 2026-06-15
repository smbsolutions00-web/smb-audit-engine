/**
 * Manus Send-to-Slides integration
 * --------------------------------
 * Asynchronously generates a simplified, client-facing slide deck from an
 * audit report, using the Manus Slides API. Supports both image-mode
 * templates (nano-banana, returns zip of PNGs) and HTML-mode templates
 * (Glamour, etc., return PDF or PPTX directly).
 *
 * Flow (all server-side, no client polling against Manus):
 *   1. POST /v2/task.create — kick off task with our prompt + (optional) logo
 *      data URL + template_uid.
 *   2. Background poller pings /v2/task.detail every 8s until terminal status.
 *   3. On completion, GET /v2/task.listMessages and pull whatever
 *      deliverables Manus produced: PDF, PPTX, ZIP of slide images, etc.
 *   4. Save to DATA_DIR/manus-decks/<auditId>/, normalize to a `slides.pdf`
 *      that the UI can download.
 *   5. Persist deck state in audits.manus_export and append timeline events.
 *
 * Auth: x-manus-api-key header (Bearer fails on this account).
 * Endpoint: https://api.manus.ai
 */
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { storage } from "./storage";
import type { Audit, ReportData } from "@shared/schema";
import { jsPDF } from "jspdf";
import sharp from "sharp";

const MANUS_BASE = "https://api.manus.ai";
// Whiteboard nano-banana template (hand-drawn marker style, the look
// Krystal/Dwayne confirmed by clicking Create Slides > Whiteboard in the
// Manus UI). The Glamour HTML template produced clean teal blocks that
// felt corporate and bulky; switching back to whiteboard renders every
// slide as an illustrated marker-on-whiteboard scene.
const TEMPLATE_UID = "whiteboard_c936ac40-1dc4-4f4f-b583-991de9f2dd08";
const MODEL = "nano-banana";
const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const DECK_ROOT = join(DATA_DIR, "manus-decks");

function manusHeaders(extra: Record<string, string> = {}) {
  const key = (process.env.MANUS_API_KEY || "").trim().replace(/^\uFEFF/, "");
  if (!key) throw new Error("MANUS_API_KEY is not configured");
  return {
    "x-manus-api-key": key,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

export interface ManusExportState {
  taskId?: string;
  status: "queued" | "running" | "complete" | "failed";
  error?: string;
  taskUrl?: string;
  prompt?: string;
  zipFilename?: string;
  pdfFilename?: string;
  pptxFilename?: string;
  slideCount?: number;
  hasPdf?: boolean;
  hasZip?: boolean;
  hasPptx?: boolean;
  logoAdjusted?: boolean; // true when we padded a dark logo onto a white background
  // Locked-in deck theme so every regenerate produces the same palette.
  // Set once on first run from the logo or by the user, then reused.
  themePrimary?: string;  // hex like "#A4577B"
  themeAccent?: string;   // hex like "#F2E4EC"
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

function readState(audit: Audit): ManusExportState | null {
  if (!audit.manusExport) return null;
  try {
    return JSON.parse(audit.manusExport) as ManusExportState;
  } catch {
    return null;
  }
}

async function writeState(auditId: string, patch: Partial<ManusExportState>) {
  const audit = await storage.getAudit(auditId);
  if (!audit) return;
  const prev = readState(audit) || ({} as ManusExportState);
  const next: ManusExportState = {
    status: "queued",
    startedAt: Date.now(),
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  };
  await storage.updateAudit(auditId, { manusExport: JSON.stringify(next) });
}

export async function getManusState(auditId: string): Promise<ManusExportState | null> {
  const audit = await storage.getAudit(auditId);
  if (!audit) return null;
  return readState(audit);
}

interface TaskDetail {
  ok: boolean;
  task?: { id: string; status: string; task_url?: string };
}

/**
 * On-demand reconciliation: if our local state says a task is still
 * queued/running but the in-process background poller is gone (e.g. the
 * server was restarted by a Render redeploy), ask Manus directly for the
 * current task status and collect deliverables if it is actually done.
 *
 * Called from /api/audits/:id/manus-status. Safe to call repeatedly; if
 * Manus is still running we just refresh updatedAt as a heartbeat.
 */
export async function reconcileManusState(auditId: string): Promise<ManusExportState | null> {
  const audit = await storage.getAudit(auditId);
  if (!audit) return null;
  const state = readState(audit);
  if (!state || !state.taskId) return state;
  // Only reconcile while we still think Manus is working.
  if (state.status !== "queued" && state.status !== "running") return state;

  try {
    const r = await fetch(
      `${MANUS_BASE}/v2/task.detail?task_id=${encodeURIComponent(state.taskId)}`,
      { headers: manusHeaders() },
    );
    const j = (await r.json()) as TaskDetail;
    const remoteStatus = j?.task?.status || "";
    if (remoteStatus === "stopped" || remoteStatus === "completed" || remoteStatus === "succeeded") {
      try {
        await collectDeliverables(auditId, state.taskId);
      } catch (err: any) {
        await writeState(auditId, { status: "failed", error: err?.message || String(err) });
        await storage.appendEvent(auditId, "manus_deck_failed", { error: err?.message });
      }
    } else if (remoteStatus === "failed" || remoteStatus === "error" || remoteStatus === "cancelled") {
      await writeState(auditId, { status: "failed", error: `Manus task ended with status: ${remoteStatus}` });
      await storage.appendEvent(auditId, "manus_deck_failed", { error: remoteStatus });
    } else {
      // Still running. Heartbeat updatedAt so the UI knows the row is live.
      await writeState(auditId, { status: "running" });
    }
  } catch (err) {
    console.error(`[manus] reconcile failed for ${auditId}:`, err);
    // Don't flip status on transient errors; just leave state as-is.
  }

  return getManusState(auditId);
}

function deckDir(auditId: string) {
  const d = join(DECK_ROOT, auditId);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Persist the original client logo so a regenerate run can reuse it without
 * the user re-uploading. Stored as `logo-original.<ext>` in the deck dir.
 */
function persistLogo(auditId: string, dataUrl: string): void {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return;
  const [, mimeType, b64] = match;
  const ext = (mimeType.split("/")[1] || "png").replace("svg+xml", "svg");
  const buf = Buffer.from(b64, "base64");
  const dir = deckDir(auditId);
  writeFileSync(join(dir, `logo-original.${ext}`), buf);
  // Also write a tiny sidecar with the mime type so we can rebuild a data URL on read.
  writeFileSync(join(dir, "logo-original.mime"), mimeType);
}

function readPersistedLogo(auditId: string): string | null {
  const dir = join(DECK_ROOT, auditId);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir).filter((f) => /^logo-original\.(png|jpe?g|webp|gif|svg)$/i.test(f));
  if (!candidates.length) return null;
  const file = join(dir, candidates[0]);
  const buf = readFileSync(file);
  let mime = "image/png";
  try {
    const mimePath = join(dir, "logo-original.mime");
    if (existsSync(mimePath)) mime = readFileSync(mimePath, "utf8").trim() || mime;
  } catch {}
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Logo preparation: ALWAYS composite the uploaded logo onto a white
 * rounded-corner card before sending to Manus. The Glamour template uses
 * a dark cover, so any logo with dark text (Fiorina-style) becomes invisible
 * without a light backing. White-carding every logo is cheaper than trying
 * to detect edge luminance against transparent backgrounds and prevents
 * credit-wasting invisible-cover runs.
 *
 * SVG inputs are rasterized to PNG first. The output is a 1200x800 PNG
 * with the logo centered, fit inside an 84% inner box.
 */
async function prepareLogo(
  logoDataUrl: string,
): Promise<{ dataUrl: string; adjusted: boolean }> {
  const match = logoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return { dataUrl: logoDataUrl, adjusted: false };
  const [, mimeType, b64] = match;
  const inputBuf = Buffer.from(b64, "base64");

  try {
    const isSvg = /svg/i.test(mimeType);
    const inputImg = isSvg
      ? sharp(inputBuf, { density: 300 }).resize({ width: 1024, withoutEnlargement: false }).png()
      : sharp(inputBuf);

    const meta = await inputImg.metadata();
    if (!meta.width || !meta.height) {
      return { dataUrl: logoDataUrl, adjusted: false };
    }

    // Composite the logo (centered, with ~8% padding) onto a 1200x800 white card.
    const targetW = 1200;
    const targetH = 800;
    const innerW = Math.floor(targetW * 0.84);
    const innerH = Math.floor(targetH * 0.84);
    const resized = await inputImg
      .clone()
      .resize({ width: innerW, height: innerH, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();

    const outPng = await sharp({
      create: {
        width: targetW,
        height: targetH,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([{ input: resized, gravity: "center" }])
      .png({ compressionLevel: 9 })
      .toBuffer();

    return {
      dataUrl: `data:image/png;base64,${outPng.toString("base64")}`,
      adjusted: true,
    };
  } catch (err) {
    console.warn("[manus] logo prep failed, sending original:", err);
    return { dataUrl: logoDataUrl, adjusted: false };
  }
}

/**
 * Extract a primary (most saturated dominant) and accent (lighter variant)
 * hex color from a logo. Uses sharp's downscale + per-pixel hue bucketing
 * to avoid pulling background pixels.
 *
 * Returns null if the logo cannot be analyzed.
 */
async function extractLogoTheme(logoDataUrl: string): Promise<{ primary: string; accent: string } | null> {
  const match = logoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, b64] = match;
  const isSvg = /svg/i.test(mimeType);
  const inputBuf = Buffer.from(b64, "base64");
  try {
    const img = isSvg
      ? sharp(inputBuf, { density: 200 }).resize({ width: 256 }).png()
      : sharp(inputBuf).resize({ width: 256, withoutEnlargement: true });
    const { data, info } = await img
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const buckets = new Map<string, { r: number; g: number; b: number; sat: number; count: number }>();
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3] ?? 255;
      if (a < 200) continue; // skip transparent
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max; // 0..1
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0..1
      // skip near-white and near-black so we don't pick background pixels.
      if (lum > 0.95 || lum < 0.05) continue;
      if (sat < 0.2) continue; // skip gray
      // bucket by 24-step hue quantization
      const key = `${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`;
      const prev = buckets.get(key);
      if (prev) { prev.count++; }
      else buckets.set(key, { r, g, b, sat, count: 1 });
    }
    if (buckets.size === 0) return null;
    // sort by count * saturation so colorful dominant wins over slightly-saturated huge area.
    const sorted = Array.from(buckets.values()).sort((a, b) => b.count * b.sat - a.count * a.sat);
    const top = sorted[0];
    const toHex = (r: number, g: number, b: number) =>
      `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    const primary = toHex(top.r, top.g, top.b);
    // accent = same hue, lightened toward white by mixing 70% white.
    const lighten = (v: number) => Math.round(v * 0.3 + 255 * 0.7);
    const accent = toHex(lighten(top.r), lighten(top.g), lighten(top.b));
    return { primary, accent };
  } catch (err) {
    console.warn("[manus] theme extraction failed:", err);
    return null;
  }
}

/**
 * Build the Manus prompt for the Glamour HTML-mode template.
 *
 * Structure (dynamic count, problems-first):
 *   1. Cover
 *   2. Executive Summary (overall grade + 4 pillar scores)
 *   3..N. Per-pillar slides (problem + solution combined). SEO is split
 *         into TWO slides: Keywords (ranking vs opportunity) and
 *         Directory Trust + NAP.
 *   N+1. (Optional) Where You Are Holding Ground (steady pillars)
 *   N+2. Four Pillars + CRM Hub (architecture overview, RIGHT BEFORE the CRM)
 *   N+3. SMB Smart CRM
 *   N+4. Your 90-Day Plan
 *   N+5. Let's Get To Work (CTA)
 *
 * Glamour is HTML-mode so Manus handles layout. The prompt provides the
 * CONTENT plus targeted IMAGERY directives (icons, mockups, charts) per
 * slide, in keeping with Glamour's editable element library. No raw CSS
 * or layout instructions — those override the template.
 */
export function buildPrompt(
  audit: Audit,
  report: ReportData | null,
  theme?: { primary?: string; accent?: string; slideLimit?: number },
): string {
  // Theme args are intentionally ignored in whiteboard nano-banana mode.
  // The whiteboard template renders its own marker-on-board styling and
  // any LAYOUT or color directives override it back into corporate HTML.
  const slideLimit = theme?.slideLimit;
  const cn = audit.clientName || "the client";
  const ownerRaw = (audit as any).contactName || (audit as any).ownerName || "";
  const ownerFirst = String(ownerRaw).trim().split(/\s+/)[0] || "";
  const ind = audit.industry || "their industry";
  const loc = audit.location || "their service area";
  const overallGrade = audit.overallGrade || "";
  const overallScore = audit.overallScore ?? null;

  // ----- Pull real numbers from the report so Manus renders facts.
  const ai = report?.pillars?.aiAutomation;
  const seo = report?.pillars?.seoListings;
  const rep = report?.pillars?.reputation;
  const social = report?.pillars?.socialMedia;
  const live = (report as any)?.liveValidation;
  const gbpRating: number | null = live?.gbp?.rating ?? null;
  const gbpReviewCount: number | null = live?.gbp?.reviewCount ?? null;

  const ranking = report?.seoDeep?.rankingKeywords?.slice(0, 3) || [];
  const opportunity = report?.seoDeep?.opportunityKeywords?.slice(0, 7) || [];
  const listings = report?.seoDeep?.listings || [];
  const missing = listings.filter((l) => l.status === "Missing");
  const totalListings = listings.length || 0;

  const aiPresent = ai?.platforms?.filter((p) => p.present) || [];
  const aiAbsent = ai?.platforms?.filter((p) => !p.present) || [];

  // ----- Classify each pillar so we tell the story problems-first.
  type PillarSlot = {
    key: "ai" | "seo" | "social" | "reputation";
    label: string;
    score?: number;
    grade?: string;
    summary?: string;
    gaps?: string[];
    strengths?: string[];
    severity: "critical" | "weak" | "steady";
  };
  const severityOf = (score?: number): PillarSlot["severity"] => {
    if (score === undefined || score === null) return "weak";
    if (score < 60) return "critical";
    if (score < 75) return "weak";
    return "steady";
  };
  const pillarSlots: PillarSlot[] = [
    {
      key: "ai",
      label: "AI & Automation",
      score: ai?.score,
      grade: ai?.grade,
      summary: ai?.summary,
      gaps: ai?.gaps,
      strengths: ai?.strengths,
      severity: severityOf(ai?.score),
    },
    {
      key: "seo",
      label: "SEO, Keywords & Listings",
      score: seo?.score,
      grade: seo?.grade,
      summary: seo?.summary,
      gaps: seo?.gaps,
      strengths: seo?.strengths,
      severity: severityOf(seo?.score),
    },
    {
      key: "social",
      label: "Social Media",
      score: social?.score,
      grade: social?.grade,
      summary: social?.summary,
      gaps: social?.gaps,
      strengths: social?.strengths,
      severity: severityOf(social?.score),
    },
    {
      key: "reputation",
      label: "Reputation",
      score: rep?.score,
      grade: rep?.grade,
      summary: rep?.summary,
      gaps: rep?.gaps,
      strengths: rep?.strengths,
      severity: severityOf(rep?.score),
    },
  ];
  const problemPillars = pillarSlots.filter(
    (p) => p.severity === "critical" || p.severity === "weak",
  );
  const steadyPillars = pillarSlots.filter((p) => p.severity === "steady");

  // NAP / directory totals.
  const claimed = listings.filter((l) => l.status === "Listed" && l.napAccurate !== false).length;
  const napScore = report?.seoDeep?.napConsistency?.score;
  const directoriesAuditedLine = totalListings
    ? `Google checks ${totalListings} directories to verify a business is real, local, and trustworthy. ${cn} is currently listed and accurate on only ${claimed} of those ${totalListings}.`
    : "";

  const missingLine = missing.slice(0, 6).map((l) => l.directory).join(", ");

  // Total monthly opportunity volume.
  const totalOpportunityVolume = opportunity.reduce(
    (sum, k) => sum + (k.volume || 0),
    0,
  );

  // ===== Build the slide list.
  const slides: string[] = [];

  // ---------- SLIDE: Cover ----------
  slides.push(
    [
      "COVER",
      `Title: "Digital Presence Audit".`,
      `Subtitle: "${cn}".`,
      `Location line: "${loc}".`,
      `Footer line: "Prepared by Dwayne Johnson, SMB Solutions".`,
      `Tagline: "Faith-rooted strategy. Seamless integration. Real human support."`,
      `If a client logo was attached, include it on the cover.`,
    ].join("\n"),
  );

  // ---------- SLIDE: Executive Summary ----------
  slides.push(
    [
      "EXECUTIVE SUMMARY",
      `Title: "Where ${cn} Stands Today".`,
      overallGrade || overallScore !== null
        ? `Headline: Overall Digital Presence Grade is ${overallGrade || ""}${overallScore !== null ? ` (${overallScore}/100)` : ""}.`
        : "",
      `Show the four pillar scores in a clean scoreboard layout. Use a large grade badge (A through F) next to each pillar.`,
      ...pillarSlots.map(
        (p) =>
          `  - ${p.label}: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}`,
      ),
      problemPillars.length
        ? `Closing line: "${problemPillars.length} of 4 pillars need focused attention. The opportunity is real, and the path forward is clear."`
        : `Closing line: "All four pillars are healthy. The opportunity now is to sharpen, scale, and protect what is working."`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // ====================================================================
  // PER-PILLAR SLIDES, problems first. SEO gets TWO slides.
  // ====================================================================

  for (const p of problemPillars) {
    if (p.key === "ai") {
      const aiBullets: string[] = [];
      if (aiAbsent.length) {
        aiBullets.push(`  ${cn} is NOT cited on these AI assistants: ${aiAbsent.map((a) => a.platform).join(", ")}.`);
      } else {
        aiBullets.push(`  ${cn} is not cited on the major AI platforms audited.`);
      }
      if (aiPresent.length) {
        aiBullets.push(`  ${cn} IS cited on: ${aiPresent.map((a) => a.platform).join(", ")}.`);
      }
      (p.gaps || []).forEach((g) => aiBullets.push(`  - ${g}`));
      if (aiBullets.length < 3) {
        const fallbacks = [
          `  - No 24/7 capture layer for after-hours phone, chat, and form inquiries.`,
          `  - No automated follow-up sequence after first contact, so warm leads cool quickly.`,
          `  - No unified inbox routing messages from phone, chat, email, and social into one queue.`,
        ];
        for (const f of fallbacks) {
          if (aiBullets.length >= 3) break;
          if (!aiBullets.includes(f)) aiBullets.push(f);
        }
      }
      slides.push(
        [
          "AI & AUTOMATION",
          `Title: "AI & Automation".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...aiBullets,
          `  Key insight: Every search that goes to an AI today is a customer ${cn} cannot recover.`,
          `Section 2, The Answer:`,
          `  A 24/7 AI Workforce that captures every lead and inquiry, across phone, chat, email, and social, and routes them into one unified inbox.`,
          `  Core agents: AI Receptionist, Chat Agent, Support Agent, Follow-Up Agent, Routing Agent.`,
          `  Outcome line: "Never miss a lead or customer inquiry again."`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "seo") {
      // SEO SLIDE 1: Keywords
      slides.push(
        [
          "SEO PART 1, KEYWORDS",
          `Title: "Keywords, Where Customers Are Searching".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ranking.length
            ? `  Currently ranking for: ${ranking.map((k) => `${k.keyword}${k.position ? ` (rank #${k.position})` : ""}${k.volume ? `, ${k.volume.toLocaleString()}/mo` : ""}`).join("; ")}.`
            : `  No keywords are currently ranking for ${cn}.`,
          opportunity.length
            ? `  Opportunity keywords going to competitors: ${opportunity.map((k) => `${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()}/mo)` : ""}`).join("; ")}.`
            : "",
          totalOpportunityVolume
            ? `  Headline number: ${totalOpportunityVolume.toLocaleString()} people per month are searching for what ${cn} sells in ${loc}, and going to competitors.`
            : "",
          `Section 2, The Answer:`,
          `  Be the answer Google AND AI engines pick first. Local SEO, AEO (Answer Engine Optimization), and GEO (Generative Engine Optimization), tuned to the highest-volume opportunity keywords above.`,
          `  Publish targeted content, optimize on-page signals, and earn citations.`,
          `  Outcome line: "Capture the searches your competitors are winning today."`,
          `Where you rank:`,
          ...ranking.map(
            (k) =>
              `  - ${k.keyword}, rank #${k.position ?? "?"}, ${(k.volume ?? 0).toLocaleString()}/mo`,
          ),
          `What you miss:`,
          ...opportunity.map(
            (k) =>
              `  - ${k.keyword}, ${(k.volume ?? 0).toLocaleString()}/mo`,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      // SEO SLIDE 2: Listings + NAP
      slides.push(
        [
          "SEO PART 2, DIRECTORY TRUST & NAP",
          `Title: "Directory Trust and NAP Consistency".`,
          `Section 1, The Gap:`,
          totalListings
            ? `  Google checks ${totalListings} directories to verify a business is real, local, and trustworthy. ${cn} is currently listed and accurate on only ${claimed} of those ${totalListings}.`
            : "",
          napScore !== undefined
            ? `  NAP Consistency Score: ${napScore}/100. When name, address, and phone do not match across the web, Google stops trusting the business and demotes it in local results.`
            : "",
          missingLine ? `  Notable missing directories: ${missingLine}.` : "",
          `  Key insight: Trust is built one consistent listing at a time. Inconsistent listings actively damage rankings.`,
          `Section 2, The Answer:`,
          `  Claim and standardize every directory listing. Rebuild NAP consistency across the top 50+ citation sources. Lock down Google Business Profile, Bing Places, Apple Maps, and major industry directories.`,
          `  Outcome line: "Show up everywhere customers look, with the same name, address, and phone."`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "social") {
      const socialBullets: string[] = [];
      (p.strengths || []).forEach((s) => socialBullets.push(`  - What is working: ${s}`));
      (p.gaps || []).forEach((g) => socialBullets.push(`  - What is being missed: ${g}`));
      if (socialBullets.length < 3) {
        const fallbacks = [
          `  - Posting cadence is inconsistent across platforms, gaps weaken algorithmic reach.`,
          `  - Content is not repurposed across Facebook, Instagram, TikTok, and LinkedIn, so each platform fights for net-new effort.`,
          `  - No central calendar or approval flow, which makes scaling beyond the owner's bandwidth impossible.`,
        ];
        for (const f of fallbacks) {
          if (socialBullets.length >= 3) break;
          if (!socialBullets.includes(f)) socialBullets.push(f);
        }
      }
      slides.push(
        [
          "SOCIAL MEDIA",
          `Title: "Social Media".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...socialBullets,
          `  Key insight: Manual posting on every platform every week is unsustainable. This is where burnout starts.`,
          `Section 2, The Answer:`,
          `  An AI-assisted content calendar across Facebook, Instagram, TikTok, and LinkedIn. Posts drafted, scheduled, and tracked from one dashboard.`,
          `  Outcome line: "Stay visible and relevant without constant manual effort."`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "reputation") {
      // Build at least 3 concrete gap bullets even when strengths/gaps arrays
      // are empty, otherwise Manus renders the slide header-only.
      const repGapBullets: string[] = [];
      (p.strengths || []).forEach((s) => repGapBullets.push(`  - What is working: ${s}`));
      (p.gaps || []).forEach((g) => repGapBullets.push(`  - What is being missed: ${g}`));
      if (gbpRating !== null && gbpReviewCount !== null) {
        repGapBullets.push(
          `  - Google Business Profile sits at ${gbpRating.toFixed(1)} stars across ${gbpReviewCount.toLocaleString()} reviews. Volume and velocity, not just stars, drive ranking.`,
        );
      }
      if (repGapBullets.length < 3) {
        // Canned fallbacks so the slide always carries a story.
        const fallbacks = [
          `  - No structured review request cadence after each transaction. Most customers are happy but never asked.`,
          `  - Reviews are not consistently responded to within 24 hours, which Google weighs as a trust signal.`,
          `  - Review volume is not flowing into Google Business Profile at the pace local competitors set.`,
        ];
        for (const f of fallbacks) {
          if (repGapBullets.length >= 3) break;
          if (!repGapBullets.includes(f)) repGapBullets.push(f);
        }
      }
      slides.push(
        [
          "REPUTATION",
          `Title: "Reputation".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...repGapBullets,
          `  Key insight: Stars do not collect themselves. Without a system to ask, follow up, and respond, the next ten reviews could go either way.`,
          `Section 2, The Answer:`,
          `  A reputation system: automated review requests after every transaction, fast review responses, and 5-star reviews flowing into Google Business Profile on a steady cadence.`,
          `  Outcome line: "Turn trust into more calls, bookings, and sales."`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
  }

  // Steady (B/C/A) pillars get a single consolidated slide.
  if (steadyPillars.length) {
    slides.push(
      [
        "WHERE YOU ARE HOLDING GROUND",
        `Title: "Where ${cn} Is Holding Ground".`,
        `Subtitle: "Real strengths we protect while we fix what is broken."`,
        ...steadyPillars.map(
          (p) =>
            `  - ${p.label} (${p.score ?? "?"}/100${p.grade ? `, Grade ${p.grade}` : ""}): ${p.summary || "steady performance"}`,
        ),
      ].join("\n"),
    );
  }

  // ---------- SLIDE: SMB Smart CRM (STATIC) ----------
  slides.push(
    [
      "SMB SMART CRM",
      `STATIC SLIDE. Do not improvise the content below.`,
      `Title: "SMB Smart CRM".`,
      `Subtitle: "The Centralized Operational Backbone of Your Business."`,
      `Six core capabilities (in this order):`,
      `  1. Capture and organize leads from calls, forms, chat, and messages`,
      `  2. Track every interaction in one unified customer timeline`,
      `  3. Manage sales stages, pipelines, and opportunities visually`,
      `  4. Automate follow-ups, reminders, and task assignments`,
      `  5. Sync seamlessly with email, SMS, and scheduling tools`,
      `  6. Keep your business organized, responsive, and growing`,
      `Closing line: "Built around four pillars, connected through one unified client hub."`,
    ].join("\n"),
  );

  // ---------- SLIDE: 90-Day Plan ----------
  slides.push(
    [
      "YOUR 90-DAY PLAN",
      `Title: "Your Next 90 Days".`,
      `Subtitle: "No overwhelm. Right tools, right support, right pace."`,
      `Phase 1 (Days 1 to 30), Foundation: claim and standardize directory listings, fix NAP, set up review collection.`,
      `Phase 2 (Days 31 to 60), Activation: launch the AI workforce, activate review automation, activate the social content calendar.`,
      `Phase 3 (Days 61 to 90), Acceleration: keyword content build out, authority and link building, reporting cadence.`,
      `Closing line: "Each step can be completed without adding stress to your week. That is what SMB Solutions is here for."`,
    ].join("\n"),
  );

  // ---------- SLIDE: Let's Get To Work ----------
  slides.push(
    [
      "LET'S GET TO WORK",
      `Title: "Let's Get To Work".`,
      `Three closing statements arranged as three large cards or columns:`,
      `  - The Verdict: "The foundation is real. The gaps are fixable. The opportunity is now."`,
      `  - The Focus: "Pillar fixes, dashboards, real human support."`,
      `  - The Outcome: "A predictable, scalable system for capturing and keeping customers."`,
      `Tagline (below the three cards): "Faith-rooted strategy. Seamless integration. Real human support."`,
      `Call to action: A clear START callout inviting the client to begin.`,
    ].join("\n"),
  );

  // ===== Assemble. Optional slideLimit truncates for a fast 1-slide preview.
  const finalSlides = typeof slideLimit === "number" && slideLimit > 0
    ? slides.slice(0, slideLimit)
    : slides;
  const numberedSlides = finalSlides
    .map((slideBody, i) => {
      const n = String(i + 1).padStart(2, "0");
      return `slide-${n}\n${slideBody}`;
    })
    .join("\n\n");
  const slideCount = finalSlides.length;

  return [
    `Client: ${cn}`,
    ownerFirst ? `Owner first name: ${ownerFirst}` : "",
    `Industry: ${ind}`,
    `Location: ${loc}`,
    overallGrade || overallScore !== null
      ? `Overall audit grade: ${overallGrade}${overallScore !== null ? ` (${overallScore}/100)` : ""}`
      : "",
    "",
    "==================================================================",
    "DECK CONTENT",
    "==================================================================",
    `This is a Digital Presence Audit prepared by Dwayne Johnson at SMB Solutions for ${cn}. Use the slide content below in order. Render each slide using this template's default styling. Do not add layout, typography, color, or chart directives beyond what is written here, just present the content cleanly.`,
    "",
    "BRAND VOICE RULES:",
    "- Never say 'Vendasta'. The CRM is always 'SMB Smart CRM' or 'SMB Solutions CRM'.",
    "- The audit is a 'Digital Presence Audit', never a 'website audit'.",
    "- No em-dashes (\u2014). No en-dashes (\u2013). Use periods, commas, or parentheses.",
    "- Brand voice: faith-rooted strategy, seamless integration, real human support.",
    "- Author signature on the cover and close: \"Dwayne Johnson, SMB Solutions\".",
    "",
    directoriesAuditedLine,
    "",
    "==================================================================",
    "SLIDES (in order):",
    "==================================================================",
    "",
    numberedSlides,
    "",
    "==================================================================",
    "DELIVERABLES",
    "==================================================================",
    `- ${slideCount} slide${slideCount === 1 ? "" : "s"} in this template's default style.`,
    `- A PDF copy of the deck.`,
    `- A PPTX copy of the deck.`,
    `- A ZIP archive containing every slide as a separate high-resolution PNG image, named slide-01.png, slide-02.png, etc. This is required so the images can be reused individually outside the deck.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Kick off a Manus task. Returns the taskId — polling continues in the
 * background and updates audit.manus_export as it progresses.
 */
export async function startManusDeck(
  auditId: string,
  opts: {
    logoDataUrl?: string;
    clearLogo?: boolean;
    themePrimary?: string;
    themeAccent?: string;
    resetTheme?: boolean;
    slideLimit?: number;
  } = {},
): Promise<{ taskId: string; taskUrl?: string }> {
  const audit = await storage.getAudit(auditId);
  if (!audit) throw new Error("Audit not found");
  const report: ReportData | null = audit.reportData ? JSON.parse(audit.reportData) : null;
  const prevState = readState(audit);

  // If the caller asked to drop the persisted logo, do that first so the
  // reuse branch below cannot pick it up.
  if (opts.clearLogo) {
    try { clearPersistedLogo(auditId); } catch {}
  }

  // Resolve the logo: explicit upload wins, otherwise reuse a previously
  // persisted one from this audit's deck folder so the user does not have
  // to re-upload on every regenerate.
  let effectiveLogoDataUrl: string | undefined = opts.logoDataUrl;
  if (!effectiveLogoDataUrl || !/^data:image\//.test(effectiveLogoDataUrl)) {
    const reused = opts.clearLogo ? null : readPersistedLogo(auditId);
    if (reused) {
      effectiveLogoDataUrl = reused;
      console.log(`[manus] reusing previously-uploaded logo for ${auditId}`);
    }
  }

  // Resolve the locked theme: explicit override wins, otherwise reuse the
  // theme we already extracted on a prior run, otherwise extract fresh from
  // the current logo (if any). resetTheme forces a fresh extraction.
  let themePrimary: string | undefined =
    opts.themePrimary ?? (opts.resetTheme ? undefined : prevState?.themePrimary);
  let themeAccent: string | undefined =
    opts.themeAccent ?? (opts.resetTheme ? undefined : prevState?.themeAccent);
  if ((!themePrimary || !themeAccent) && effectiveLogoDataUrl && /^data:image\//.test(effectiveLogoDataUrl)) {
    try {
      const extracted = await extractLogoTheme(effectiveLogoDataUrl);
      if (extracted) {
        themePrimary = themePrimary || extracted.primary;
        themeAccent = themeAccent || extracted.accent;
        console.log(`[manus] extracted theme for ${auditId}: primary=${themePrimary} accent=${themeAccent}`);
      }
    } catch (err) {
      console.warn(`[manus] theme extraction failed for ${auditId}:`, err);
    }
  }

  const prompt = buildPrompt(audit, report, {
    primary: themePrimary,
    accent: themeAccent,
    slideLimit: opts.slideLimit,
  });
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  let logoAdjusted = false;
  if (effectiveLogoDataUrl && /^data:image\//.test(effectiveLogoDataUrl)) {
    // Smart logo prep: pad onto white background if it's dark-on-dark.
    const prepared = await prepareLogo(effectiveLogoDataUrl);
    logoAdjusted = prepared.adjusted;
    const finalDataUrl = prepared.dataUrl;
    const match = finalDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) {
      const [, mimeType] = match;
      content.push({
        type: "file",
        file_data: finalDataUrl,
        mime_type: mimeType,
        filename: `logo.${mimeType.split("/")[1]?.replace("svg+xml", "svg") || "png"}`,
      });
    }
    // Persist the ORIGINAL upload (pre-prep) so subsequent regenerates can
    // reuse the same source asset.
    if (opts.logoDataUrl) {
      try { persistLogo(auditId, opts.logoDataUrl); }
      catch (err) { console.warn(`[manus] failed to persist logo for ${auditId}:`, err); }
    }
  }

  // Whiteboard template requires the nano-banana model.
  const body = JSON.stringify({
    message: { content },
    template_uid: TEMPLATE_UID,
    model: MODEL,
  });

  const res = await fetch(`${MANUS_BASE}/v2/task.create`, {
    method: "POST",
    headers: manusHeaders(),
    body,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json?.ok || !json?.task_id) {
    const msg = json?.error?.message || `task.create failed (status ${res.status})`;
    throw new Error(msg);
  }

  await writeState(auditId, {
    taskId: json.task_id,
    taskUrl: json.task_url,
    status: "running",
    prompt,
    startedAt: Date.now(),
    completedAt: undefined,
    error: undefined,
    hasPdf: false,
    hasZip: false,
    hasPptx: false,
    slideCount: undefined,
    logoAdjusted,
    themePrimary,
    themeAccent,
  });
  await storage.appendEvent(auditId, "manus_deck_requested", {
    taskId: json.task_id,
    taskUrl: json.task_url,
    logoAdjusted,
  });

  // Fire-and-forget background poller.
  setImmediate(() => {
    pollAndCollect(auditId, json.task_id).catch(async (err) => {
      console.error(`[manus] poll error for ${auditId}:`, err);
      await writeState(auditId, { status: "failed", error: err?.message || String(err) });
      await storage.appendEvent(auditId, "manus_deck_failed", { error: err?.message });
    });
  });

  return { taskId: json.task_id, taskUrl: json.task_url };
}

interface ListMessagesResponse {
  ok: boolean;
  has_more?: boolean;
  next_cursor?: string;
  messages?: Array<{
    type?: string;
    assistant_message?: {
      content?: string;
      attachments?: Array<{
        type?: string;
        content_type?: string;
        filename?: string;
        url?: string;
      }>;
    };
  }>;
}

export function deckPdfFilePath(auditId: string): string {
  return join(deckDir(auditId), "slides.pdf");
}

async function pollAndCollect(auditId: string, taskId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await fetch(`${MANUS_BASE}/v2/task.detail?task_id=${encodeURIComponent(taskId)}`, {
      headers: manusHeaders(),
    });
    const j = (await r.json()) as TaskDetail;
    const status = j?.task?.status || "";
    if (status !== lastStatus) {
      console.log(`[manus] task ${taskId} status=${status}`);
      lastStatus = status;
    }
    if (status === "stopped" || status === "completed" || status === "succeeded") {
      await collectDeliverables(auditId, taskId);
      return;
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Manus task ${taskId} ended with status: ${status}`);
    }
  }
  throw new Error(`Manus task ${taskId} timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes`);
}

/**
 * Walk all messages (paginated) and collect every assistant attachment.
 * Classifies by content_type / extension so we can store PDF, PPTX, and
 * ZIP separately. Builds a server-side PDF when only a ZIP of images is
 * delivered (image-mode templates). For HTML-mode templates (Glamour
 * etc.) Manus delivers a PDF and a PPTX directly — we use the PDF as-is.
 */
async function collectDeliverables(auditId: string, taskId: string): Promise<void> {
  type Att = { type?: string; content_type?: string; filename?: string; url?: string };
  const allAtts: Att[] = [];
  let cursor: string | undefined;
  // Walk pages defensively (Glamour HTML decks have many status messages).
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${MANUS_BASE}/v2/task.listMessages`);
    url.searchParams.set("task_id", taskId);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url.toString(), { headers: manusHeaders() });
    const j = (await r.json()) as ListMessagesResponse;
    if (!j?.ok || !Array.isArray(j.messages)) break;
    for (const m of j.messages) {
      const atts = m.assistant_message?.attachments;
      if (atts?.length) allAtts.push(...atts);
    }
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }

  if (allAtts.length === 0) {
    throw new Error("Manus task completed but returned no attachments. Open the Manus task to download the deck manually.");
  }

  // Classify by best-available signal.
  const classify = (a: Att): "pdf" | "pptx" | "zip" | "slides" | "image" | "other" => {
    const ct = (a.content_type || "").toLowerCase();
    const fn = (a.filename || "").toLowerCase();
    if (ct.includes("pdf") || fn.endsWith(".pdf")) return "pdf";
    if (ct.includes("presentation") || ct.includes("pptx") || fn.endsWith(".pptx") || fn.endsWith(".ppt")) return "pptx";
    if (ct.includes("zip") || fn.endsWith(".zip")) return "zip";
    if ((a.type || "").toLowerCase() === "slides") return "slides";
    if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(fn)) return "image";
    return "other";
  };

  const buckets = {
    pdf: [] as Att[],
    pptx: [] as Att[],
    zip: [] as Att[],
    slides: [] as Att[],
    image: [] as Att[],
    other: [] as Att[],
  };
  for (const a of allAtts) {
    if (!a.url) continue;
    buckets[classify(a)].push(a);
  }

  console.log(
    `[manus] collected attachments for ${taskId}: pdf=${buckets.pdf.length} pptx=${buckets.pptx.length} zip=${buckets.zip.length} slides=${buckets.slides.length} image=${buckets.image.length} other=${buckets.other.length}`,
  );

  const dir = deckDir(auditId);
  const patch: Partial<ManusExportState> = {
    status: "complete",
    hasPdf: false,
    hasZip: false,
    hasPptx: false,
    slideCount: undefined,
    completedAt: Date.now(),
  };

  // 1. PDF — preferred deliverable. Take the LAST PDF (Manus often emits
  //    incremental previews; the final one is at the tail).
  if (buckets.pdf.length > 0) {
    const att = buckets.pdf[buckets.pdf.length - 1];
    const pdfPath = join(dir, "slides.pdf");
    await downloadTo(att.url!, pdfPath);
    patch.hasPdf = true;
    patch.pdfFilename = att.filename || "slides.pdf";
    // Count pages so the UI shows the real slide count, not a stale or invented one.
    try {
      const pdfParseMod = await import("pdf-parse");
      const pdfParse = (pdfParseMod as any).default || pdfParseMod;
      const buf = readFileSync(pdfPath);
      const parsed = await pdfParse(buf);
      if (typeof parsed?.numpages === "number" && parsed.numpages > 0) {
        patch.slideCount = parsed.numpages;
      }
    } catch (err) {
      console.warn(`[manus] failed to count PDF pages:`, err);
    }
    // Render the PDF into one labeled PNG per slide (slide-01.png, slide-02.png, ...)
    // and zip them up so the client can use individual slides as assets.
    try {
      const zipPath = await renderPdfToLabeledZip(pdfPath, dir);
      if (zipPath) {
        patch.hasZip = true;
        patch.zipFilename = "slides.zip";
      }
    } catch (err) {
      console.warn(`[manus] failed to render PDF into labeled slide PNGs:`, err);
    }
  }

  // 2. PPTX — store for users who want to edit.
  if (buckets.pptx.length > 0) {
    const att = buckets.pptx[buckets.pptx.length - 1];
    await downloadTo(att.url!, join(dir, "slides.pptx"));
    patch.hasPptx = true;
    patch.pptxFilename = att.filename || "slides.pptx";
  }

  // 3. ZIP of slide images — only for image-mode templates.
  if (buckets.zip.length > 0) {
    const att = buckets.zip[buckets.zip.length - 1];
    const zipPath = join(dir, "slides.zip");
    await downloadTo(att.url!, zipPath);
    patch.hasZip = true;
    patch.zipFilename = att.filename || "slides.zip";

    // If we didn't get a PDF, build one from the zip's images.
    if (!patch.hasPdf) {
      try {
        const { slideCount } = await buildPdfFromZip(zipPath, join(dir, "slides.pdf"));
        patch.hasPdf = true;
        patch.slideCount = slideCount;
        patch.pdfFilename = "slides.pdf";
      } catch (err) {
        console.warn(`[manus] failed to build PDF from zip:`, err);
      }
    }
  }

  // 4. Slides-typed attachment — manifest, save for future use.
  if (buckets.slides.length > 0) {
    const att = buckets.slides[buckets.slides.length - 1];
    try {
      await downloadTo(att.url!, join(dir, "slides.json"));
    } catch (err) {
      console.warn(`[manus] failed to download slides manifest:`, err);
    }
  }

  // 5. Last-resort: bare image attachments — assemble into a PDF.
  if (!patch.hasPdf && buckets.image.length > 0) {
    const imageDir = join(dir, "images");
    mkdirSync(imageDir, { recursive: true });
    let i = 0;
    for (const att of buckets.image) {
      const ext = (att.filename || "").match(/\.(png|jpe?g|webp|gif)$/i)?.[1] || "png";
      await downloadTo(att.url!, join(imageDir, `slide-${String(++i).padStart(3, "0")}.${ext}`));
    }
    try {
      const { slideCount } = await buildPdfFromImageDir(imageDir, join(dir, "slides.pdf"));
      patch.hasPdf = true;
      patch.slideCount = slideCount;
      patch.pdfFilename = "slides.pdf";
    } catch (err) {
      console.warn(`[manus] failed to assemble PDF from images:`, err);
    }
  }

  // If we got nothing usable, fail explicitly so the UI can show the Manus task link.
  if (!patch.hasPdf && !patch.hasPptx && !patch.hasZip) {
    throw new Error(
      "Manus task completed but no downloadable deck found. Open the Manus task to download manually.",
    );
  }

  await writeState(auditId, patch);
  await storage.appendEvent(auditId, "manus_deck_complete", {
    taskId,
    hasPdf: patch.hasPdf,
    hasPptx: patch.hasPptx,
    hasZip: patch.hasZip,
    slideCount: patch.slideCount,
  });
  console.log(
    `[manus] deck ready for audit ${auditId} (pdf=${!!patch.hasPdf} pptx=${!!patch.hasPptx} zip=${!!patch.hasZip})`,
  );
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) for ${url}`);
  const ws = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(r.body as any)
      .pipe(ws)
      .on("finish", () => resolve())
      .on("error", reject);
  });
}

/**
 * Unzip the deck and assemble a PDF, one slide per page.
 */
async function buildPdfFromZip(zipPath: string, pdfPath: string): Promise<{ slideCount: number }> {
  let AdmZip: any;
  try {
    AdmZip = (await import("adm-zip")).default || (await import("adm-zip"));
  } catch {
    throw new Error("adm-zip not installed — PDF generation unavailable");
  }
  const dir = join(zipPath, "..");
  const extractDir = join(dir, "slides");
  mkdirSync(extractDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);

  return buildPdfFromImageDir(extractDir, pdfPath);
}

async function buildPdfFromImageDir(imageDir: string, pdfPath: string): Promise<{ slideCount: number }> {
  const imageFiles = findImagesRecursively(imageDir).sort();
  if (imageFiles.length === 0) {
    throw new Error("Directory contained no slide images");
  }
  const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [1920, 1080] });
  imageFiles.forEach((file, i) => {
    const bytes = readFileSync(file);
    const ext = file.toLowerCase().endsWith(".jpg") || file.toLowerCase().endsWith(".jpeg") ? "JPEG" : "PNG";
    const dataUrl = `data:image/${ext === "JPEG" ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
    if (i > 0) pdf.addPage([1920, 1080], "landscape");
    pdf.addImage(dataUrl, ext, 0, 0, 1920, 1080, undefined, "FAST");
  });
  const out = Buffer.from(pdf.output("arraybuffer"));
  writeFileSync(pdfPath, out);
  return { slideCount: imageFiles.length };
}

function findImagesRecursively(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...findImagesRecursively(full));
    } else if (/\.(png|jpe?g)$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Render a delivered PDF into one labeled PNG per page (slide-01.png,
 * slide-02.png, etc.) using pdftoppm, then zip the directory of PNGs as
 * slides.zip. Requires poppler-utils on PATH (installed in the runtime
 * Docker image).
 *
 * Returns the zip path on success, or null if pdftoppm is missing.
 */
async function renderPdfToLabeledZip(pdfPath: string, outDir: string): Promise<string | null> {
  const imagesDir = join(outDir, "slide-images");
  // Wipe any prior run so stale slide-XX.png files do not survive a re-export.
  try { rmSync(imagesDir, { recursive: true, force: true }); } catch {}
  mkdirSync(imagesDir, { recursive: true });

  // pdftoppm flags:
  //   -png    output PNG (vs default PPM)
  //   -r 144  render at 144 dpi (sharp enough for marketing, small enough
  //           that a 15-slide deck zips to ~5-8 MB)
  //   -f 1    start at page 1 (default, but explicit is clearer)
  // pdftoppm writes <prefix>-<n>.png where n is left-padded to match the
  // number of digits in the last page. We pass prefix "slide" so files
  // come out as slide-01.png, slide-02.png, ... when the deck has 10-99
  // pages. For decks under 10 pages it would write slide-1.png; we
  // rename below so the labeling is always two-digit consistent.
  try {
    await execFileAsync("pdftoppm", [
      "-png",
      "-r", "144",
      pdfPath,
      join(imagesDir, "slide"),
    ]);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.warn("[manus] pdftoppm not found on PATH, skipping labeled-slide ZIP");
      return null;
    }
    throw err;
  }

  // Normalize filenames so they are always two-digit padded: slide-01.png,
  // slide-02.png, ... even for short decks. pdftoppm uses the minimum
  // width needed for the page count, so we re-pad to a stable convention.
  const fs = await import("node:fs");
  const files = readdirSync(imagesDir)
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error("pdftoppm produced no PNG output");
  }
  files.forEach((f, i) => {
    const want = `slide-${String(i + 1).padStart(2, "0")}.png`;
    if (f !== want) {
      fs.renameSync(join(imagesDir, f), join(imagesDir, want));
    }
  });

  // Zip them up.
  const AdmZipMod: any = await import("adm-zip");
  const AdmZip = AdmZipMod.default || AdmZipMod;
  const zip = new AdmZip();
  const finalFiles = readdirSync(imagesDir)
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort();
  for (const f of finalFiles) {
    zip.addLocalFile(join(imagesDir, f));
  }
  const zipPath = join(outDir, "slides.zip");
  zip.writeZip(zipPath);
  console.log(`[manus] wrote ${finalFiles.length} labeled slide PNGs to ${zipPath}`);
  return zipPath;
}

export function deckZipPath(auditId: string): string {
  return join(DECK_ROOT, auditId, "slides.zip");
}

export function deckPdfPath(auditId: string): string {
  return join(DECK_ROOT, auditId, "slides.pdf");
}

export function deckPptxPath(auditId: string): string {
  return join(DECK_ROOT, auditId, "slides.pptx");
}

export function deckExists(p: string): boolean {
  return existsSync(p);
}

/**
 * Lightweight info about the persisted logo (if any). Used by the
 * /manus-status endpoint so the UI can show "Reusing previously-uploaded
 * logo: filename.png" without having to send the full image bytes.
 */
export function getPersistedLogoInfo(auditId: string): { exists: boolean; filename?: string; mime?: string } {
  const dir = join(DECK_ROOT, auditId);
  if (!existsSync(dir)) return { exists: false };
  try {
    const file = readdirSync(dir).find((f) => /^logo-original\.(png|jpe?g|webp|gif|svg)$/i.test(f));
    if (!file) return { exists: false };
    let mime = "image/png";
    const mimePath = join(dir, "logo-original.mime");
    if (existsSync(mimePath)) {
      try { mime = readFileSync(mimePath, "utf8").trim() || mime; } catch {}
    }
    return { exists: true, filename: file, mime };
  } catch {
    return { exists: false };
  }
}

/**
 * Stream-friendly path to the persisted logo for a direct download.
 */
export function persistedLogoPath(auditId: string): string | null {
  const dir = join(DECK_ROOT, auditId);
  if (!existsSync(dir)) return null;
  try {
    const file = readdirSync(dir).find((f) => /^logo-original\.(png|jpe?g|webp|gif|svg)$/i.test(f));
    return file ? join(dir, file) : null;
  } catch {
    return null;
  }
}

/**
 * Delete the persisted logo so a regenerate will start from a clean slate.
 */
export function clearPersistedLogo(auditId: string): void {
  const dir = join(DECK_ROOT, auditId);
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir)) {
      if (/^logo-original\.(png|jpe?g|webp|gif|svg|mime)$/i.test(f)) {
        rmSync(join(dir, f), { force: true });
      }
    }
  } catch {}
}
