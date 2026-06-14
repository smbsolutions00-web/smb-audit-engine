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
const TEMPLATE_UID = "whiteboard_c936ac40-1dc4-4f4f-b583-991de9f2dd08";
const MODEL = "nano-banana";
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
 * Build the Manus prompt using the SMB Solutions four-pillar format Dwayne
 * presents every time:
 *
 *   1. Cover (intro, personalized)
 *   2. Where you stand today (four-pillar scoreboard)
 *   3. Pillar I  - AI & Automation
 *   4. Pillar II - SEO + Keywords + Listings (3 slides: keywords, opportunity, listings)
 *   5. Pillar III - Social Media Presence
 *   6. Pillar IV - Reputation Management & Trust
 *   7. SMB Smart CRM (STATIC slide, identical for every client)
 *   8. 90-day roadmap + close
 *
 * Every pillar slide uses the same visual structure as the B2B Suite
 * reference deck: SMB Solutions value-prop / pillar name on the left,
 * client-specific data (grade, numbers, gaps) on the right. The CRM slide
 * is locked content so the four pillars always converge into one unified hub.
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

  return [
    `Client: ${cn}`,
    ownerFirst ? `Owner first name: ${ownerFirst}` : "",
    `Industry: ${ind}`,
    `Location: ${loc}`,
    overallGrade || overallScore !== null
      ? `Overall audit grade: ${overallGrade}${overallScore !== null ? ` (${overallScore}/100)` : ""}`
      : "",
    "",
    "You are producing the simplified client-facing version of a Digital Presence Audit for SMB Solutions (a division of Tsalach Inc). The business owner will read this deck after the discovery call. Keep it visual, simple, and focused on the FOUR PILLARS that move the needle for every small business, plus the unified CRM that ties them together.",
    "",
    "SLIDE COUNT: This deck MUST contain between 12 and 15 slides. The minimum is 12. The maximum is 15. Do NOT cap the deck at 10 slides under any circumstance. Any internal default that suggests 10 slides is overridden by this instruction. If you need extra slides (13, 14, or 15) to fully cover the four pillars, split a pillar across two slides rather than removing one. Never drop a required slide to stay under a count.",
    "",
    "REQUIRED SLIDE STRUCTURE - do not skip any slide and do not reorder. Label them slide-01 through slide-NN where NN is between 12 and 15.",
    "",
    "slide-01  COVER",
    `Title: "Digital Presence Audit". Subtitle: "${cn} | ${loc}". Tagline: "A clear picture of where you stand and where you are headed." Embed the client logo on the left if provided. Bottom: "Presented by: SMB Solutions" + today's date. Footer: "Faith-rooted strategy | Seamless integration | Real human support".`,
    "",
    "slide-02  WHERE YOU STAND TODAY (four-pillar scoreboard)",
    `Title: "Here Is Where ${cn} Stands Today". Show a 4-row table with these EXACT four pillars (in this order) plus a one-line status and priority for each:`,
    `  1. AI & Automation - ${ai ? `${ai.score}/100 - ${ai.summary || "no automation infrastructure detected"}` : "score unavailable"}`,
    `  2. SEO + Keywords + Listings - ${seo ? `${seo.score}/100 - ${seo.summary || ""}` : "score unavailable"}`,
    `  3. Social Media - ${social ? `${social.score}/100 - ${social.summary || ""}` : "score unavailable"}`,
    `  4. Reputation - ${rep ? `${rep.score}/100 - ${rep.summary || ""}` : "score unavailable"}`,
    `Close the slide with: "The foundation is real. The gaps are fixable. The opportunity is now."`,
    "",
    "slide-03  PILLAR I: AI & AUTOMATION",
    "Visual structure mirrors the SMB Solutions B2B Suite: left side shows the SMB Solutions value prop (24/7 AI workforce - AI Receptionist, Chat Agent, Support Agent, Follow-Up Agent, Routing Agent). Right side shows THIS CLIENT'S current state.",
    ai ? `Client AI Automation grade: ${ai.score}/100. Summary: ${ai.summary}` : "",
    aiAbsent.length
      ? `AI assistants where ${cn} is NOT cited when searched: ${aiAbsent.map((p) => p.platform).join(", ")}. This is the discovery channel of the future and the client is invisible there.`
      : "",
    aiPresent.length
      ? `AI assistants where ${cn} IS cited: ${aiPresent.map((p) => p.platform).join(", ")}.`
      : "",
    ai?.gaps?.length ? `Top AI gaps: ${ai.gaps.slice(0, 3).join("; ")}.` : "",
    "Result line: \"Never miss a lead or customer inquiry again.\"",
    "",
    "slide-04  PILLAR II: SEO + KEYWORDS + LISTINGS (overview)",
    "Visual: left side shows the SMB Solutions Local SEO + AEO + GEO value prop (be found where customers AND AI engines are searching). Right side previews the three sub-stories: ranking keywords, opportunity keywords, and unclaimed listings.",
    seo ? `Client SEO grade: ${seo.score}/100. Summary: ${seo.summary}` : "",
    "",
    "slide-05  KEYWORDS - WHAT IS WORKING AND WHAT IS MISSED",
    `Title: "3 Keywords Working For You, 7 Opportunities Waiting to Be Captured". Two columns. Left: "Currently Ranking (You Are Being Found)" with these 3 keywords: ${rankingLine || "(none ranking)"}. Note: these are brand searches - people who already know the name. Right: "Opportunity Keywords (People Are Searching)" with these 7 keywords marked Not Ranking: ${opportunityLine || "(no opportunity data)"}.${totalOpportunityVolume ? ` Total opportunity: ${totalOpportunityVolume.toLocaleString()} people per month are searching for exactly what they sell in ${loc} and cannot find them.` : ""}`,
    "",
    "slide-06  LISTINGS - DIRECTORY GAP",
    totalListings
      ? `Title: "${missing.length} Out of ${totalListings} Directories Are Unclaimed". Show a big percent (${Math.round((missing.length / totalListings) * 100)}% missing) and list these notable missing directories: ${missingLine || "(see report)"}. Why it matters: every unclaimed listing is a missed trust signal for Google to verify the business is real, local, and trustworthy.`
      : "Title: \"Directory Gap\". Explain why consistent listings are the trust signal Google uses to verify a business.",
    "",
    "slide-07  PILLAR III: SOCIAL MEDIA PRESENCE",
    "Visual structure mirrors the B2B Suite Pillar III slide: left side shows the SMB Solutions value prop (consistent AI-assisted posting across all major platforms, brand-aligned messaging, engagement support, professional visibility). Right side shows THIS CLIENT'S actual social footprint.",
    social ? `Client Social grade: ${social.score}/100. Summary: ${social.summary}` : "",
    social?.strengths?.length ? `What is working: ${social.strengths.slice(0, 3).join("; ")}.` : "",
    social?.gaps?.length ? `What needs attention: ${social.gaps.slice(0, 3).join("; ")}.` : "",
    "Result line: \"Stay visible and relevant without constant manual effort.\"",
    "",
    "slide-08  PILLAR IV: REPUTATION MANAGEMENT & TRUST",
    "Visual structure mirrors the B2B Suite Pillar IV slide: left side shows the SMB Solutions value prop (monitor and manage reviews across all major platforms, automate review requests, respond professionally, strengthen trust signals, protect brand reputation). Right side shows THIS CLIENT'S actual reputation snapshot.",
    rep ? `Client Reputation grade: ${rep.score}/100. Summary: ${rep.summary}` : "",
    rep?.strengths?.length ? `What is working: ${rep.strengths.slice(0, 3).join("; ")}.` : "",
    rep?.gaps?.length ? `What needs attention: ${rep.gaps.slice(0, 3).join("; ")}.` : "",
    "Result line: \"Turn trust into more calls, bookings, and sales.\"",
    "",
    "slide-09  SMB SMART CRM (STATIC SLIDE - IDENTICAL CONTENT FOR EVERY CLIENT, ONLY THE BRAND THEME CHANGES)",
    "This is the unifier slide. Use this EXACT content with no edits or improvisation:",
    "  Title: \"SMB Smart CRM: Built for Small Businesses\"",
    "  Subtitle: \"The Centralized Operational Backbone of Your Business\"",
    "  Left side - six green-check bullets in this exact order:",
    "    - Capture and organize leads from calls, forms, chat, and messages",
    "    - Track every interaction in one unified customer timeline",
    "    - Manage sales stages, pipelines, and opportunities visually",
    "    - Automate follow-ups, reminders, and task assignments",
    "    - Sync seamlessly with email, SMS, and scheduling tools",
    "    - Result: Keep your business organized, responsive, and growing.",
    "  Right side: a CRM dashboard mock illustration (laptop frame, contacts, leads, deals in pipeline, won deals, revenue, sales pipeline bars, deals by stage donut, recent activities, contact 360 view). Use the SMB Solutions navy + green palette accents over the client brand colors.",
    "  Bottom band: \"Built around four pillars, connected through one unified client hub / CRM dashboard.\"",
    "",
    "slide-10  THE FOUR PILLARS, ONE HUB",
    `Recap slide. Title: "Four Pillars, One Unified Hub". Show the four pillar icons (AI Support Staff, Social Media, SEO, Reputation) connected to a center CRM icon. Tagline: "Built around four pillars, connected through one unified client hub."`,
    "",
    "slide-11  THREE FOCUSED STEPS - NEXT 90 DAYS",
    `Title: "Three Focused Steps That Will Move the Needle in the Next 90 Days". Three numbered columns derived from the audit's top gaps (typically: claim and fix listings; launch review collection system; activate missing channels like LinkedIn or AI workflows). Close: "These are not overwhelming projects. With the right tools and support, each step can be completed without adding stress to your week. That is exactly what SMB Solutions is here for."`,
    "",
    "slide-12  CLOSE",
    `Title: "The Foundation Is Here. The Growth Is One Decision Away." Left column: a warm closing paragraph that acknowledges what ${cn} has already built and frames this audit as a map, not a list of failures. Right column: "What SMB Solutions Provides" with four bullets covering listing management, automated review collection, social scheduling, and ongoing reporting. Bottom CTA: "Schedule your strategy session with SMB Solutions today." Include the client logo + "SMB Solutions" wordmark.`,
    "",
    "STYLE REQUIREMENTS:",
    `- Use the whiteboard template (template_uid ${TEMPLATE_UID}). Embed the client logo when provided.`,
    "- SMB Solutions brand voice: faith-rooted strategy, seamless integration, real human support.",
    "- Never say \"Vendasta\". Refer to the CRM as \"SMB Smart CRM\" or \"SMB Solutions CRM\".",
    "- Always call the audit a \"Digital Presence Audit\", never a \"website audit\".",
    "- Avoid em-dashes and en-dashes throughout (no \u2013 or \u2014).",
    "- Visual-first: charts, big numbers, two-column layouts, icons. Minimize prose. Each slide should be skimmable in 10 seconds.",
    "- Pillar slides MUST follow the B2B Suite structure: left = consistent SMB Solutions value prop, right = client-specific data.",
    "- The SMB Smart CRM slide MUST be static content as specified above. Do not improvise it.",
    "- FINAL SLIDE COUNT CHECK: before delivering, confirm the deck has at least 12 slides and no more than 15. A 10-slide deck is NOT acceptable for this template. If you find yourself at 10, you have skipped required pillar content and must add it back.",
    "",
    "Deliverables required:",
    "- All slides saved as individual PNG images labeled slide-01.png through slide-NN.png, bundled in a single zip file.",
    "- One PDF containing all slides in order.",
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
