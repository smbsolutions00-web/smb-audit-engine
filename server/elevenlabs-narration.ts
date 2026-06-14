/**
 * ElevenLabs DJ #2 narration script generator.
 *
 * Strategy:
 *   1. Try text extraction with pdf-parse (fast, free).
 *   2. If the PDF is image-only (or text is too short), render every page
 *      to PNG with poppler's pdftoppm and send the page images to Claude's
 *      vision API so it can read the slides directly.
 *   3. Fill the DJ #2 faith-based template with slide-by-slide narration
 *      (block-by-block, voice-direction tags, SSML <break/>) and return
 *      the script as plain text ready to paste into ElevenLabs.
 *
 * The template lives at templates/elevenlabs-dj2-narration-template.txt.
 * The Intro section and the warm closing are reproduced verbatim with
 * only [OWNER NAME/S], [BUSINESS NAME], [CITY], and [SERVING YOUR
 * CUSTOMERS] substituted. There is no opening prayer or closing prayer
 * in this template.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePdfBuffer } from "./audit-engine";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* Resolve template path. We try a few locations because in the bundled
   production build (esbuild -> dist/index.cjs) __dirname points at /app/dist
   while the templates ship at /app/templates. */
function resolveTemplatePath(): string | null {
  const candidates = [
    process.env.ELEVENLABS_TEMPLATE_PATH,
    join(process.cwd(), "templates", "elevenlabs-dj2-narration-template.txt"),
    join(process.cwd(), "..", "templates", "elevenlabs-dj2-narration-template.txt"),
    "/app/templates/elevenlabs-dj2-narration-template.txt",
    "/opt/render/project/src/templates/elevenlabs-dj2-narration-template.txt",
  ].filter(Boolean) as string[];

  try {
    // @ts-ignore - __dirname exists in CJS bundle
    if (typeof __dirname !== "undefined") {
      candidates.push(join(__dirname, "..", "templates", "elevenlabs-dj2-narration-template.txt"));
      candidates.push(join(__dirname, "templates", "elevenlabs-dj2-narration-template.txt"));
    }
  } catch {
    /* ignore */
  }
  try {
    // @ts-ignore - import.meta exists in ESM
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "templates", "elevenlabs-dj2-narration-template.txt"));
  } catch {
    /* ignore */
  }

  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function loadTemplate(): string {
  const path = resolveTemplatePath();
  if (!path) {
    throw new Error(
      "ElevenLabs template not found. Set ELEVENLABS_TEMPLATE_PATH or include templates/ in the build.",
    );
  }
  return readFileSync(path, "utf8");
}

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set; cannot generate narration script.");
  }
  _client = new Anthropic();
  return _client;
}

export interface NarrationContext {
  ownerName: string;
  businessName: string;
  industry?: string;
  location?: string;
  overallGrade?: string | null;
  overallScore?: number | null;
  /** Full structured ReportData (with tiered keywords + liveValidation block).
   *  Passed through opaquely so the narration model can ground itself in
   *  verified facts and the Brand → Local → National keyword arc. */
  reportData?: any;
}

// First-name parser moved to ./lib/names.ts so the audit pipeline can
// share the same logic. Re-export for any callers that imported it from here.
export { firstNameOf } from "./lib/names";
import { firstNameOf } from "./lib/names";

export interface GenerateNarrationArgs {
  pdfPath: string;
  context: NarrationContext;
}

/* Render every page of a PDF to a PNG using poppler's pdftoppm.
   Returns base64-encoded PNG strings, one per page. Caps at MAX_PAGES so
   a long PDF can't blow the vision token budget. */
const MAX_PAGES = 20;
const RENDER_DPI = 110; // ~1100x1700 for letter, plenty for slide reading

