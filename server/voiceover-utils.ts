export interface ApprovedVoice {
  id: string;
  name: string;
}

export function parseApprovedVoices(raw = process.env.ELEVENLABS_APPROVED_VOICES_JSON || ""): ApprovedVoice[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ELEVENLABS_APPROVED_VOICES_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("ELEVENLABS_APPROVED_VOICES_JSON must be a JSON array.");
  const voices: ApprovedVoice[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("Each approved voice must have id and name.");
    const id = String((item as Record<string, unknown>).id || "").trim();
    const name = String((item as Record<string, unknown>).name || "").trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !name || name.length > 80) {
      throw new Error("Each approved voice needs a valid ElevenLabs voice id and a name up to 80 characters.");
    }
    if (!seen.has(id)) {
      voices.push({ id, name });
      seen.add(id);
    }
  }
  return voices;
}

/** Remove editor-only labels while preserving Eleven v3 delivery tags. */
export function prepareScriptForSpeech(script: string) {
  return script
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^={4,}\s*BLOCK\s+\d+\s+of\s+\d+/i.test(line.trim()))
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSpeechText(text: string, maxChars = 4_500) {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > maxChars) {
      push();
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (sentence.length > maxChars) {
          push();
          for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars));
        } else if (!current || current.length + 1 + sentence.length <= maxChars) {
          current += `${current ? " " : ""}${sentence}`;
        } else {
          push();
          current = sentence;
        }
      }
      push();
    } else if (!current || current.length + 2 + paragraph.length <= maxChars) {
      current += `${current ? "\n\n" : ""}${paragraph}`;
    } else {
      push();
      current = paragraph;
    }
  }
  push();
  return chunks;
}
