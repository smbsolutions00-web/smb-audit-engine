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
 * presents every time, rendered in nano-banana WHITEBOARD style.
 *
 * Story arc (problems first, solutions second):
 *   1. Cover                              (whiteboard)
 *   2. The Path We Walk Together          (intro + agenda)
 *   3. Four Pillars, One Hub              (architecture overview, EARLY)
 *   4. Reality Check Scoreboard           (all 4 grades, gauges)
 *   5..N  AUDIT REALITY                  (problem-only slides, one per F/D pillar; B/C pillars consolidated)
 *   N+1   The Pattern                    (what all the problems have in common)
 *   N+2..N+5  THE ANSWER                 (one per pillar with dashboard mock; only for pillars that need fixing)
 *   N+6   SMB Smart CRM                  (STATIC unifier, dashboard mock)
 *   N+7   Your 90-Day Plan               (timeline)
 *   N+8   Let's Get To Work              (close)
 *
 * CRITICAL: nano-banana renders each slide as a generated image. The
 * whiteboard template_uid alone does NOT guarantee whiteboard output;
 * prescriptive design instructions (columns, tables, palettes) override
 * the template. So this prompt deliberately AVOIDS layout / typography
 * direction and only uses whiteboard-native language: "hand-drawn arrow",
 * "sketched gauge", "highlighter circle", "marker handwriting", "sticky
 * note". Let nano-banana handle the rest.
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

  // Helper for solution-slide dashboard mock language. Every solution slide
  // must instruct nano-banana to sketch a laptop/monitor frame with a
  // hand-drawn dashboard mockup inside (NOT a clean digital UI).
  const dashboardMockSketch = (label: string) =>
    `Sketch a laptop or monitor on the whiteboard with hand-drawn marker lines, and inside the screen sketch a ${label} dashboard mockup (bar charts drawn with marker, a donut chart drawn with marker, contact rows drawn with marker, all in classic whiteboard marker style). The dashboard should look like it was drawn on the whiteboard with markers, not pasted in as a real screenshot.`;

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
      `Illustrated cartoon whiteboard scene (flat 2D digital illustration, NOT a photograph). Across the top in bold stylized hand-lettered black display font, the title "Digital Presence Audit". Underneath in a bold blue stylized hand-lettered font, the client name "${cn}". Underneath that in a smaller stylized font, the location "${loc}". On the lower right in red stylized handwriting, "Prepared by Dwayne Johnson, SMB Solutions". In one corner, a cartoon-illustrated yellow sticky note that reads "Faith-rooted strategy. Seamless integration. Real human support." If a client logo has been provided, draw it as a stylized illustrated card taped to the whiteboard in the upper-left corner with cartoon-drawn tape corners (not a photo composite, redraw the logo in the same illustrated style). Add a cartoon-drawn arrow swooping from the title down toward the rest of the board to suggest the journey ahead.`,
    ].join("\n"),
  );

  // ---------- SLIDE: Path We Walk Together ----------
  slides.push(
    [
      "THE PATH WE WALK TOGETHER",
      `Illustrated cartoon whiteboard scene with the stylized hand-lettered title "The Path We Walk Together" in blue, underlined twice with a red marker stroke. Below the title, draw five cartoon-illustrated rounded rectangle boxes connected by cartoon-drawn arrows in this order: 1) "Where ${cn} Stands" 2) "What Is Working" 3) "What Is Being Missed" 4) "How We Fix It" 5) "Your Next 90 Days". Each box label is in stylized hand-lettered font. The arrows between boxes are cartoon-drawn, slightly imperfect for hand-drawn feel. In a corner, a cartoon yellow sticky note reads "This audit is a map, not a list of failures."`,
    ].join("\n"),
  );

  // ---------- SLIDE: Four Pillars, One Hub (architecture, EARLY) ----------
  slides.push(
    [
      "FOUR PILLARS, ONE UNIFIED HUB",
      `Illustrated cartoon whiteboard scene with the stylized hand-lettered title "Four Pillars, One Unified Hub" in bold black, underlined with blue and red strokes. In the center of the board, draw a large cartoon circle labeled "SMB Smart CRM" in green stylized lettering. Around that center circle, draw four labeled cartoon boxes connected with cartoon arrows: top-left "AI & Automation", top-right "SEO, Keywords & Listings", bottom-left "Social Media", bottom-right "Reputation". Each box has a small cartoon-illustrated icon next to its label (a robot face, a magnifying glass, a phone, a star). The four arrows all flow into the center CRM circle. At the bottom, in stylized hand-lettered font, "Every pillar feeds the one place that runs your business."`,
    ].join("\n"),
  );

  // ---------- SLIDE: Reality Check Scoreboard ----------
  slides.push(
    [
      "REALITY CHECK SCOREBOARD",
      `Illustrated cartoon whiteboard scene with the stylized hand-lettered title "Where ${cn} Stands Today" in black, underlined in red. Below, draw four cartoon-illustrated speedometer gauges (flat colors with light hatching for shading), one per pillar, arranged across the board with the pillar name in stylized hand-lettered font under each gauge:`,
      pillarSlots
        .map(
          (p) =>
            `  - ${p.label}: gauge needle pointed at ${p.score ?? "?"}/100${p.grade ? ` (grade ${p.grade})` : ""}. Color the gauge arc with the appropriate marker: ${p.severity === "critical" ? "red marker, needle in the red zone" : p.severity === "weak" ? "orange marker, needle in the orange zone" : "green marker, needle in the green zone"}.`,
        )
        .join("\n"),
      `Below the gauges, in handwritten red marker on a hand-drawn underline, write: "${problemPillars.length} of 4 pillars need urgent attention." In a corner, a sticky note reads "Honest numbers. Real opportunity."`,
    ].join("\n"),
  );

  // ====================================================================
  // PROBLEM SLIDES - one per F/D pillar. NO solution language here.
  // ====================================================================

  for (const p of problemPillars) {
    if (p.key === "ai") {
      slides.push(
        [
          "THE INVISIBLE COST: AI & AUTOMATION GAP",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black: "The Cost of Being Invisible to AI". Underneath in stylized font, the score: "${p.score ?? "?"}/100${p.grade ? ` (${p.grade})` : ""}".`,
          `In the upper left, sketch six small phone-screen rectangles in marker, each labeled with an AI assistant name. Mark each NOT-cited platform with a hand-drawn red X over the screen, and each cited platform with a green check.`,
          aiAbsent.length
            ? `AI assistants where ${cn} is NOT cited (draw RED X): ${aiAbsent.map((a) => a.platform).join(", ")}.`
            : "",
          aiPresent.length
            ? `AI assistants where ${cn} IS cited (draw GREEN CHECK): ${aiPresent.map((a) => a.platform).join(", ")}.`
            : `${cn} is NOT cited on any of the six major AI platforms audited. Mark all six with red X.`,
          `On the right side of the whiteboard, hand-write three problem statements in red marker, each preceded by a hand-drawn red X:`,
          ...(p.gaps || []).slice(0, 3).map((g) => `  - ${g}`),
          `At the bottom in handwritten red marker, underlined twice: "Every search that goes to an AI today is a customer ${cn} cannot recover."`,
          `IMPORTANT: this slide shows ONLY the problem. Do NOT mention SMB Solutions, AI Receptionist, Chat Agent, or any solution. The solution comes later.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "seo") {
      // SEO gets up to TWO problem slides: keywords, and directories+NAP.
      slides.push(
        [
          "WHO IS FINDING YOU vs WHO IS BEING MISSED",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black: "Who Is Finding ${cn}, And Who Is Being Missed". Down the left side, in green stylized hand-lettered font under the header "Currently Ranking (people who already know your name)", list:`,
          rankingLine
            ? `  ${ranking.map((k) => `${k.keyword}${k.position ? ` (#${k.position})` : ""}${k.volume ? `, ${k.volume.toLocaleString()}/mo` : ""}`).join("\n  ")}`
            : "  (no keywords ranking today)",
          `Down the right side, under the hand-drawn red-marker header "NOT Ranking (people searching but going to competitors)", list these opportunity keywords with a red marker X next to each:`,
          opportunityLine
            ? `  ${opportunity.map((k) => `${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()}/mo)` : ""}`).join("\n  ")}`
            : "  (no opportunity data)",
          totalOpportunityVolume
            ? `At the bottom of the whiteboard, in a hand-drawn red highlighter rectangle: "${totalOpportunityVolume.toLocaleString()} people per month are searching for exactly what ${cn} sells in ${loc}, and going to competitors."`
            : "",
          `Sketch a hand-drawn arrow in red marker pointing from the left column to the right column with a question mark above it. Do NOT mention any fix or solution. This slide is the problem only.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      if (totalListings) {
        slides.push(
          [
            "THE DIRECTORY TRUST GAP",
            `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black: "Google Checks ${totalListings} Directories. ${cn} Is On Only ${claimed}."`,
            `In the center of the board, draw a large cartoon-illustrated donut/pie chart. Color ${Math.round(((totalListings - claimed) / totalListings) * 100)}% of the donut in flat red with light hatching (the missing portion) and ${Math.round((claimed / totalListings) * 100)}% in flat green with light hatching (the claimed portion). In the middle of the donut, in big stylized hand-lettered font, the number "${claimed}/${totalListings}".`,
            `To the right of the donut, hand-list a few notable missing directories in red marker, each with a hand-drawn red X: ${missingLine || "(see audit report)"}.`,
            napScore !== undefined
              ? `Below the donut, in handwritten red marker on a hand-drawn underline: "NAP Consistency Score: ${napScore}/100. When your name, address, and phone number do not match across the web, Google stops trusting that you exist."`
              : `Below the donut, in handwritten red marker on a hand-drawn underline: "Every unclaimed directory is a door ${cn} left unlocked for a competitor."`,
            `In a corner, sketch a small sticky note that reads "NAP = Name, Address, Phone. Google's #1 local trust signal." Do NOT mention any fix or solution on this slide.`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      continue;
    }
    if (p.key === "social") {
      slides.push(
        [
          "THE SOCIAL MEDIA WORKLOAD PROBLEM",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black: "Where ${cn} Shows Up, And Where The Workload Is Breaking". Down the left side, in green stylized hand-lettered font under header "What Is Working", list:`,
          ...((p.strengths || []).slice(0, 3).map((s) => `  - ${s}`) || []),
          `Down the right side, in red stylized hand-lettered font under header "What Is Being Missed", list each with a cartoon red X:`,
          ...((p.gaps || []).slice(0, 3).map((g) => `  - ${g}`) || []),
          `At the bottom in handwritten red marker: "Manual posting on every platform every week is unsustainable. This is where burnout starts." Do NOT propose a fix yet.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "reputation") {
      slides.push(
        [
          "THE REPUTATION RISK",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black: "Your Reputation Is Working. Your System Is Not.". On the left, draw a cartoon five-star row in flat green with light hatching, with the score "${p.score ?? "?"}/100" in stylized hand-lettered font underneath.`,
          ...((p.strengths || []).slice(0, 2).map((s) => `What is working (write in green marker with a check): "${s}"`)),
          ...((p.gaps || []).slice(0, 3).map((g) => `What is being missed (write in red marker with a red X): "${g}"`)),
          `At the bottom in red stylized hand-lettered font: "Stars do not collect themselves. Without a system to ask, follow up, and respond, the next ten reviews could go either way." No solution language on this slide.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
  }

  // Steady (B/C) pillars get a single consolidated "Holding Ground" slide.
  if (steadyPillars.length) {
    slides.push(
      [
        "WHERE YOU ARE HOLDING GROUND",
        `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in green: "Where ${cn} Is Holding Ground". For each steady pillar listed below, draw a cartoon green check mark and write the pillar label and score in green stylized hand-lettered font, followed by one short observation:`,
        ...steadyPillars.map(
          (p) =>
            `  - ${p.label} (${p.score ?? "?"}/100${p.grade ? `, ${p.grade}` : ""}): ${p.summary || "steady performance"}`,
        ),
        `At the bottom, in handwritten marker: "These are real strengths. We protect them while we fix what is broken."`,
      ].join("\n"),
    );
  }

  // ---------- SLIDE: The Pattern ----------
  slides.push(
    [
      "THE PATTERN BEHIND THE PROBLEMS",
      `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in red: "The Pattern Behind The Problems". In the center of the board, draw three large overlapping cartoon circles like a Venn diagram, each labeled in stylized hand-lettered font: "Manual", "Reactive", "Leaking Customers". Where the three circles overlap in the center, write "${cn} Today" in red stylized hand-lettered font.`,
      `On the right side of the board, hand-write in red marker: "Every pillar that is weak today has the same root cause: there is no system running underneath it. The work happens manually. The follow-up happens late. The opportunity slips out the back door."`,
      `At the bottom in big black stylized hand-lettered font, underlined: "What changes everything is the system underneath. That is what we build next."`,
    ].join("\n"),
  );

  // ====================================================================
  // SOLUTION SLIDES - one per pillar that needs fixing. Dashboard mocks.
  // ====================================================================

  for (const p of problemPillars) {
    if (p.key === "ai") {
      slides.push(
        [
          "THE ANSWER: YOUR 24/7 AI WORKFORCE",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in green: "Your 24/7 AI Workforce". On the left of the board, draw a column of five cartoon-illustrated boxes labeled top to bottom: "AI Receptionist", "Chat Agent", "Support Agent", "Follow-Up Agent", "Routing Agent". Each box has a small cartoon-illustrated icon (phone, chat bubble, headset, envelope, branching arrow).`,
          `On the right side, ${dashboardMockSketch("unified AI inbox / agent activity")} The dashboard should show sketched columns labeled "Calls Captured", "Chats Answered", "Follow-ups Sent", "Leads Routed". Hand-drawn arrows connect each AI agent box on the left to the dashboard on the right.`,
          `At the bottom in green stylized hand-lettered font: "Never miss a lead or customer inquiry again."`,
        ].join("\n"),
      );
      continue;
    }
    if (p.key === "seo") {
      slides.push(
        [
          "THE ANSWER: BE FOUND EVERYWHERE THEY SEARCH",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in green: "Be Found Everywhere They Search". On the left, three labeled cartoon blocks in stylized hand-lettered font: "Local SEO", "AEO (Answer Engine Optimization)", "GEO (Generative Engine Optimization)". Beside each block, a small cartoon-illustrated icon: a map pin, a question-mark bubble, a small AI-chip.`,
          `On the right, ${dashboardMockSketch("keyword ranking and directory listings")} The dashboard should show sketched rows of keywords with rising green arrows, and a sketched checklist of directory names with green check marks appearing one by one.`,
          totalListings
            ? `Include a hand-drawn note that says: "${totalListings} directories standardized. ${totalOpportunityVolume.toLocaleString()} monthly searches recovered."`
            : "",
          `At the bottom in green stylized hand-lettered font: "Be the answer Google AND AI engines pick first."`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (p.key === "social") {
      slides.push(
        [
          "THE ANSWER: SOCIAL THAT RUNS WITHOUT BURNOUT",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in green: "Social That Runs Without Burnout". On the left, four cartoon-illustrated platform icons stacked vertically (Facebook, Instagram, TikTok, LinkedIn) with cartoon arrows feeding into a single central cartoon calendar box labeled "AI-assisted content calendar".`,
          `On the right, ${dashboardMockSketch("social media content calendar with scheduled posts")} The dashboard shows a sketched month-view calendar with little colored marker squares on different days representing scheduled posts, and a sidebar showing "Posts Drafted", "Posts Scheduled", "Engagement Replies".`,
          `At the bottom in green stylized hand-lettered font: "Stay visible and relevant without constant manual effort."`,
        ].join("\n"),
      );
      continue;
    }
    if (p.key === "reputation") {
      slides.push(
        [
          "THE ANSWER: A REPUTATION SYSTEM",
          `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in green: "A Reputation System, Not A Reputation Hope". On the left, a cartoon-illustrated flow: customer pays > automated review request sent > review captured > 5-star reviews flow into Google Business Profile.`,
          `On the right, ${dashboardMockSketch("reputation management with reviews and ratings")} The dashboard shows a sketched star-rating average, a sketched bar chart of reviews-per-month rising, and a column of recent review cards with sketched five-star rows on each.`,
          `At the bottom in green stylized hand-lettered font: "Turn trust into more calls, bookings, and sales."`,
        ].join("\n"),
      );
      continue;
    }
  }

  // ---------- SLIDE: SMB Smart CRM (STATIC, locked content) ----------
  slides.push(
    [
      "SMB SMART CRM: THE OPERATIONAL BACKBONE",
      `STATIC SLIDE. Illustrated cartoon whiteboard scene. Stylized hand-lettered title in bold black: "SMB Smart CRM: Built for Small Businesses". Subtitle in blue stylized hand-lettered font: "The Centralized Operational Backbone of Your Business".`,
      `On the left side, sketch six handwritten lines in marker, each preceded by a hand-drawn green check mark, in this exact order:`,
      `  1. Capture and organize leads from calls, forms, chat, and messages`,
      `  2. Track every interaction in one unified customer timeline`,
      `  3. Manage sales stages, pipelines, and opportunities visually`,
      `  4. Automate follow-ups, reminders, and task assignments`,
      `  5. Sync seamlessly with email, SMS, and scheduling tools`,
      `  6. Result: Keep your business organized, responsive, and growing.`,
      `On the right side, ${dashboardMockSketch("complete CRM with contacts, pipeline revenue, deals by stage, recent activity, and contact 360 view")} The dashboard should clearly show four sketched tiles: "Contacts" with a number, "Pipeline Revenue" with a dollar figure, "Deals by Stage" with a hand-drawn donut, and "Recent Activity" with stacked rows.`,
      `At the bottom in handwritten marker across the full width: "Built around four pillars, connected through one unified client hub."`,
      `Do NOT improvise this content. Keep the six bullets identical to what is listed above.`,
    ].join("\n"),
  );

  // ---------- SLIDE: 90-Day Plan ----------
  slides.push(
    [
      "YOUR 90-DAY PLAN",
      `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in black, underlined with blue and red strokes: "Your Next 90 Days". Across the bottom of the board, draw a cartoon horizontal timeline with three milestones labeled "Day 30", "Day 60", "Day 90". Each milestone is a small cartoon dot on the timeline.`,
      `Above the timeline, hand-draw three labeled boxes in marker connected to each milestone:`,
      `  - Phase 1 (Days 1-30): Foundation. Hand-write the highest-priority fix from the audit (typically: claim and standardize directory listings, fix NAP, set up review collection).`,
      `  - Phase 2 (Days 31-60): Activation. Hand-write the second priority (typically: launch AI workforce, activate review automation, activate social calendar).`,
      `  - Phase 3 (Days 61-90): Acceleration. Hand-write the long-term build (typically: keyword content build-out, authority/links, reporting cadence).`,
      `In a corner, a cartoon yellow sticky note that reads "No overwhelm. Right tools, right support, right pace." At the bottom in green stylized hand-lettered font: "Each step can be completed without adding stress to your week. That is what SMB Solutions is here for."`,
    ].join("\n"),
  );

  // ---------- SLIDE: Let's Get To Work ----------
  slides.push(
    [
      "LET'S GET TO WORK",
      `Illustrated cartoon whiteboard scene. Stylized hand-lettered title in big black, underlined twice: "Let's Get To Work". Below the title, three cartoon-illustrated labeled boxes connected with cartoon arrows:`,
      `  - "THE VERDICT": handwritten in red marker: "The foundation is real. The gaps are fixable. The opportunity is now."`,
      `  - "THE FOCUS": handwritten in blue marker: "Pillar fixes, dashboards, real human support."`,
      `  - "THE OUTCOME": handwritten in green marker: "A predictable, scalable system for capturing and keeping customers."`,
      `Below the boxes, hand-draw a green-marker "START" button shape in the bottom-center with a green checkmark sketched inside it. Around it, draw red marker arrows pointing inward at the START button from all directions to emphasize urgency.`,
      `In a corner of the whiteboard, a cartoon yellow sticky note reads "Faith-rooted strategy. Seamless integration. Real human support." In another corner, a cartoon-illustrated taped card with the client logo (if provided) and a small "SMB Solutions" wordmark, both redrawn in the illustrated style.`,
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
    "VISUAL STYLE - READ THIS FIRST. THIS OVERRIDES EVERYTHING.",
    "==================================================================",
    "Every single slide in this deck MUST be rendered as an ILLUSTRATED WHITEBOARD SCENE in a flat 2D digital cartoon style. Think of a digital marker illustration: the whiteboard is drawn (not photographed), the marker writing is stylized hand-lettered display fonts (not real handwriting and not photographed marker strokes), the doodles are crisp flat-colored cartoon drawings with light hatching for shading (lightbulbs, targets, gauges, arrows, sticky notes), and the colors are bold and clean. The aesthetic is a polished hand-drawn illustration of a whiteboard that you would see in a modern strategy deck, NOT a real-world photograph of a whiteboard in an office.",
    "",
    "This is the Manus 'Whiteboard' nano-banana template. Render the illustrated cartoon whiteboard aesthetic on EVERY slide. Do NOT produce clean digital slides, brand-styled slide templates, brown-on-cream typography slides, navy-and-green corporate slides, OR a photorealistic photograph of a real whiteboard. NEVER photorealistic. NEVER a photo. If a slide looks like either a clean corporate slide OR a real-world photo, you have drifted from the template and must restart that slide in flat illustrated cartoon style.",
    "",
    "DO NOT use any of the following: serif typography for titles, two-column corporate layouts, table grids, donut charts that look like clean Figma vectors, percent rings that look like clean Figma vectors, brand color blocks, gradients, soft drop shadows, photorealistic lighting, real lens reflections on the board, real marker tray photos. EVERYTHING is drawn in a flat illustrated cartoon style on top of a drawn whiteboard.",
    "",
    "WHEN this prompt describes a chart, dashboard, or visual: it must be drawn in the same illustrated cartoon style as the rest of the board. A donut chart is two arcs of flat color around a circle with light marker hatching. A bar chart is cartoon-drawn bars with hatched shading. A dashboard is a cartoon-drawn laptop frame with cartoon UI elements inside. None of these are real digital screenshots, and none of these are photos of real marker strokes either.",
    "",
    `If a client logo has been attached, draw it as a stylized illustrated card taped to the whiteboard, with cartoon-drawn tape corners. The logo card is drawn into the scene, not photo-composited. Do not embed it as a clean vector. Do not paste it as a pristine real logo. Do not render it as a photograph. Re-draw it in the same illustrated style as the rest of the board.`,
    "",
    "==================================================================",
    "DECK CONTENT - what each slide is about.",
    "==================================================================",
    `This is a Digital Presence Audit prepared by Dwayne Johnson at SMB Solutions for ${cn}. The deck has ${slideCount} slides. Do not skip any. Do not reorder.`,
    "",
    "The deck tells a story in this order: introduce the journey, show where they stand, walk through every problem the audit found (NO solution language during the problem section), pause and name the pattern across the problems, then walk through the answer one pillar at a time WITH a sketched dashboard mockup on each solution slide, then SMB Smart CRM as the unifier, then the 90-day plan, then a closing call to action.",
    "",
    "BRAND VOICE RULES:",
    "- Never say 'Vendasta'. The CRM is 'SMB Smart CRM' or 'SMB Solutions CRM'.",
    "- The audit is a 'Digital Presence Audit', never a 'website audit'.",
    "- No em-dashes (\u2014). No en-dashes (\u2013). Use periods, commas, or parentheses.",
    "- Brand voice: faith-rooted strategy, seamless integration, real human support.",
    "",
    directoriesAuditedLine,
    "",
    "==================================================================",
    "SLIDES (in order, each rendered as an illustrated cartoon whiteboard scene):",
    "==================================================================",
    "",
    numberedSlides,
    "",
    "==================================================================",
    "DELIVERABLES:",
    "==================================================================",
    `- ${slideCount} slides, each rendered as an individual PNG in the illustrated cartoon whiteboard style (flat colors, stylized hand-lettered fonts, cartoon doodles, NOT a real-world photograph), bundled in a single zip file labeled slide-01.png through slide-${String(slideCount).padStart(2, "0")}.png.`,
    "- One PDF containing all slides in order.",
    "- Before finishing, verify every slide is in the illustrated cartoon whiteboard style. If any slide looks like a clean corporate digital design OR like a real-world photograph of a physical whiteboard, regenerate that slide in the illustrated cartoon style.",
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
