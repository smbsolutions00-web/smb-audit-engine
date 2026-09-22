import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { storage } from "./storage";
import {
  parseApprovedVoices,
  prepareScriptForSpeech,
  extractSpeechBlocks,
  type ApprovedVoice,
} from "./voiceover-utils";

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const VOICEOVER_ROOT = join(DATA_DIR, "voiceovers");
const DEFAULT_MODEL = "eleven_v3";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_SCRIPT_CHARS = 200_000;

mkdirSync(VOICEOVER_ROOT, { recursive: true });
const jobsDb = new Database(join(DATA_DIR, "data.db"));
jobsDb.pragma("journal_mode = WAL");
jobsDb.exec(`
  CREATE TABLE IF NOT EXISTS voiceover_jobs (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    voice_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    output_format TEXT NOT NULL,
    status TEXT NOT NULL,
    script_hash TEXT NOT NULL,
    character_count INTEGER NOT NULL,
    estimated_credits INTEGER NOT NULL,
    segment_count INTEGER NOT NULL DEFAULT 0,
    output_path TEXT,
    error_message TEXT,
    provider_request_ids TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voiceover_jobs_audit_created
    ON voiceover_jobs(audit_id, created_at DESC);
`);

// Background work cannot survive a process restart. Make that state explicit
// instead of leaving a job stuck at "generating" forever.
jobsDb.prepare(`
  UPDATE voiceover_jobs
  SET status = 'failed',
      error_message = 'Generation was interrupted by a server restart. Please try again.',
      updated_at = ?
  WHERE status IN ('queued', 'generating')
`).run(Date.now());

export type VoiceoverStatus = "queued" | "generating" | "complete" | "failed";

export interface VoiceoverJob {
  id: string;
  auditId: string;
  requestedBy: string;
  voiceId: string;
  voiceName: string;
  modelId: string;
  outputFormat: string;
  status: VoiceoverStatus;
  characterCount: number;
  estimatedCredits: number;
  segmentCount: number;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  downloadUrl?: string;
  partDownloadUrls?: Array<{ number: number; downloadUrl: string }>;
}

interface VoiceoverRow {
  id: string;
  audit_id: string;
  requested_by: string;
  voice_id: string;
  voice_name: string;
  model_id: string;
  output_format: string;
  status: VoiceoverStatus;
  character_count: number;
  estimated_credits: number;
  segment_count: number;
  output_path: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function toPublicJob(row: VoiceoverRow): VoiceoverJob {
  const auditDir = join(VOICEOVER_ROOT, row.audit_id);
  const partDownloadUrls = row.status === "complete"
    ? Array.from({ length: row.segment_count }, (_, index) => {
        const number = index + 1;
        const path = join(auditDir, `${row.id}-block-${String(number).padStart(2, "0")}.mp3`);
        return existsSync(path)
          ? { number, downloadUrl: `/api/audits/${row.audit_id}/voiceovers/${row.id}/blocks/${number}/download` }
          : null;
      }).filter((item): item is { number: number; downloadUrl: string } => Boolean(item))
    : [];
  return {
    id: row.id,
    auditId: row.audit_id,
    requestedBy: row.requested_by,
    voiceId: row.voice_id,
    voiceName: row.voice_name,
    modelId: row.model_id,
    outputFormat: row.output_format,
    status: row.status,
    characterCount: row.character_count,
    estimatedCredits: row.estimated_credits,
    segmentCount: row.segment_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.status === "complete"
      ? { downloadUrl: `/api/audits/${row.audit_id}/voiceovers/${row.id}/download` }
      : {}),
    ...(partDownloadUrls.length ? { partDownloadUrls } : {}),
  };
}

export function getVoiceoverCapabilities() {
  const voices = parseApprovedVoices();
  return {
    configured: Boolean(process.env.ELEVENLABS_API_KEY && voices.length),
    voices,
    modelId: process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL,
    outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT,
    maxScriptCharacters: MAX_SCRIPT_CHARS,
    creditEstimateNote: "Estimate uses one credit per submitted character; actual plan billing may differ.",
  };
}

function getJobRow(auditId: string, jobId: string) {
  return jobsDb.prepare("SELECT * FROM voiceover_jobs WHERE audit_id = ? AND id = ?")
    .get(auditId, jobId) as VoiceoverRow | undefined;
}

export function getVoiceoverJob(auditId: string, jobId: string) {
  const row = getJobRow(auditId, jobId);
  return row ? toPublicJob(row) : null;
}

