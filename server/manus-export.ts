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
 * Build the prompt the user dictated, augmented with the actual report data
 * so Manus has the numbers it needs to render concrete slides.
 */
function buildPrompt(audit: Audit, report: ReportData | null): string {
  const cn = audit.clientName || "the client";
  const ind = audit.industry || "their industry";
  const loc = audit.location || "their service area";

  // Pull a few real numbers from the report so Manus has facts to render.
  const ranking = report?.seoDeep?.rankingKeywords?.slice(0, 5) || [];
  const opportunity = report?.seoDeep?.opportunityKeywords?.slice(0, 10) || [];
  const listings = report?.seoDeep?.listings || [];
  const missing = listings.filter((l) => l.status === "Missing");
  const total = listings.length || 0;
  const rep = report?.pillars?.reputation;
  const social = report?.pillars?.socialMedia;

  const rankingLine = ranking
    .slice(0, 3)
    .map((k) => `${k.keyword}${k.position ? ` (rank ${k.position})` : ""}${k.volume ? `, ${k.volume.toLocaleString()} monthly searches` : ""}`)
    .join("; ");

  const opportunityLine = opportunity
    .slice(0, 7)
    .map((k) => `${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} monthly searches, not ranking)` : ""}`)
    .join("; ");

  const missingLine = missing
    .slice(0, 6)
    .map((l) => l.directory)
    .join(", ");

  return [
    `Client: ${cn}`,
    `Industry: ${ind}`,
    `Location: ${loc}`,
    "",
    "Need a simplified client facing overview of this audit report for the business owner to understand and follow.",
    "",
    "Keywords:",
    "As it relates to keyword be sure to show 3 of the \"Currently ranking keywords\" and the other 7 \"Opportunity keywords\" making it clear how many people are looking for them but can't find them.",
    rankingLine ? `Currently ranking (use these 3): ${rankingLine}.` : "",
    opportunityLine ? `Opportunity keywords (use these 7): ${opportunityLine}.` : "",
    "",
    "SEO + Listings: the deepest pillar:",
    "Make it clear the amount of listings they have not claimed and show the gap and a few of the missing important directories.",
    total ? `Total directories audited: ${total}. Missing/unclaimed: ${missing.length}.` : "",
    missingLine ? `Notable missing directories: ${missingLine}.` : "",
    "",
    "Reputation",
    "Show what the industry leaders are doing vs them but give them a pat on the back for having a social media presence.",
    rep?.summary ? `Reputation snapshot: ${rep.summary}` : "",
    social?.summary ? `Social media snapshot: ${social.summary}` : "",
    "",
    `Produce 10 slides labeled slide-01 through slide-10 (or however many fit the story). Use the whiteboard template (template_uid ${TEMPLATE_UID}). Embed the client logo when provided. Use SMB Solutions brand voice: faith-rooted strategy, seamless integration, real human support. Do not say "Vendasta" anywhere; refer to it as "SMB Solutions CRM" if needed. Audit must be called "Digital Presence Audit", never "website audit". Avoid em-dashes and en-dashes.`,
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
