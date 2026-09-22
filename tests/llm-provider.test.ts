import assert from "node:assert/strict";
import test from "node:test";
import { configuredLLMProvider, isLLMAvailable } from "../server/llm-provider";

const ORIGINAL_ENV = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.afterEach(restoreEnv);

test("OpenAI is preferred when both provider keys are configured", () => {
  delete process.env.LLM_PROVIDER;
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";

  assert.equal(configuredLLMProvider(), "openai");
  assert.equal(isLLMAvailable(), true);
});

test("an explicit provider requires its matching key", () => {
  process.env.LLM_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic";

  assert.equal(configuredLLMProvider(), null);
  assert.equal(isLLMAvailable(), false);
});

test("Anthropic remains available as an optional fallback", () => {
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic";

  assert.equal(configuredLLMProvider(), "anthropic");
});
