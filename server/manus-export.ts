/**
 * Manus Send-to-Slides integration
 * --------------------------------
 * Asynchronously generates a simplified, client-facing slide deck from an
 * audit report, using the Manus Slides / Image-Mode API.
 *
 * Flow (all server-side, no client polling against Manus):
 *   1. POST /v2/task.create — kick off task with our prompt + (optional) logo
 *      data URL + template_uid + model.
 *   2. Background poller pings /v2/task.detail every 8s until status == "stopped"
 *      (or other terminal state).
 *   3. On completion, GET /v2/task.listMessages and find the assistant_message
 *      attachments. Pull:
 *        - the auto-generated zip of slide images (content_type: application/zip)
 *        - the slides manifest JSON (type: "slides")
 *   4. Download the zip + manifest into DATA_DIR/manus-decks/<auditId>/, then
 *      build a server-side PDF from the slide PNGs using jspdf.
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

const MANUS_BASE = "https://api.manus.ai";
// Glamour HTML-mode template — fully editable text-based slides, much faster
// than image-mode (nano-banana) and far smaller file sizes. Theme adapts to
// the uploaded client logo automatically. Switched from whiteboard nano-banana
// after image-mode runs took 15+ min and produced 80MB+ PDFs.
const TEMPLATE_UID = "glamour_1a961063-1678-4c01-b3a5-e1d44a4f4522";
const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — Manus image-mode decks can take 5–15 min
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
  slideCount?: number;
  hasPdf?: boolean;
  hasZip?: boolean;
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
 * Build the Manus prompt for the Glamour HTML-mode template.
 *
 * Fixed 10-slide structure, problem+solution combined per pillar:
 *   1. Cover
 *   2. Executive Summary (overall grade + 4 pillar scores)
 *   3. The Four Pillars + CRM Hub (architecture overview)
 *   4. AI & Automation (problem + solution combined)
 *   5. SEO, Keywords & Listings (problem + solution combined)
 *   6. Social Media (problem + solution combined)
 *   7. Reputation (problem + solution combined)
 *   8. SMB Smart CRM — The Operational Backbone (static)
 *   9. Your 90-Day Plan
 *   10. Let's Get To Work (CTA)
 *
 * Glamour is an HTML-mode template, so Manus handles all layout, typography,
 * and theming automatically. The prompt gives Manus the CONTENT and lets
 * Manus extract a color theme from the uploaded client logo. No layout or
 * style instructions — those override the template.
 */
