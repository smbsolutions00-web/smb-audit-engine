import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const voiceovers = await import("../server/voiceover-utils");

test("approved voices are parsed and deduplicated", () => {
  const voices = voiceovers.parseApprovedVoices(JSON.stringify([
    { id: "voice_123456", name: "DJ-3" },
    { id: "voice_123456", name: "Duplicate" },
    { id: "voice_abcdef", name: "EJ Approved" },
  ]));
  assert.deepEqual(voices, [
    { id: "voice_123456", name: "DJ-3" },
    { id: "voice_abcdef", name: "EJ Approved" },
  ]);
});

test("script preparation removes editor labels and preserves v3 delivery tags", () => {
  const prepared = voiceovers.prepareScriptForSpeech(`========== BLOCK 1 of 1 (100 chars) - Intro ==========\n\n### Intro\n[warmly]\nHello, EJ.\n\n[pause]\nWelcome.`);
  assert.equal(prepared, "[warmly]\nHello, EJ.\n\n[pause]\nWelcome.");
});

test("speech chunks remain within the API safety limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `Sentence ${i} explains an audit finding clearly.`).join(" ");
  const chunks = voiceovers.splitSpeechText(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});
