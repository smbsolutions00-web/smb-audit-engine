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
}

/**
 * Pull a clean first name out of whatever the intake form gave us.
 * Handles things like:
 *   "Tawana Bell"            -> "Tawana"
 *   "Dr. Sarah Johnson"      -> "Sarah"
 *   "Michelle Wolff, LCSW"   -> "Michelle"
 *   "Aina Marie Brooks"      -> "Aina"
 *   "aina"                   -> "Aina"
 *   ""                       -> ""
 * If we can't find anything sensible we return the trimmed original.
 */
export function firstNameOf(fullName: string | undefined | null): string {
  if (!fullName) return "";
  // Drop trailing credentials after a comma (", MD", ", LCSW", ", PhD")
  let s = fullName.split(",")[0].trim();
  // Strip common leading honorifics
  s = s.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|miss|pastor|rev\.?|prof\.?)\s+/i, "").trim();
  if (!s) return fullName.trim();
  const first = s.split(/\s+/)[0] || s;
  // Capitalize first letter, keep the rest as written (handles "DaKota", "McKenna").
  return first.charAt(0).toUpperCase() + first.slice(1);
}

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
    "9. Output the script as plain text exactly the way it should be pasted into ElevenLabs.",
  ].join("\n");

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
