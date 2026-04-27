/**
 * ElevenLabs DJ #2 narration script generator.
 *
 * Workflow:
 *   1. Read the Manus simplified PDF that was uploaded for an audit.
 *   2. Extract its text and split into slide-shaped chunks.
 *   3. Ask Claude to fill the DJ #2 faith-based template with slide-by-slide
 *      narration (block-by-block, voice direction in [brackets], SSML <break/>
 *      tags) so the output can be pasted directly into ElevenLabs.
 *
 * The template lives at templates/elevenlabs-dj2-narration-template.txt.
 * Per the user's spec: each block must stay under 5,000 characters,
 * placeholders [OWNER NAME/S] and [BUSINESS NAME] get filled from the audit,
 * and the prayer + DJ intro + closing prayer must be preserved verbatim
 * from the template.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePdfBuffer } from "./audit-engine";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* Resolve template path. We try a few locations because in the bundled
   production build (esbuild → dist/index.cjs) __dirname points at /opt/render
   while the templates ship at the repo root. */
function resolveTemplatePath(): string | null {
  const candidates = [
    process.env.ELEVENLABS_TEMPLATE_PATH,
    join(process.cwd(), "templates", "elevenlabs-dj2-narration-template.txt"),
    join(process.cwd(), "..", "templates", "elevenlabs-dj2-narration-template.txt"),
    "/app/templates/elevenlabs-dj2-narration-template.txt",
    "/opt/render/project/src/templates/elevenlabs-dj2-narration-template.txt",
  ].filter(Boolean) as string[];

  // Also try resolving relative to this module file (CJS or ESM)
  try {
    // @ts-ignore — __dirname exists in CJS bundle
    if (typeof __dirname !== "undefined") {
      candidates.push(join(__dirname, "..", "templates", "elevenlabs-dj2-narration-template.txt"));
      candidates.push(join(__dirname, "templates", "elevenlabs-dj2-narration-template.txt"));
    }
  } catch {
    /* ignore */
  }
  try {
    // @ts-ignore — import.meta exists in ESM
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

/* Trim and normalize PDF text so we don't blow the prompt budget on blank
   lines / headers / footers. */
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

/**
 * Generate the full ElevenLabs DJ #2 narration script for an uploaded
 * Manus PDF. Returns the plain-text script ready to paste into ElevenLabs.
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
  if (!pdfText || pdfText.length < 50) {
    throw new Error(
      "Could not extract text from the Manus PDF. The file may be image-only — re-export it as a text PDF and try again.",
    );
  }

  const template = loadTemplate();

  const owner = context.ownerName?.trim() || context.businessName || "the owner";
  const business = context.businessName?.trim() || "the business";

  const system = [
    "You are writing a finished ElevenLabs narration script. Your output goes straight into ElevenLabs — no preamble, no commentary, no markdown fences.",
    "You are voicing 'DJ #2', the AI personal assistant working alongside Dwayne Johnson, CEO of SMB Solutions. Voice: warm, conversational, confident, plain-English with light faith-based touches.",
    "ABSOLUTE RULES:",
    "1. Follow the supplied DJ #2 template structure exactly. Keep all section headers (### Slide N, ***).",
    "2. The Opening prayer + DJ intro section and the Closing prayer + warm closing must be reproduced VERBATIM from the template, with only [OWNER NAME/S] and [BUSINESS NAME] substituted.",
    "3. For each slide, replace the bracketed instruction lines with actual narration. Keep voice-direction tags like [warmly, conversational] on their own line above the spoken text.",
    "4. Use SSML <break time=\"0.5s\" /> or <break time=\"1.0s\" /> sparingly to pace key transitions. Never invent other SSML tags.",
    "5. Each slide section must stay under 5,000 characters of TOTAL text including voice-direction tags. Aim for 600–1,200 characters per slide.",
    "6. Match the slide count to what is actually in the PDF. If the PDF has fewer than 10 slides, only produce that many slide sections. If more than 10, continue the same pattern (### Slide 11, etc.).",
    "7. Ground every slide narration in the actual slide content from the Manus PDF text below. Do not invent grades, scores, or numbers that aren't present.",
    "8. Plain English only — explain anything technical with one short analogy.",
    "9. Output the script as plain text exactly the way it should be pasted into ElevenLabs.",
  ].join("\n");

  const userPrompt = [
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
    "=== MANUS SIMPLIFIED PDF TEXT (the actual slide content to narrate) ===",
    pdfText,
    "",
    "Now produce the finished ElevenLabs script. Output ONLY the script text — no preface, no explanation, no markdown code fence.",
  ]
    .filter(Boolean)
    .join("\n");

  const client = getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const out = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();

  if (!out) {
    throw new Error("Claude returned an empty narration script.");
  }

  // Strip any accidental markdown fences
  return out
    .replace(/^```(?:text|markdown)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}
