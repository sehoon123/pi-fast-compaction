import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { DEFAULTS } from "../src/config.ts";
import { buildInstructions, effectiveThinking, formatDuration, outputBudget, safeLabel } from "../src/summary.ts";
import { event, fast } from "./helpers.ts";

test("prompt sets a soft target, preserves exact details and user focus", () => {
  const text = buildInstructions({ ...DEFAULTS }, event().preparation, "Preserve the database migration.");
  for (const phrase of ["3000 words", "SOFT", "exact relevant paths", "obsolete", "programmatically", "database migration"]) assert.ok(text.includes(phrase), phrase);
});
test("split-turn requests share the prose target rather than doubling it", () => {
  const p = event().preparation;
  p.isSplitTurn = true;
  assert.match(buildInstructions({ ...DEFAULTS }, p), /1500 words/u);
  p.messagesToSummarize = [];
  assert.match(buildInstructions({ ...DEFAULTS }, p), /3000 words/u);
});
test("disabled target still asks for a concise continuation checkpoint", () => {
  assert.doesNotMatch(buildInstructions({ ...DEFAULTS, targetWords: 0 }, event().preparation), /0 words/u);
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
test("status formatting removes controls and formats elapsed time", () => {
  assert.equal(formatDuration(125000), "2m05s");
  assert.equal(formatDuration(-10), "0s");
  assert.doesNotMatch(safeLabel("hello\n\x1b]0;evil\x07"), /[\n\x1b\x07]/u);
});