function buildPrompt(audit: Audit, report: ReportData | null): string {
  const cn = audit.clientName || "the client";
  const ownerRaw = (audit as any).contactName || (audit as any).ownerName || "";
  const ownerFirst = String(ownerRaw).trim().split(/\s+/)[0] || "";
  const ind = audit.industry || "their industry";
  const loc = audit.location || "their service area";
  const overallGrade = audit.overallGrade || "";
  const overallScore = audit.overallScore ?? null;

  // ----- Pull real numbers from the report so Manus renders facts, not
  // generic copy. Every field is optional; missing data just gets omitted. -----
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
  // Pillars graded D or F earn their own dedicated problem slide AND
  // their own dedicated solution slide. Pillars graded A, B, or C are
  // mentioned briefly and consolidated.
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
    if (score < 60) return "critical"; // F territory
    if (score < 75) return "weak"; // D territory
    return "steady"; // C and above
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

  // NAP / directory total — pull from the actual audit data, not a curated
  // short list. If the audit checked 66 directories, we want "only on X
  // of 66", not "X of 15".
  const claimed = listings.filter((l) => l.status === "Listed" && l.napAccurate !== false).length;
  const napScore = report?.seoDeep?.napConsistency?.score;
  const directoriesAuditedLine = totalListings
    ? `Google checks ${totalListings} directories to verify a business is real, local, and trustworthy. ${cn} is currently listed and accurate on only ${claimed} of those ${totalListings}.`
    : "";

  const rankingLine = ranking
    .map(
      (k) =>
        `${k.keyword}${k.position ? ` (rank ${k.position})` : ""}${k.volume ? `, ${k.volume.toLocaleString()} monthly searches` : ""}`,
    )
    .join("; ");
  const opportunityLine = opportunity
    .map(
      (k) =>
        `${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} monthly searches, not ranking)` : ""}`,
    )
    .join("; ");
  const missingLine = missing.slice(0, 6).map((l) => l.directory).join(", ");

  // Compute total monthly opportunity-search volume for the headline
  // "X monthly searches going to your competitors" framing.
  const totalOpportunityVolume = opportunity.reduce(
    (sum, k) => sum + (k.volume || 0),
    0,
  );

  // ===== Build the slide list. Slides are pushed in order; numbering is
  // applied at the end so the dynamic problem/solution sections renumber
  // themselves cleanly.
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
      `If a client logo image was attached to this task, display it prominently on the cover and use it as the source of the deck's color theme across every slide.`,
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
      `Show the four pillar scores in a clean scoreboard layout:`,
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

  // ---------- SLIDE: Four Pillars + CRM Hub ----------
  slides.push(
    [
      "FOUR PILLARS, ONE UNIFIED HUB",
      `Title: "Four Pillars, One Unified Hub".`,
      `Subtitle: "The architecture behind a business that runs without leaks."`,
      `Show the four pillars arranged around a central hub labeled "SMB Smart CRM":`,
      `  - AI & Automation`,
      `  - SEO, Keywords & Listings`,
      `  - Social Media`,
      `  - Reputation`,
      `Closing line: "Every pillar feeds the one place that runs your business."`,
    ].join("\n"),
  );

  // ====================================================================
  // PILLAR SLIDES — one per pillar that needs work. Problem + Solution
  // combined on the same slide. Pillars that are steady get a single
  // consolidated "Where You Are Holding Ground" slide later.
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
          ...(p.gaps || []).slice(0, 3).map((g) => `  - ${g}`),
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
      slides.push(
        [
          "SEO, KEYWORDS & LISTINGS",
          `Title: "SEO, Keywords & Listings".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          rankingLine
            ? `  Currently ranking for: ${ranking.map((k) => `${k.keyword}${k.position ? ` (#${k.position})` : ""}${k.volume ? `, ${k.volume.toLocaleString()}/mo` : ""}`).join("; ")}.`
            : `  No keywords are currently ranking.`,
          opportunityLine
            ? `  Searches going to competitors: ${opportunity.map((k) => `${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()}/mo)` : ""}`).join("; ")}.`
            : "",
          totalOpportunityVolume
            ? `  Headline: ${totalOpportunityVolume.toLocaleString()} people per month are searching for what ${cn} sells in ${loc} and going to competitors.`
            : "",
          totalListings
            ? `  Directory trust: Google checks ${totalListings} directories. ${cn} is currently listed and accurate on only ${claimed} of ${totalListings}.`
            : "",
          napScore !== undefined
            ? `  NAP Consistency Score: ${napScore}/100. When name, address, and phone do not match across the web, Google stops trusting the business.`
            : "",
          missingLine ? `  Notable missing directories: ${missingLine}.` : "",
          `Section 2, The Answer:`,
          `  Be found everywhere customers search: Local SEO, AEO (Answer Engine Optimization), and GEO (Generative Engine Optimization).`,
          `  Claim and standardize every directory listing. Rebuild NAP consistency. Publish content that targets the highest-volume opportunity keywords.`,
          `  Outcome line: "Be the answer Google AND AI engines pick first."`,
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
          ...((p.strengths || []).slice(0, 3).map((s) => `  - What is working: ${s}`)),
          ...((p.gaps || []).slice(0, 3).map((g) => `  - What is being missed: ${g}`)),
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
      slides.push(
        [
          "REPUTATION",
          `Title: "Reputation".`,
          `Score line: ${p.score ?? "?"}/100${p.grade ? ` (Grade ${p.grade})` : ""}.`,
          `Section 1, The Gap:`,
          ...((p.strengths || []).slice(0, 2).map((s) => `  - What is working: ${s}`)),
          ...((p.gaps || []).slice(0, 3).map((g) => `  - What is being missed: ${g}`)),
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

  // Steady (B/C/A) pillars get a single consolidated "Holding Ground" slide.
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

  // ---------- SLIDE: SMB Smart CRM (STATIC, locked content) ----------
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
      `Three closing statements:`,
      `  - The Verdict: "The foundation is real. The gaps are fixable. The opportunity is now."`,
      `  - The Focus: "Pillar fixes, dashboards, real human support."`,
      `  - The Outcome: "A predictable, scalable system for capturing and keeping customers."`,
      `Tagline: "Faith-rooted strategy. Seamless integration. Real human support."`,
      `Call to action: Prominent button or banner labeled "START" inviting the client to begin.`,
    ].join("\n"),
  );

  // ===== Assemble the final prompt.
  const slideCount = slides.length;
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
    `This deck is a clean, professional client-facing presentation. Use the Glamour template defaults for layout, typography, and structure. Build the color theme around the colors in the client logo that has been attached (if a logo was attached). Pull a primary brand color and one or two accent colors from the logo and apply them consistently across every slide. Do not add whiteboard, sketch, hand-drawn, marker, or photo aesthetics. Do not use illustrated cartoon doodles. Keep the design polished, modern, and on-brand for ${cn}.`,
    "",
    "==================================================================",
    "DECK CONTENT",
    "==================================================================",
    `This is a Digital Presence Audit prepared by Dwayne Johnson at SMB Solutions for ${cn}. Use the slides below in order. You may add visual elements like icons, dashboard mockups, charts, or pillar diagrams where they make the content clearer, in keeping with the Glamour template's style.`,
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

  // If the caller uploaded a logo, embed it as a file ContentPart so Manus
  // can reference it from the prompt. The v2 API expects type: "file" with
  // one of file_id / file_url / file_data. We use file_data (inline base64,
  // capped at 20MB after decode).
  // Ref: https://open.manus.ai/docs/v2/task.create
  if (opts.logoDataUrl && /^data:image\//.test(opts.logoDataUrl)) {
    const match = opts.logoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) {
      const [, mimeType] = match;
      // Manus expects file_data as a full data URI (it explicitly errored
      // with "invalid data URI format in file_data" when we sent raw base64).
      content.push({
        type: "file",
        file_data: opts.logoDataUrl,
        mime_type: mimeType,
        filename: `logo.${mimeType.split("/")[1]?.replace("svg+xml", "svg") || "png"}`,
      });
    }
  }

  // Glamour is an HTML-mode template, so no `model` field is needed (model is
  // only required for image-mode templates like nano-banana). Manus picks the
  // right backend automatically based on template_uid.
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
    error: undefined,
    hasPdf: false,
    hasZip: false,
  });
  await storage.appendEvent(auditId, "manus_deck_requested", {
    taskId: json.task_id,
    taskUrl: json.task_url,
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
  messages?: Array<{
    type: string;
    assistant_message?: {
      content?: string;
      attachments?: Array<{
        type: string;
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
    // Manus uses "stopped" as the terminal state for completed image-mode runs.
    // "failed" / "error" also stop polling.
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

async function collectDeliverables(auditId: string, taskId: string): Promise<void> {
  const r = await fetch(
    `${MANUS_BASE}/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&limit=50`,
    { headers: manusHeaders() },
  );
  const j = (await r.json()) as ListMessagesResponse;
  if (!j?.ok || !Array.isArray(j.messages)) {
    throw new Error("task.listMessages returned no messages");
  }

  // Find the most recent assistant_message with attachments.
  let zipUrl: string | undefined;
  let zipFilename: string | undefined;
  let slidesUrl: string | undefined;
  for (const m of j.messages) {
    const atts = m.assistant_message?.attachments;
    if (!atts?.length) continue;
    for (const a of atts) {
      if (a.content_type === "application/zip" && a.url) {
        zipUrl = a.url;
        zipFilename = a.filename || "slides.zip";
      }
      if (a.type === "slides" && a.url) {
        slidesUrl = a.url;
      }
    }
    if (zipUrl) break;
  }
  if (!zipUrl) {
    throw new Error("Manus task completed but no zip attachment found in messages");
  }

  const dir = deckDir(auditId);
  // Download the zip.
  const zipPath = join(dir, "slides.zip");
  await downloadTo(zipUrl, zipPath);

  // Optionally download the slides manifest for future use (not exposed yet).
  if (slidesUrl) {
    try {
      await downloadTo(slidesUrl, join(dir, "slides.json"));
    } catch (err) {
      console.warn(`[manus] failed to download slides manifest:`, err);
    }
  }

  // Extract slide images from the zip and build a server-side PDF.
  const { slideCount } = await buildPdfFromZip(zipPath, join(dir, "slides.pdf"));

  await writeState(auditId, {
    status: "complete",
    zipFilename: zipFilename || "slides.zip",
    slideCount,
    hasPdf: true,
    hasZip: true,
    completedAt: Date.now(),
  });
  await storage.appendEvent(auditId, "manus_deck_complete", {
    taskId,
    slideCount,
    zipFilename,
  });
  console.log(`[manus] deck ready for audit ${auditId} (${slideCount} slides)`);
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
 * Uses adm-zip if available, else falls back to native unzip via the system.
 */
async function buildPdfFromZip(zipPath: string, pdfPath: string): Promise<{ slideCount: number }> {
  // Dynamic import so the build still works if adm-zip isn't installed yet.
  let AdmZip: any;
  try {
    AdmZip = (await import("adm-zip")).default || (await import("adm-zip"));
  } catch {
    // Fall back to extracting via Node's zlib for a single-file zip would be brittle.
    // adm-zip is added to package.json by the deploy step; if missing we still mark
    // hasZip=true and just skip the PDF.
    throw new Error("adm-zip not installed — PDF generation unavailable");
  }
  const dir = join(zipPath, "..");
  const extractDir = join(dir, "slides");
  mkdirSync(extractDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);

  // Find all PNG/JPG slide files (recursively) and sort.
  const imageFiles = findImagesRecursively(extractDir).sort();
  if (imageFiles.length === 0) {
    throw new Error("Zip contained no slide images");
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

export function deckExists(p: string): boolean {
  return existsSync(p);
}
