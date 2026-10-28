import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { DEFAULTS } from "../src/config.ts";
import {
  buildInstructions, effectiveThinking, formatDuration, formatTokens, outputBudget, readRunRecord, safeError, safeLabel,
} from "../src/summary.ts";
import { event, fast } from "./helpers.ts";

test("prompt sets a soft target, preserves exact details and user focus", () => {
  const text = buildInstructions({ ...DEFAULTS }, event().preparation, "Preserve the database migration.");
  for (const phrase of ["3000 words", "SOFT", "exact relevant paths", "obsolete", "programmatically", "database migration"]) assert.ok(text.includes(phrase), phrase);
  assert.doesNotMatch(text, /previous attempt exceeded/u);
});
test("condensed retry is firmer but keeps critical-detail requirements", () => {
  const text = buildInstructions({ ...DEFAULTS }, event().preparation, undefined, true);
  assert.match(text, /previous attempt exceeded the output limit/u);
  assert.match(text, /3000 words/u);
  assert.match(text, /exact critical identifiers/u);
  assert.doesNotMatch(text, /SOFT/u);
  assert.match(buildInstructions({ ...DEFAULTS, targetWords: 0 }, event().preparation, undefined, true), /4000 words/u);
});
test("split-turn requests share the prose target rather than doubling it", () => {
  const p = event().preparation;
  p.isSplitTurn = true;
  assert.match(buildInstructions({ ...DEFAULTS }, p), /1500 words/u);
  p.messagesToSummarize = [];
  assert.match(buildInstructions({ ...DEFAULTS }, p), /3000 words/u);
});
test("disabled target still asks for a concise continuation checkpoint", () => {
  assert.doesNotMatch(buildInstructions({ ...DEFAULTS, targetWords: 0 }, event().preparation), /\d+ words/u);
});
test("thinking is clamped to model capabilities", () => {
  assert.equal(effectiveThinking({ ...fast, reasoning: false }, "max"), "off");
  assert.equal(effectiveThinking(fast, "low"), "low");
  assert.equal(effectiveThinking({ ...fast, thinkingLevelMap: { off: null, minimal: null } }, "off"), "low");
});
test("output cap respects configuration, model cap and available context", () => {
  const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
  assert.equal(outputBudget(context, fast, { ...DEFAULTS }), 16384);
  assert.equal(outputBudget(context, { ...fast, maxTokens: 4096 }, { ...DEFAULTS }), 4096);
  assert.throws(() => outputBudget(context, { ...fast, contextWindow: 3000 }, { ...DEFAULTS }), /too small/u);
});
test("durations and token counts are formatted compactly", () => {
  assert.equal(formatDuration(125000), "2m05s");
  assert.equal(formatDuration(-10), "0s");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(4100), "4.1K");
  assert.equal(formatTokens(1000000), "1000K");
});
test("labels strip control, bidi-override and zero-width characters without splitting emoji", () => {
  assert.doesNotMatch(safeLabel("hello\n\x1b]0;evil\x07"), /[\n\x1b\x07]/u);
  assert.equal(safeLabel("abc\u202Eevil\u200Bx\uFEFF"), "abcevilx");
  const label = safeLabel("🚀".repeat(70));
  assert.equal(Array.from(label).length, 64);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(label), "no lone surrogate");
});
test("errors redact common credential forms", () => {
  const raw = [
    "Bearer abc.def-ghi", "https://x.test/v1?key=AIzaSyA1234567890123456789012&alt=sse", "x-api-key: secretvalue1",
    '"api_key":"abcdef123456"', "sk-ant-api03-ABCDEFGH12345678", "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePart",
  ].join(" | ");
  const text = safeError(new Error(raw));
  for (const secret of ["abc.def-ghi", "AIzaSyA", "secretvalue1", "abcdef123456", "sk-ant-api03", "ghp_abc", "eyJhbGci"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(safeError("x".repeat(1000)).length <= 240);
});
test("persisted records are validated and sanitized before display", () => {
  const valid = { version: 1, route: "fast", outcome: "success", model: "p/m\x1b[31m", thinking: "low", reason: "manual", durationMs: 5, timestamp: "2026-01-01T00:00:00.000Z", targetWords: 3000, outputTokens: 40 };
  assert.equal(readRunRecord(valid)?.model, "p/m[31m");
  assert.equal(readRunRecord({ ...valid, servedModel: { nested: true } }), undefined);
  assert.equal(readRunRecord({ ...valid, outputTokens: -1 }), undefined);
  assert.equal(readRunRecord({ ...valid, route: "elsewhere" }), undefined);
  assert.equal(readRunRecord({ ...valid, durationMs: Number.NaN }), undefined);
  assert.equal(readRunRecord(null), undefined);
});