function renderPdfToPngBase64(pdfPath: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "manus-render-"));
  try {
    execFileSync(
      "pdftoppm",
      [
        pdfPath,
        join(dir, "page"),
        "-png",
        "-r",
        String(RENDER_DPI),
        "-l",
        String(MAX_PAGES),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort((a, b) => {
        const na = parseInt(a.match(/page-(\d+)\.png/)?.[1] || "0", 10);
        const nb = parseInt(b.match(/page-(\d+)\.png/)?.[1] || "0", 10);
        return na - nb;
      });
    return files.map((f) => readFileSync(join(dir, f)).toString("base64"));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------- Verified facts + tiered keyword blocks ---------------------- */

/**
 * Build the VERIFIED FACTS block that the narration model must trust over
 * any contradicting slide content. Pulled from reportData.liveValidation.
 * Returns an empty string if there is nothing verified.
 */
function buildVerifiedFactsBlock(report: any): string {
  const lv = report?.liveValidation;
  if (!lv) return "";
  const lines: string[] = ["=== VERIFIED FACTS (live Google check; trust these over the slides) ==="];
  if (lv.gbp?.present) {
    const parts: string[] = ["Google Business Profile: ACTIVE"];
    if (typeof lv.gbp.rating === "number") parts.push(`rating ${lv.gbp.rating} stars`);
    if (typeof lv.gbp.reviewCount === "number") parts.push(`${lv.gbp.reviewCount} reviews`);
    if (lv.gbp.phone) parts.push(`phone ${lv.gbp.phone}`);
    if (lv.gbp.address) parts.push(`address ${lv.gbp.address}`);
    lines.push(`- ${parts.join(", ")}.`);
  } else {
    lines.push("- Google Business Profile: NOT FOUND in live search.");
  }
  const social = Array.isArray(lv.social) ? lv.social : [];
  const present = social.filter((s: any) => s.present).map((s: any) => s.platform);
  const absent = social.filter((s: any) => !s.present).map((s: any) => s.platform);
  if (present.length > 0) lines.push(`- Social profiles CONFIRMED active: ${present.join(", ")}.`);
  if (absent.length > 0) lines.push(`- Social profiles NOT FOUND in live search: ${absent.join(", ")}.`);
  if (Array.isArray(lv.discrepancies) && lv.discrepancies.length > 0) {
    lines.push("- Discrepancies vs snapshot: " + lv.discrepancies.join(" | "));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the KEYWORD TIERS block that powers the Brand → Local → National
 * narration arc. We surface up to 5 of each tier with volume + position so
 * the model can reference real numbers instead of guessing.
 */
function buildKeywordTiersBlock(report: any): string {
  const seo = report?.seoDeep;
  if (!seo) return "";
  const ranking = Array.isArray(seo.rankingKeywords) ? seo.rankingKeywords : [];
  const opportunity = Array.isArray(seo.opportunityKeywords) ? seo.opportunityKeywords : [];
  // Combine then dedupe by keyword so each keyword shows up in exactly one tier.
  const all: any[] = [...ranking, ...opportunity];
  if (all.length === 0) return "";
  const seen = new Set<string>();
  const uniq = all.filter((r) => {
    const k = (r.keyword || "").toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const fmt = (r: any) => {
    const parts: string[] = [`"${r.keyword}"`];
    if (typeof r.position === "number") parts.push(`pos #${r.position}`);
    if (typeof r.volume === "number") parts.push(`${r.volume.toLocaleString()} searches/mo`);
    if (r.volumeGeo) parts.push(r.volumeGeo);
    return parts.join(", ");
  };

  const brand = uniq.filter((r) => r.tier === "brand").slice(0, 5);
  const local = uniq.filter((r) => r.tier === "local").slice(0, 8);
  const national = uniq.filter((r) => r.tier === "national").slice(0, 5);

  const lines: string[] = ["=== KEYWORD STORY ARC (use these tiers in order on any keyword slide) ==="];
  lines.push("BRAND tier (ranking for the business's OWN NAME; only captures customers who already know the brand, brings in NO new buyers):");
  if (brand.length === 0) lines.push("  (none yet)");
  else brand.forEach((r) => lines.push(`  - ${fmt(r)}`));
  lines.push("TRUE-INTENT / LOCAL tier (the REAL OPPORTUNITY; people in the city/metro who do not know the brand yet but are searching the SOLUTION with buyer intent):");
  if (local.length === 0) lines.push("  (none yet, frame as 'the exact gap we will close in 90 days')");
  else local.forEach((r) => lines.push(`  - ${fmt(r)}`));
  lines.push("NATIONAL tier (long-horizon scale once authority builds):");
  if (national.length === 0) lines.push("  (none yet, frame as 'we will revisit once local foundation is solid')");
  else national.forEach((r) => lines.push(`  - ${fmt(r)}`));
  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the ElevenLabs DJ #2 narration script for an uploaded Manus PDF.
 * Returns the plain-text script ready to paste into ElevenLabs.
 */
export async function generateElevenLabsScript(
  args: GenerateNarrationArgs,
): Promise<string> {
  const { pdfPath, context } = args;
  if (!existsSync(pdfPath)) {
    throw new Error(`Manus PDF not found at ${pdfPath}`);
  }
  const buf = readFileSync(pdfPath);
  const pdfText = cleanPdfText(await parsePdfBuffer(buf));
  const hasUsableText = pdfText.length >= 200;

  // For image-only PDFs (or when text extraction came up short), render
  // pages to PNG so we can send them to Claude's vision API.
  let pageImages: string[] = [];
  if (!hasUsableText) {
    try {
      pageImages = renderPdfToPngBase64(pdfPath);
    } catch (err: any) {
      throw new Error(
        `Could not read the Manus PDF. Text extraction returned nothing and PDF rendering failed: ${err?.message || err}`,
      );
    }
    if (pageImages.length === 0) {
      throw new Error(
        "Could not extract any pages from the Manus PDF. The file may be corrupted.",
      );
    }
  }

  const template = loadTemplate();
  const owner = context.ownerName?.trim() || context.businessName || "the owner";
  const ownerFirst = firstNameOf(owner) || owner;
  const business = context.businessName?.trim() || "the business";
  const teamPhrase = `the ${business} team`;
  const city = context.location?.trim() || "your local";

  const system = [
    "You are writing a finished ElevenLabs narration script. Your output goes straight into ElevenLabs - no preamble, no commentary, no markdown fences.",
    "You are voicing 'DJ #2', the AI personal assistant working alongside Dwayne Johnson, CEO of SMB Solutions. Voice: warm, conversational, confident, plain-English with light faith-based touches.",
    "ABSOLUTE RULES:",
    "1. Follow the supplied DJ #2 template structure exactly. Keep all section headers (### Slide N, ***).",
    "2. The Intro section and the warm closing must be reproduced VERBATIM from the template, with only [OWNER NAME/S], [BUSINESS NAME], [CITY], and [SERVING YOUR CUSTOMERS] substituted. [OWNER NAME/S] should be replaced with the value of OWNER FIRST NAME (provided in the context block) wherever it appears in the Intro. [BUSINESS NAME] should be replaced with the value of BUSINESS NAME. [SERVING YOUR CUSTOMERS] should be replaced with the industry-appropriate phrase based on INDUSTRY context: for healthcare/medical/dental/medspa/wellness/therapy/counseling use 'caring for your patients'; for law/accounting/consulting/coaching use 'serving your clients'; for restaurant/retail/hospitality/salon/beauty use 'taking care of your guests'; for trades/contractors/home services use 'serving your customers'; if INDUSTRY is unknown or missing, default to 'serving the people you serve'. Do NOT add any prayer (opening or closing). The template intentionally has no prayers.",
    "3. For each slide, replace the bracketed instruction lines with actual narration. Keep voice-direction tags like [warmly, conversational] on their own line above the spoken text. Make the slide narration feel like a personal one-on-one conversation, not a generic voiceover. Reference the owner and business naturally so the listener knows the script was written for them specifically. Across the full script (not in every single sentence) you should weave in:\n   - OWNER FIRST NAME, used as a direct address (for example: 'Tawana, here's what stands out...').\n   - BUSINESS NAME, used when referring to the business itself ('what we're seeing for Belle Wellness is...').\n   - TEAM PHRASE ('the {BUSINESS NAME} team'), used when talking about the staff/people/employees ('this gives the Belle Wellness team back hours every week').\n   Aim for roughly one direct address per slide and one or two business/team references per slide. Vary the placement (opening, middle, closing). Do NOT cram all three into every sentence, and do NOT robotically repeat 'Tawana, the Belle Wellness team, you all' as a stock phrase. Keep it natural and conversational.",
    "4. Use SSML <break time=\"0.5s\" /> or <break time=\"1.0s\" /> sparingly to pace key transitions. Never invent other SSML tags.",
    "5. Each slide section must stay under 5,000 characters of TOTAL text including voice-direction tags. Aim for 600-1,200 characters per slide.",
    "6. Produce one ### Slide N section for each slide / page provided. If you receive 12 slides, produce slides 1-12. If you receive 8, produce slides 1-8.",
    "7. Ground every slide narration in the actual content visible on that slide. Do not invent grades, scores, or numbers that aren't present.",
    "8. Plain English only - explain anything technical with one short analogy.",
    "9. CREDIBILITY OVERRIDE (most important rule). If a VERIFIED FACTS block is supplied below, those facts come from a live Google search and are CORRECT. Slides may contradict them (the slides are built from older snapshot data). When that happens you MUST trust the verified facts and silently correct the narration. Examples: if the slide says 'No Google Business Profile' but verified facts say there are 15 reviews at 5.0 stars, do NOT echo the slide; speak to the strength of the existing reviews and the opportunity to grow on top of them. If the slide says 'no Facebook' but verified facts confirm a Facebook profile, acknowledge it as a foundation to build on. Never invent a number; only use verified numbers when correcting.",
    "10. KEYWORD STORY ARC (when keyword tiers are supplied). On any slide that covers SEO keywords, frame the data as 'BRAND ranking vs. TRUE-INTENT ranking' and walk the listener through it in this exact order:\n   - FIRST: BRAND tier. Acknowledge it honestly and then minimize its weight. Sample framing: 'Right now the business is ranking for its own name and a couple of brand variants. That is good, it means people who already know the brand can find it. But ranking for your own name only captures the customers you already have. It does NOT bring in anyone new.'\n   - SECOND: TRUE-INTENT tier (the LOCAL keywords; THIS IS THE BIG PLAY). Sample framing: 'The real opportunity is ranking for true buyer intent. These are the people in {CITY/METRO} who do not know the business exists yet, but are actively searching for the solution it provides, today. For example, [name 1 or 2 specific local keywords with their volume numbers]. Every one of those searches is a customer waiting to be found. That is where new revenue actually comes from.'\n   - THIRD: NATIONAL tier (long-term reach). Sample framing: 'And then there is the long-horizon layer, the broader national terms (mention 1-2 examples). As authority builds, this is where scale shows up. We do not chase this yet, but we are positioning to capture it.'\n   If the LOCAL tier is empty, frame it as 'this is exactly the gap we will close in the first 90 days'. If NATIONAL is empty, frame it as 'we will revisit national reach once the local foundation is solid'. Always use actual numbers from the data block, never invented ones. Always lead with brand-vs-true-intent contrast on any keyword slide; this is the single most important narrative beat.",
    "11. Output the script as plain text exactly the way it should be pasted into ElevenLabs.",
  ].join("\n");

  // Build the VERIFIED FACTS + KEYWORD TIERS block from the structured report
  // so the narration can override snapshot errors and tell the right story.
  const verifiedFactsBlock = buildVerifiedFactsBlock(context.reportData);
  const keywordTiersBlock = buildKeywordTiersBlock(context.reportData);

  const headerText = [
    `OWNER FULL NAME: ${owner}`,
    `OWNER FIRST NAME: ${ownerFirst}  (use this EVERY TIME you need [OWNER NAME/S]; this is what you call them when addressing them directly)`,
    `BUSINESS NAME: ${business}  (use this EVERY TIME you need [BUSINESS NAME]; also use it when referring to the business in slide narration)`,
    `TEAM PHRASE: ${teamPhrase}  (use this exact phrase when referring to the staff / employees / people of the business in slide narration)`,
    `CITY: ${city}  (use this to substitute [CITY])`,
    context.industry ? `INDUSTRY: ${context.industry}` : null,
    context.overallGrade ? `OVERALL GRADE: ${context.overallGrade}` : null,
    typeof context.overallScore === "number" ? `OVERALL SCORE: ${context.overallScore}` : null,
    "",
    verifiedFactsBlock,
    keywordTiersBlock,
    "=== DJ #2 TEMPLATE (follow this structure exactly) ===",
    template,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const userContent: any[] = [{ type: "text", text: headerText }];

  if (hasUsableText) {
    userContent.push({
      type: "text",
      text:
        "=== MANUS SIMPLIFIED PDF TEXT (the actual slide content to narrate) ===\n" +
        pdfText,
    });
  } else {
    userContent.push({
      type: "text",
      text: `=== MANUS SIMPLIFIED PDF SLIDES (${pageImages.length} pages, attached as images below - each image is one slide in order) ===`,
    });
    for (let i = 0; i < pageImages.length; i++) {
      userContent.push({ type: "text", text: `--- Slide ${i + 1} ---` });
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: pageImages[i],
        },
      });
    }
  }

  userContent.push({
    type: "text",
    text: "Now produce the finished ElevenLabs script. Output ONLY the script text - no preface, no explanation, no markdown code fence.",
  });

  const client = getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const out = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();

  if (!out) {
    throw new Error("Claude returned an empty narration script.");
  }

  return out
    .replace(/^```(?:text|markdown)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

/**
 * Split a finished narration script into ElevenLabs-friendly copy/paste blocks.
 *
 * Rules:
 *   - Each block is <= maxChars characters (default 5,000).
 *   - We NEVER break inside a slide. The only legal break points are the
 *     boundaries between sections (Intro / Slide 1 / Slide 2 / ... / Closing).
 *   - Sections are detected by lines starting with "### " (### Intro,
 *     ### Slide 1, ### Closing, etc.) which matches the template.
 *   - Blocks are separated by a header line so it's obvious which block
 *     corresponds to which slides.
 *   - If a single section is itself longer than maxChars, it gets its own
 *     block anyway (with a note) rather than being silently truncated.
 */
export function chunkScriptForElevenLabs(
  script: string,
  maxChars = 5000,
): string {
  const text = script.replace(/\r\n/g, "\n").trim();
  if (!text) return text;

  // Split on lines beginning with "### " while keeping the header attached
  // to the section that follows it.
  const lines = text.split("\n");
  const sections: { title: string; body: string }[] = [];
  let current: { title: string; body: string } | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current) sections.push(current);
      current = { title: line.replace(/^###\s+/, "").trim(), body: line + "\n" };
    } else if (current) {
      current.body += line + "\n";
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  // If we couldn't find any "### " headers, return the script unchanged.
  if (sections.length === 0) return text;

  // Anything before the first "### " header gets prepended to the first section
  // so we don't lose it. (Usually empty / whitespace.)
  const preambleText = preamble.join("\n").trim();
  if (preambleText) {
    sections[0].body = preambleText + "\n\n" + sections[0].body;
  }

  // Group sections into blocks <= maxChars. Each block keeps whole sections.
  type Block = { sections: { title: string; body: string }[]; chars: number };
  const blocks: Block[] = [];
  let block: Block = { sections: [], chars: 0 };

  const flush = () => {
    if (block.sections.length > 0) {
      blocks.push(block);
      block = { sections: [], chars: 0 };
    }
  };

  for (const sec of sections) {
    const secLen = sec.body.length;
    if (block.sections.length === 0) {
      // First section in a new block always goes in, even if it exceeds max.
      block.sections.push(sec);
      block.chars = secLen;
      continue;
    }
    // +1 for the newline join between sections.
    if (block.chars + 1 + secLen <= maxChars) {
      block.sections.push(sec);
      block.chars += 1 + secLen;
    } else {
      flush();
      block.sections.push(sec);
      block.chars = secLen;
    }
  }
  flush();

  // Render to plain text with clear block separators.
  const total = blocks.length;
  const rendered = blocks.map((b, i) => {
    const titles = b.sections.map((s) => s.title).join(", ");
    const oversize = b.chars > maxChars ? `  [WARNING: ${b.chars} chars - this section is longer than ${maxChars} on its own]` : "";
    const header = `========== BLOCK ${i + 1} of ${total} (${b.chars} chars) - ${titles}${oversize} ==========`;
    const body = b.sections.map((s) => s.body.trimEnd()).join("\n\n");
    return `${header}\n\n${body}`;
  });

  return rendered.join("\n\n\n");
}
