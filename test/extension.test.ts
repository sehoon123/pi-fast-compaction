import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { DETAILS_KEY } from "../src/summary.ts";
import { event, fast, harness, main, response, usage } from "./helpers.ts";

async function success(h: ReturnType<typeof harness>, result: any) {
  const entry = { type: "compaction", id: "cmp", parentId: null, timestamp: new Date().toISOString(), ...result.compaction, fromHook: true } as CompactionEntry;
  h.entries.push(entry);
  await h.emit("session_compact", { compactionEntry: entry, fromExtension: true, reason: "manual", willRetry: false });
  return entry;
}

test("built-in compact uses selected model and low thinking, not coding-model max", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  const e = event({ customInstructions: "Keep the failing assertion." });
  const result = await h.emit("session_before_compact", e);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.model.id, fast.id);
  assert.equal(request.options?.reasoning, "low");
  assert.equal(request.options?.thinkingBudgets?.low, 1024);
  assert.equal(request.options?.maxTokens, 16384);
  assert.equal(request.model.maxTokens, 16384);
  assert.equal(fast.maxTokens, 64000);
  assert.equal(request.options?.signal, e.signal);
  assert.equal(request.options?.cacheRetention, "none");
  assert.ok(request.options?.sessionId);
  assert.match(JSON.stringify(request.context), /failing assertion/u);
  assert.equal(result.compaction.firstKeptEntryId, "kept");
  assert.equal(result.compaction.tokensBefore, 100000);
  assert.deepEqual(result.compaction.usage, usage);
  assert.deepEqual(result.compaction.details.readFiles, ["src/a.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["src/b.ts"]);
  assert.equal(h.ctx.model?.id, main.id);
  assert.equal(h.ctx.thinkingLevel, "max");
  h.setTime(13000);
  await success(h, result);
  assert.match(h.statuses.at(-1)!, /last 12s/u);
  assert.equal((h.entries.at(-1) as any).data.durationMs, 12000);
});

test("split-turn compaction preserves previous summary, both parts, file lists and combined usage", async (t) => {
  const h = harness(t);
  const e = event();
  e.preparation.previousSummary = "Old checkpoint.";
  e.preparation.isSplitTurn = true;
  e.preparation.turnPrefixMessages = [{ role: "user", content: "Current request: continue patching.", timestamp: 2 }];
  const result = await h.emit("session_before_compact", e);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[0].context), /Old checkpoint/u);
  assert.match(JSON.stringify(h.requests[1].context), /Current request/u);
  assert.match(JSON.stringify(h.requests[0].context), /1500 words/u);
  assert.match(result.compaction.summary, /Turn Context/u);
  assert.equal(result.compaction.usage.output, usage.output * 2);
});

test("file tracking survives repeated extension compactions and native/off compaction", async (t) => {
  const h = harness(t);
  const first = await h.emit("session_before_compact", event());
  const entry = await success(h, first);
  const next = event({ branchEntries: [entry] });
  next.preparation.fileOps = { read: new Set(["src/new.ts"]), edited: new Set(), written: new Set() };
  const second = await h.emit("session_before_compact", next);
  assert.deepEqual(second.compaction.details.readFiles, ["src/a.ts", "src/new.ts"]);
  assert.deepEqual(second.compaction.details.modifiedFiles, ["src/b.ts"]);
  const secondEntry = await success(h, second);
  h.store.update({ enabled: false });
  const native = event({ branchEntries: [secondEntry] });
  native.preparation.fileOps = { read: new Set(), edited: new Set(), written: new Set() };
  assert.equal(await h.emit("session_before_compact", native), undefined);
  assert.ok(native.preparation.fileOps.edited.has("src/b.ts"));
  assert.ok(native.preparation.fileOps.read.has("src/new.ts"));
});

for (const reason of ["manual", "threshold", "overflow"] as const) {
  test(`selected model handles ${reason} compaction`, async (t) => {
    const h = harness(t);
    const result = await h.emit("session_before_compact", event({ reason, willRetry: reason === "overflow" }));
    assert.ok(result.compaction);
  });
}

test("off means native compaction, not cancellation; auto-only skips manual", async (t) => {
  const h = harness(t);
  h.store.update({ enabled: false });
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.equal(h.requests.length, 0);
  h.store.update({ enabled: true, scope: "auto" });
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.ok((await h.emit("session_before_compact", event({ reason: "threshold" }))).compaction);
});

for (const kind of ["error", "length", "empty", "tool", "pending", "deferred"] as const) {
  test(`${kind} response is never accepted as a checkpoint and falls back`, async (t) => {
    const h = harness(t);
    h.setResponse(kind === "empty" ? response({ content: [] })
      : kind === "tool" ? response({ content: [{ type: "toolCall", id: "bad", name: "bash", arguments: {} }], stopReason: "toolUse" })
      : response({ stopReason: kind, errorMessage: "fixture failure" }));
    assert.equal(await h.emit("session_before_compact", event()), undefined);
    assert.match(h.notifications.at(-1)!.text, /falling back/u);
    assert.match(h.statuses.at(-1)!, /fallback/u);
  });
}

