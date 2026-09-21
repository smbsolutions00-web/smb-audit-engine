import test from "node:test";
import assert from "node:assert/strict";
import { validateAuthConfiguration } from "../server/auth-config";

test("production refuses to start with authentication disabled", () => {
  assert.throws(
    () => validateAuthConfiguration({ NODE_ENV: "production", AUTH_ENABLED: "false" }),
    /Refusing to start production/,
  );
});

test("enabled authentication requires a strong session secret", () => {
  assert.throws(
    () => validateAuthConfiguration({ NODE_ENV: "development", AUTH_ENABLED: "true", SESSION_SECRET: "short" }),
    /at least 32 characters/,
  );
});

test("valid production authentication configuration passes", () => {
  const result = validateAuthConfiguration({
    NODE_ENV: "production",
    AUTH_ENABLED: "true",
    SESSION_SECRET: "x".repeat(48),
  });
  assert.equal(result.enabled, true);
  assert.equal(result.secret.length, 48);
});