export function listVoiceoverJobs(auditId: string) {
  return (jobsDb.prepare("SELECT * FROM voiceover_jobs WHERE audit_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(auditId) as VoiceoverRow[]).map(toPublicJob);
}

function updateJob(jobId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  jobsDb.prepare(`UPDATE voiceover_jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((key) => patch[key]), Date.now(), jobId);
}

function stripId3(buffer: Buffer) {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString("ascii") !== "ID3") return buffer;
  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  return buffer.subarray(Math.min(buffer.length, 10 + size));
}

async function requestSpeech(text: string, voiceId: string, modelId: string, outputFormat: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ElevenLabs is not configured.");
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`);
  url.searchParams.set("output_format", outputFormat);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({ text, model_id: modelId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const json = await response.json() as { detail?: { message?: string } | string };
      detail = typeof json.detail === "string" ? json.detail : json.detail?.message || "";
    } catch { /* use the stable status-only error below */ }
    throw new Error(detail || `ElevenLabs returned HTTP ${response.status}.`);
  }
  const requestId = response.headers.get("request-id") || response.headers.get("x-request-id");
  return { audio: Buffer.from(await response.arrayBuffer()), requestId };
}

async function runGeneration(jobId: string, auditId: string, text: string, voice: ApprovedVoice) {
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT;
  try {
    updateJob(jobId, { status: "generating", error_message: null });
    // Keep the editor's <=5,000-character block boundaries intact so EJ gets
    // separate CapCut-ready audio files in the same order as the script.
    const chunks = extractSpeechBlocks(text);
    const audioParts: Buffer[] = [];
    const requestIds: string[] = [];
    const auditDir = join(VOICEOVER_ROOT, auditId);
    mkdirSync(auditDir, { recursive: true });
    for (let i = 0; i < chunks.length; i += 1) {
      const result = await requestSpeech(chunks[i], voice.id, modelId, outputFormat);
      const blockPath = join(auditDir, `${jobId}-block-${String(i + 1).padStart(2, "0")}.mp3`);
      await writeFile(blockPath, result.audio, { mode: 0o600 });
      audioParts.push(i === 0 ? result.audio : stripId3(result.audio));
      if (result.requestId) requestIds.push(result.requestId);
    }
    const finalPath = join(auditDir, `${jobId}.mp3`);
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, Buffer.concat(audioParts), { mode: 0o600 });
    await rename(tempPath, finalPath);
    updateJob(jobId, {
      status: "complete",
      output_path: finalPath,
      segment_count: chunks.length,
      provider_request_ids: JSON.stringify(requestIds),
    });
    await storage.appendEvent(auditId, "voiceover_generated", {
      jobId,
      voiceName: voice.name,
      chars: text.length,
      segments: chunks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Voiceover generation failed.";
    updateJob(jobId, { status: "failed", error_message: message });
    await storage.appendEvent(auditId, "voiceover_failed", { jobId, message });
    console.error(`[voiceover] job ${jobId} failed: ${message}`);
  }
}

export async function createVoiceoverJob(opts: {
  auditId: string;
  requestedBy: string;
  voiceId: string;
  script: string;
}) {
  const capabilities = getVoiceoverCapabilities();
  if (!capabilities.configured) throw new Error("ElevenLabs is not configured with an API key and approved voices.");
  const voice = capabilities.voices.find((candidate) => candidate.id === opts.voiceId);
  if (!voice) throw new Error("That voice is not on the approved voice list.");
  const speechText = prepareScriptForSpeech(opts.script);
  if (!speechText) throw new Error("The narration script is empty.");
  if (speechText.length > MAX_SCRIPT_CHARS) throw new Error(`Narration is too long (max ${MAX_SCRIPT_CHARS.toLocaleString()} characters).`);
  const id = randomUUID();
  const now = Date.now();
  jobsDb.prepare(`
    INSERT INTO voiceover_jobs (
      id, audit_id, requested_by, voice_id, voice_name, model_id, output_format,
      status, script_hash, character_count, estimated_credits, segment_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)
  `).run(
    id, opts.auditId, opts.requestedBy, voice.id, voice.name,
    capabilities.modelId, capabilities.outputFormat,
    createHash("sha256").update(speechText).digest("hex"), speechText.length, speechText.length, now, now,
  );
  await storage.appendEvent(opts.auditId, "voiceover_requested", {
    jobId: id,
    voiceName: voice.name,
    chars: speechText.length,
  });
  void runGeneration(id, opts.auditId, opts.script, voice);
  return getVoiceoverJob(opts.auditId, id)!;
}

export function getVoiceoverFile(auditId: string, jobId: string) {
  const row = getJobRow(auditId, jobId);
  if (!row || row.status !== "complete" || !row.output_path || !existsSync(row.output_path)) return null;
  const root = `${resolve(VOICEOVER_ROOT)}${process.platform === "win32" ? "\\" : "/"}`;
  const resolved = resolve(row.output_path);
  if (!resolved.startsWith(root)) return null;
  return {
    stream: createReadStream(resolved),
    filename: basename(`${row.voice_name}-${auditId}.mp3`).replace(/[^a-zA-Z0-9._-]/g, "-"),
  };
}

export function getVoiceoverBlockFile(auditId: string, jobId: string, blockNumber: number) {
  const row = getJobRow(auditId, jobId);
  if (!row || row.status !== "complete" || !Number.isInteger(blockNumber) || blockNumber < 1 || blockNumber > row.segment_count) return null;
  const auditDir = join(VOICEOVER_ROOT, auditId);
  const blockPath = resolve(join(auditDir, `${jobId}-block-${String(blockNumber).padStart(2, "0")}.mp3`));
  const root = `${resolve(auditDir)}${process.platform === "win32" ? "\\" : "/"}`;
  if (!blockPath.startsWith(root) || !existsSync(blockPath)) return null;
  return {
    stream: createReadStream(blockPath),
    filename: basename(`${row.voice_name}-${auditId}-block-${String(blockNumber).padStart(2, "0")}.mp3`).replace(/[^a-zA-Z0-9._-]/g, "-"),
  };
}