test("fallback disabled cancels rather than saving bad context", async (t) => {
  const h = harness(t);
  h.store.update({ fallback: false });
  h.setResponse(response({ stopReason: "length" }));
  assert.deepEqual(await h.emit("session_before_compact", event()), { cancel: true });
  assert.doesNotMatch(h.notifications.at(-1)!.text, /falling back/u);
});

test("a missing model and a too-small model fall back without dropping input", async (t) => {
  const h = harness(t);
  h.store.update({ model: "missing/haiku" });
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  h.store.update({ model: "fixture/haiku-test" });
  h.models[0] = { ...fast, contextWindow: 3000 };
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.equal(h.requests.length, 0);
});

test("aborts never trigger a main-model fallback", async (t) => {
  const h = harness(t);
  h.setResponse(response({ stopReason: "aborted" }));
  assert.deepEqual(await h.emit("session_before_compact", event()), { cancel: true });
  assert.equal(h.notifications.length, 0);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await h.emit("session_before_compact", event({ signal: controller.signal })), { cancel: true });
  assert.equal(h.requests.length, 1);
  await h.emit("session_compact_failed", { aborted: true });
  assert.match(h.statuses.at(-1)!, /cancelled/u);
});

test("off thinking uses Pi's no-reasoning option; nonreasoning models work", async (t) => {
  const h = harness(t);
  h.store.update({ thinking: "off" });
  await h.emit("session_before_compact", event());
  assert.equal(h.requests.at(-1)?.options?.reasoning, undefined);
  h.models[0] = { ...fast, reasoning: false };
  h.store.update({ thinking: "max" });
  const result = await h.emit("session_before_compact", event());
  assert.equal(result.compaction.details[DETAILS_KEY].thinking, "off");
});

test("commands validate and persist changes, keep model ID slashes and do not alter coding model", async (t) => {
  const h = harness(t);
  h.models.push({ ...fast, id: "vendor/model" });
  for (const command of ["model fixture/vendor/model", "thinking off", "words 4000", "tokens 20000", "scope auto", "fallback off", "bar off", "off"]) await h.command(command);
  assert.deepEqual(h.store.load(), { version: 1, enabled: false, model: "fixture/vendor/model", thinking: "off", targetWords: 4000, maxOutputTokens: 20000, scope: "auto", fallback: false, showStatus: false });
  const before = h.store.load();
  for (const bad of ["thinking invalid", "words 3", "tokens -1", "scope invalid", "model missing/model", "off junk"]) await h.command(bad);
  assert.deepEqual(h.store.load(), before);
  assert.equal(h.ctx.model?.id, main.id);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /global|Settings:/u);
});

test("main command is a one-shot override and clears even if nothing can be compacted", async (t) => {
  const h = harness(t);
  await h.command("main Preserve exact errors.");
  assert.equal(h.getCompactOptions()?.customInstructions, "Preserve exact errors.");
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  h.getCompactOptions()?.onComplete?.({ summary: "native", firstKeptEntryId: "kept", tokensBefore: 10 });
  assert.ok((await h.emit("session_before_compact", event())).compaction);
  await h.emit("session_compact_failed", { aborted: true });
  await h.command("main");
  h.getCompactOptions()?.onError?.(new Error("Nothing to compact"));
  assert.ok((await h.emit("session_before_compact", event())).compaction);
  assert.equal(h.store.load().model, "fixture/haiku-test");
});

test("invalid config uses native behavior, displays an error, and is not overwritten", async (t) => {
  const h = harness(t);
  writeFileSync(h.store.path, "{malformed");
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /settings error/u);
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  await h.command("on");
  assert.throws(() => h.store.load());
});

test("last result restores on reload, hides on request, and clears on shutdown", async (t) => {
  const h = harness(t);
  const result = await h.emit("session_before_compact", event());
  h.setTime(31000);
  await success(h, result);
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /last 30s/u);
  await h.command("bar off");
  assert.equal(h.statuses.at(-1), undefined);
  await h.command("bar on");
  await h.emit("session_shutdown");
  assert.equal(h.statuses.at(-1), undefined);
});

test("elapsed status refreshes each second and stops after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(t);
  const result = await h.emit("session_before_compact", event());
  h.setTime(6000);
  t.mock.timers.tick(1000);
  assert.match(h.statuses.at(-1)!, /compacting 5s/u);
  await success(h, result);
  const count = h.statuses.length;
  t.mock.timers.tick(5000);
  assert.equal(h.statuses.length, count);
});

test("print mode can compact without terminal-only UI", async (t) => {
  const h = harness(t);
  (h.ctx as any).mode = "print";
  (h.ctx as any).hasUI = false;
  assert.ok((await h.emit("session_before_compact", event())).compaction);
  assert.equal(h.statuses.length, 0);
  await h.command("");
  assert.match(h.notifications.at(-1)!.text, /Compaction controls/u);
});
