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
 * The opening prayer + DJ intro and the warm closing
 * are reproduced verbatim with only [OWNER NAME/S] and [BUSINESS NAME]
 * substituted.
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
  const business = context.businessName?.trim() || "the business";

  const system = [
    "You are writing a finished ElevenLabs narration script. Your output goes straight into ElevenLabs - no preamble, no commentary, no markdown fences.",
    "You are voicing 'DJ #2', the AI personal assistant working alongside Dwayne Johnson, CEO of SMB Solutions. Voice: warm, conversational, confident, plain-English with light faith-based touches.",
    "ABSOLUTE RULES:",
    "1. Follow the supplied DJ #2 template structure exactly. Keep all section headers (### Slide N, ***).",
    "2. The Opening prayer + DJ intro section and the warm closing must be reproduced VERBATIM from the template, with only [OWNER NAME/S] and [BUSINESS NAME] substituted. Do NOT add a closing prayer — the template intentionally has only one prayer at the opening.",
    "3. For each slide, replace the bracketed instruction lines with actual narration. Keep voice-direction tags like [warmly, conversational] on their own line above the spoken text.",
    "4. Use SSML <break time=\"0.5s\" /> or <break time=\"1.0s\" /> sparingly to pace key transitions. Never invent other SSML tags.",
    "5. Each slide section must stay under 5,000 characters of TOTAL text including voice-direction tags. Aim for 600-1,200 characters per slide.",
    "6. Produce one ### Slide N section for each slide / page provided. If you receive 12 slides, produce slides 1-12. If you receive 8, produce slides 1-8.",
    "7. Ground every slide narration in the actual content visible on that slide. Do not invent grades, scores, or numbers that aren't present.",
    "8. Plain English only - explain anything technical with one short analogy.",
    "9. Output the script as plain text exactly the way it should be pasted into ElevenLabs.",
  ].join("\n");

  const headerText = [
    `OWNER NAME: ${owner}`,
    `BUSINESS NAME: ${business}`,
    context.industry ? `INDUSTRY: ${context.industry}` : null,
    context.location ? `LOCATION: ${context.location}` : null,
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
