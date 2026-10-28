import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { DEFAULTS } from "../src/config.ts";
import {
  buildInstructions, checkpointProblem, describeContext, effectiveThinking, formatDuration, formatTokens, outputBudget,
  readRunRecord, reducedThinking, safeError, safeLabel, sizingAdvice,
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
  assert.throws(() => outputBudget(context, { ...fast, contextWindow: 3000 }, { ...DEFAULTS }), /context window \(3\.0K\) is too small/u);
  assert.throws(() => outputBudget(context, { ...fast, maxTokens: 1024 }, { ...DEFAULTS }), /output limit \(1\.0K tokens\) is below/u);
});
test("unknown limits (0, e.g. virtual models) are not enforced", () => {
  const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
  assert.equal(outputBudget(context, { ...fast, contextWindow: 0, maxTokens: 0 }, { ...DEFAULTS }), 16384);
  assert.equal(outputBudget(context, { ...fast, contextWindow: 0, maxTokens: 4096 }, { ...DEFAULTS }), 4096);
  assert.equal(describeContext(0), "unknown context size");
  assert.equal(describeContext(200000), "200K context");
});
test("checkpoints must be non-empty and structured or substantial; refusals are rejected", () => {
  assert.match(checkpointProblem("")!, /empty/u);
  assert.match(checkpointProblem("\n\n<read-files>\nsrc/a.ts\n</read-files>")!, /empty/u);
  assert.match(checkpointProblem("I'm sorry, but I can't help with that.")!, /unstructured.*refused/u);
  assert.equal(checkpointProblem("## Goal\nShip it.\n\n<modified-files>\nsrc/a.ts\n</modified-files>"), undefined);
  assert.equal(checkpointProblem("  ### Progress\n- done"), undefined);
  assert.equal(checkpointProblem(`Goal: ${"a long unstructured but substantial summary ".repeat(12)}`), undefined);
});
test("the condensed retry never thinks harder than low, respecting the model's floor", () => {
  assert.equal(reducedThinking(fast, "high"), "low");
  assert.equal(reducedThinking(fast, "max"), "low");
  assert.equal(reducedThinking(fast, "low"), "low");
  assert.equal(reducedThinking(fast, "off"), "off");
  const floor = { ...fast, thinkingLevelMap: { off: null, minimal: null, low: null } };
  assert.equal(reducedThinking(floor, "high"), "medium");
  assert.equal(reducedThinking(floor, "medium"), "medium");
});
test("sizing advice flags caps that cannot hold the target", () => {
  assert.equal(sizingAdvice({ ...DEFAULTS }), undefined);
  assert.equal(sizingAdvice({ ...DEFAULTS, thinking: "high" }), undefined);
  assert.match(sizingAdvice({ ...DEFAULTS, targetWords: 20000 })!, /30K output tokens plus up to 1\.0K for low thinking.*cap is 16K/u);
  assert.match(sizingAdvice({ ...DEFAULTS, maxOutputTokens: 4096 })!, /cap is 4\.1K/u);
  assert.match(sizingAdvice({ ...DEFAULTS, maxOutputTokens: 8192, thinking: "max" })!, /16K for max thinking/u);
  assert.equal(sizingAdvice({ ...DEFAULTS, maxOutputTokens: 8192, thinking: "max" }, "off"), undefined, "a non-reasoning model does not think");
  assert.equal(sizingAdvice({ ...DEFAULTS, targetWords: 0, maxOutputTokens: 2048 }), undefined, "no target, no estimate");
});
test("durations and token counts are formatted compactly", () => {
  assert.equal(formatDuration(125000), "2m05s");
  assert.equal(formatDuration(-10), "0s");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(4100), "4.1K");
  assert.equal(formatTokens(9999), "10K");
  assert.equal(formatTokens(262144), "262K");
  assert.equal(formatTokens(1000000), "1M");
  assert.equal(formatTokens(1048576), "1M");
  assert.equal(formatTokens(1500000), "1.5M");
  assert.equal(formatTokens(Number.NaN), "?");
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
  const emoji = safeError("🚀".repeat(300));
  assert.equal(Array.from(emoji).length, 240);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(emoji), "no lone surrogate");
});
test("persisted records are validated and sanitized before display", () => {
  const valid = { version: 1, route: "fast", outcome: "success", model: "p/m\x1b[31m", thinking: "low", reason: "manual", durationMs: 5, timestamp: "2026-01-01T00:00:00.000Z", targetWords: 3000, outputTokens: 40 };
  assert.equal(readRunRecord(valid)?.model, "p/m[31m");
  assert.equal(readRunRecord({ ...valid, servedModel: { nested: true } }), undefined);
  assert.equal(readRunRecord({ ...valid, outputTokens: -1 }), undefined);
  assert.equal(readRunRecord({ ...valid, route: "elsewhere" }), undefined);
  assert.equal(readRunRecord({ ...valid, durationMs: Number.NaN }), undefined);
  assert.equal(readRunRecord(null), undefined);
  assert.equal(readRunRecord({ ...valid, compactionId: "cmp-1\x1b[2J" })?.compactionId, "cmp-1[2J");
  assert.equal(readRunRecord({ ...valid, compactionId: 7 }), undefined);
});
