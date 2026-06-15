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
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { storage } from "./storage";
import type { Audit, ReportData } from "@shared/schema";
import { jsPDF } from "jspdf";
import sharp from "sharp";

const MANUS_BASE = "https://api.manus.ai";
// Glamour HTML-mode template — fully editable text-based slides, much faster
// than image-mode (nano-banana) and far smaller file sizes. Theme adapts to
// the uploaded client logo automatically. Switched from whiteboard nano-banana
// after image-mode runs took 15+ min and produced 80MB+ PDFs.
const TEMPLATE_UID = "glamour_1a961063-1678-4c01-b3a5-e1d44a4f4522";
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
function buildPrompt(audit: Audit, report: ReportData | null): string {
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
      `IMAGERY: If a client logo image was attached to this task, display it prominently and centered on the cover. Use it as the source of the deck's color theme across every slide. Pull a primary brand color and one or two accent colors from the logo and apply them consistently.`,
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
      `IMAGERY: A 2x2 scoreboard with grade badges and percentage rings or progress bars for each pillar. Color the rings by severity: red for F, orange for D, yellow for C, green for B/A.`,
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
      slides.push(
        [
          "AI & AUTOMATION",
          `Title: "AI & Automation".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          aiAbsent.length
            ? `  ${cn} is NOT cited on these AI assistants: ${aiAbsent.map((a) => a.platform).join(", ")}.`
            : `  ${cn} is not cited on the major AI platforms audited.`,
          aiPresent.length
            ? `  ${cn} IS cited on: ${aiPresent.map((a) => a.platform).join(", ")}.`
            : "",
          ...(p.gaps || []).map((g) => `  - ${g}`),
          `  Key insight: Every search that goes to an AI today is a customer ${cn} cannot recover.`,
          `Section 2, The Answer:`,
          `  A 24/7 AI Workforce that captures every lead and inquiry, across phone, chat, email, and social, and routes them into one unified inbox.`,
          `  Core agents: AI Receptionist, Chat Agent, Support Agent, Follow-Up Agent, Routing Agent.`,
          `  Outcome line: "Never miss a lead or customer inquiry again."`,
          `IMAGERY: A row of small 2D agent icons (headset for Receptionist, chat bubble for Chat Agent, lifebuoy for Support, clock for Follow-Up, branching arrows for Routing). Also a small panel showing logos of the AI assistants checked (ChatGPT, Gemini, Claude, Perplexity), with green check or red X overlays based on the data above.`,
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
          `IMAGERY: Build a two-column comparison panel, no SERP mockup, no bar chart with invented labels.`,
          `  LEFT COLUMN header "WHERE YOU RANK". Render one card per ranking keyword below using these EXACT strings (do not paraphrase, do not invent additional rows):`,
          ...ranking.map(
            (k) =>
              `    - "${k.keyword}" | rank #${k.position ?? "?"} | ${(k.volume ?? 0).toLocaleString()}/mo`,
          ),
          `  RIGHT COLUMN header "WHAT YOU MISS". Render one card per opportunity keyword below using these EXACT strings as the visible labels (do not paraphrase, do not invent additional rows, do not shorten):`,
          ...opportunity.map(
            (k) =>
              `    - "${k.keyword}" | ${(k.volume ?? 0).toLocaleString()}/mo`,
          ),
          `  Style: left column cards use a green check badge with the rank number; right column cards use an amber warning badge with the volume number. Add a magnifying-glass icon as a section badge in the slide header. Do NOT add any other keyword labels beyond the exact strings listed above.`,
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
          `IMAGERY: A donut chart on the left showing "${claimed} of ${totalListings} directories accurate" as a partially-filled ring. On the right, a stacked list of common directory logos (Google Business Profile, Yelp, Bing, Apple Maps, Facebook, Yellow Pages) each with a green check or red X based on listed/missing status. Optional small map pin icon to reinforce local.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "social") {
      slides.push(
        [
          "SOCIAL MEDIA",
          `Title: "Social Media".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...((p.strengths || []).map((s) => `  - What is working: ${s}`)),
          ...((p.gaps || []).map((g) => `  - What is being missed: ${g}`)),
          `  Key insight: Manual posting on every platform every week is unsustainable. This is where burnout starts.`,
          `Section 2, The Answer:`,
          `  An AI-assisted content calendar across Facebook, Instagram, TikTok, and LinkedIn. Posts drafted, scheduled, and tracked from one dashboard.`,
          `  Outcome line: "Stay visible and relevant without constant manual effort."`,
          `IMAGERY: A horizontal row of social platform icons (Facebook, Instagram, TikTok, LinkedIn, YouTube) with engagement indicators. Below them, a mini monthly calendar grid showing colored content blocks scheduled across the month, illustrating an AI-driven posting cadence.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "reputation") {
      slides.push(
        [
          "REPUTATION",
          `Title: "Reputation".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...((p.strengths || []).map((s) => `  - What is working: ${s}`)),
          ...((p.gaps || []).map((g) => `  - What is being missed: ${g}`)),
          `  Key insight: Stars do not collect themselves. Without a system to ask, follow up, and respond, the next ten reviews could go either way.`,
          `Section 2, The Answer:`,
          `  A reputation system: automated review requests after every transaction, fast review responses, and 5-star reviews flowing into Google Business Profile on a steady cadence.`,
          `  Outcome line: "Turn trust into more calls, bookings, and sales."`,
          `IMAGERY: A prominent row of five gold stars across the top. Underneath, a "Review Funnel" diagram showing the steps: Transaction, Automated SMS/email request, Customer review, Owner response. Include a sample 5-star Google review card mockup with a generic happy-customer avatar.`,
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
        `IMAGERY: A row of pillar cards, each topped with a green check badge and the pillar's grade letter.`,
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
      `IMAGERY: A realistic-looking SaaS dashboard mockup occupying the right two-thirds of the slide. Show: a left sidebar with nav items (Dashboard, Leads, Pipeline, Inbox, Calendar, Reports), a top metrics row (Leads This Month, Active Deals, Tasks Due, Revenue), a kanban-style pipeline with three or four deal cards under columns labeled "New", "Working", "Closed", and a small activity feed on the right. Use the deck's brand accent color for highlights, white card backgrounds, and rounded corners. Make it look like a modern CRM product screenshot.`,
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
      `IMAGERY: A horizontal three-step timeline running left-to-right. Each phase is its own card with a numbered circle (1, 2, 3), a phase title, the date range, and a 2D icon (a foundation/anchor for Phase 1, a lightning bolt for Phase 2, a rocket for Phase 3). Connect the cards with arrows.`,
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
      `Call to action: Prominent button or banner labeled "START" inviting the client to begin.`,
      `IMAGERY: The client logo (if attached) above the three statement cards. A subtle pattern or gradient background in the deck accent color behind the cards.`,
    ].join("\n"),
  );

  // ===== Assemble.
  const numberedSlides = slides
    .map((slideBody, i) => {
      const n = String(i + 1).padStart(2, "0");
      return `slide-${n}\n${slideBody}`;
    })
    .join("\n\n");

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
    "VISUAL STYLE",
    "==================================================================",
    `This deck is a clean, professional client-facing presentation. Use the Glamour template defaults for layout, typography, and structure. Build the color theme around the colors in the client logo that has been attached (if a logo was attached). Pull a primary brand color and one or two accent colors from the logo and apply them consistently across every slide. Do not add whiteboard, sketch, hand-drawn, marker, or photo aesthetics. Do not use illustrated cartoon doodles. Keep the design polished, modern, and on-brand for ${cn}. Lean into the IMAGERY directives on each slide: use 2D vector icons, simple charts, and clean dashboard or diagram mockups built from the template's editable element library.`,
    "",
    "==================================================================",
    "DECK CONTENT",
    "==================================================================",
    `This is a Digital Presence Audit prepared by Dwayne Johnson at SMB Solutions for ${cn}. Use the slides below in order. Each slide includes an IMAGERY line, follow it, these visuals are not optional, they carry the message.`,
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
    `- A complete slide deck in the Glamour template style, with the color theme drawn from the client logo.`,
    `- A PDF copy of the deck.`,
    `- A PPTX copy of the deck.`,
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
  opts: { logoDataUrl?: string } = {},
): Promise<{ taskId: string; taskUrl?: string }> {
  const audit = await storage.getAudit(auditId);
  if (!audit) throw new Error("Audit not found");
  const report: ReportData | null = audit.reportData ? JSON.parse(audit.reportData) : null;

  const prompt = buildPrompt(audit, report);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  let logoAdjusted = false;
  if (opts.logoDataUrl && /^data:image\//.test(opts.logoDataUrl)) {
    // Smart logo prep: pad onto white background if it's dark-on-dark.
    const prepared = await prepareLogo(opts.logoDataUrl);
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
  }

  // Glamour is HTML-mode; no `model` field needed.
  const body = JSON.stringify({
    message: { content },
    template_uid: TEMPLATE_UID,
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
