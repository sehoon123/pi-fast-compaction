import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULTS } from "../src/config.ts";
import { DETAILS_KEY } from "../src/summary.ts";
import { event, fast, harness, main, response, usage } from "./helpers.ts";

type Harness = ReturnType<typeof harness>;

/** Simulates Pi appending the compaction entry and emitting session_compact. */
async function commit(h: Harness, result: any, fromExtension = true) {
  const entry = {
    type: "compaction", id: `cmp-${h.entries.length}`, parentId: null, timestamp: new Date().toISOString(),
    summary: "## Goal\nnative", firstKeptEntryId: "kept", tokensBefore: 1, ...(result?.compaction ?? {}), fromHook: fromExtension,
  } as CompactionEntry;
  h.entries.push(entry);
  await h.emit("session_compact", { compactionEntry: entry, fromExtension, reason: "manual", willRetry: false });
  return entry;
}
const custom = (h: Harness) => h.entries.filter((e) => e.type === "custom") as Extract<SessionEntry, { type: "custom" }>[];
const userMessage = (h: Harness) => h.entries.push({ type: "message", id: `m-${h.entries.length}`, parentId: null, timestamp: "", message: { role: "user", content: "next", timestamp: 1 } } as SessionEntry);

test("selected model and low thinking are used, not coding-model max", async (t) => {
  const h = harness(t);
  h.setRequestMs(12000);
  await h.emit("session_start");
  const e = event({ customInstructions: "Keep the failing assertion." });
  const result = await h.emit("session_before_compact", e);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.model.id, fast.id);
  assert.equal(request.options?.reasoning, "low");
  assert.equal(request.options?.maxTokens, 16384);
  assert.equal(request.model.maxTokens, 16384);
  assert.equal(fast.maxTokens, 64000, "registry model is not mutated");
  assert.equal(request.options?.signal, e.signal);
  assert.equal(request.options?.cacheRetention, "none");
  assert.ok(request.options?.sessionId);
  assert.match(JSON.stringify(request.context), /failing assertion/u);
  assert.equal(result.compaction.firstKeptEntryId, "kept");
  assert.equal(result.compaction.tokensBefore, 100000);
  assert.deepEqual(result.compaction.usage, usage);
  assert.deepEqual(result.compaction.details.readFiles, ["src/a.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["src/b.ts"]);
  const record = result.compaction.details[DETAILS_KEY];
  assert.equal(record.durationMs, 12000);
  assert.equal(record.outputTokens, usage.output);
  assert.equal(h.ctx.model?.id, main.id);
  assert.equal(h.ctx.thinkingLevel, "max");
  await commit(h, result);
  assert.match(h.statuses.at(-1)!, /Haiku test · low · last 12s/u);
  assert.equal(custom(h).length, 0, "fast result is embedded, not a separate entry");
  assert.equal(h.entries.at(-1)?.type, "compaction");
});

test("thinking budgets never go below Anthropic's 1024-token minimum", async (t) => {
  const h = harness(t);
  for (const level of ["minimal", "low", "medium", "high"] as const) {
    h.store.update({ thinking: level });
    await h.emit("session_before_compact", event());
    const budgets = h.requests.at(-1)?.options?.thinkingBudgets ?? {};
    assert.equal(h.requests.at(-1)?.options?.reasoning, level);
    for (const value of Object.values(budgets)) assert.ok((value as number) >= 1024);
  }
});

test("metadata never ends the branch after a compaction, preserving Pi's Already-compacted guard", async (t) => {
  const h = harness(t);
  h.store.update({ enabled: false });
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  h.setTime(9000);
  await commit(h, undefined, false);
  assert.equal(h.entries.at(-1)?.type, "compaction");
  assert.equal(custom(h).length, 0);
  assert.match(h.statuses.at(-1)!, /off · last 8s/u);
  await h.emit("turn_start");
  assert.equal(custom(h).length, 1, "flushed when a new turn starts");
  assert.equal((custom(h)[0].data as any).route, "main");
  await h.emit("before_agent_start");
  assert.equal(custom(h).length, 1, "flush is idempotent");
});

test("failure metadata is written immediately when the branch does not end in a compaction", async (t) => {
  const h = harness(t);
  userMessage(h);
  h.store.update({ enabled: false });
  await h.emit("session_before_compact", event());
  await h.emit("session_compact_failed", { aborted: false, errorMessage: "Compaction failed: boom" });
  assert.equal((custom(h).at(-1)?.data as any).outcome, "failed");
});

test("restore ignores stale results for compactions without metadata, and tree navigation drops unwritten records", async (t) => {
  const h = harness(t);
  const result = await h.emit("session_before_compact", event());
  await commit(h, result);
  userMessage(h);
  h.store.update({ enabled: false });
  await h.emit("session_before_compact", event());
  await commit(h, undefined, false);
  await h.emit("session_tree");
  assert.doesNotMatch(h.statuses.at(-1)!, /last/u, "native compaction without a record clears the display");
  await h.emit("turn_start");
  assert.equal(custom(h).length, 0, "pending record from the previous branch position is dropped");
  await h.emit("session_start");
  assert.doesNotMatch(h.statuses.at(-1)!, /last/u);
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
  const entry = await commit(h, await h.emit("session_before_compact", event()));
  const next = event({ branchEntries: [entry] });
  next.preparation.fileOps = { read: new Set(["src/new.ts"]), edited: new Set(), written: new Set() };
  const second = await h.emit("session_before_compact", next);
  assert.deepEqual(second.compaction.details.readFiles, ["src/a.ts", "src/new.ts"]);
  assert.deepEqual(second.compaction.details.modifiedFiles, ["src/b.ts"]);
  const secondEntry = await commit(h, second);
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
    assert.ok((await h.emit("session_before_compact", event({ reason, willRetry: reason === "overflow" }))).compaction);
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

test("transient provider errors retry with the fast model before any fallback", async (t) => {
  const h = harness(t);
  h.setResponse(response({ stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }), response());
  const result = await h.emit("session_before_compact", event());
  assert.ok(result.compaction);
  assert.equal(h.requests.length, 2);
  assert.ok(h.statuses.some((s) => /retry 1\/1/u.test(s ?? "")));
  assert.doesNotMatch(h.notifications.map((n) => n.text).join("\n"), /falling back/u);
});

test("non-retryable provider errors fall back without retrying", async (t) => {
  const h = harness(t);
  h.setResponse(response({ stopReason: "error", errorMessage: "401 invalid x-api-key: sk-ant-secret1234567890" }));
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.equal(h.requests.length, 1);
  const warning = h.notifications.at(-1)!.text;
  assert.match(warning, /falling back/u);
  assert.doesNotMatch(warning, /sk-ant-secret/u, "credentials are redacted");
});

test("hitting the output cap gets one condensed fast retry before fallback", async (t) => {
  const h = harness(t);
  h.setResponse(response({ stopReason: "length" }), response());
  const result = await h.emit("session_before_compact", event());
  assert.ok(result.compaction);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[1].context), /previous attempt exceeded the output limit/u);
  assert.doesNotMatch(JSON.stringify(h.requests[0].context), /previous attempt exceeded/u);
  assert.equal(result.compaction.details[DETAILS_KEY].condensed, true);
  assert.ok(h.statuses.some((s) => /condensing/u.test(s ?? "")));
});

test("a second output-cap failure falls back", async (t) => {
  const h = harness(t);
  h.setResponse(response({ stopReason: "length" }));
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.equal(h.requests.length, 2);
  assert.match(h.notifications.at(-1)!.text, /falling back/u);
});

for (const kind of ["error", "empty", "tool", "pending", "deferred", "provider-abort", "files-only"] as const) {
  test(`${kind} response is never accepted as a checkpoint and falls back`, async (t) => {
    const h = kind === "files-only"
      ? harness(t, { summarize: async (p) => ({ summary: "\n<read-files>\nsrc/a.ts\n</read-files>", firstKeptEntryId: p.firstKeptEntryId, tokensBefore: 1 }) })
      : harness(t);
    h.setResponse(kind === "empty" ? response({ content: [] })
      : kind === "tool" ? response({ content: [{ type: "toolCall", id: "bad", name: "bash", arguments: {} }], stopReason: "toolUse" })
      : kind === "provider-abort" ? response({ stopReason: "aborted" })
      : kind === "error" ? response({ stopReason: "error", errorMessage: "400 bad request" })
      : response({ stopReason: kind === "files-only" ? "stop" : kind }));
    assert.equal(await h.emit("session_before_compact", event()), undefined);
    assert.match(h.notifications.at(-1)!.text, /falling back/u);
    assert.match(h.statuses.at(-1)!, /fallback/u);
  });
}

test("user cancellation never falls back", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  h.setOnRequest(() => controller.abort());
  assert.deepEqual(await h.emit("session_before_compact", event({ signal: controller.signal })), { cancel: true });
  assert.equal(h.notifications.length, 0);
  await h.emit("session_compact_failed", { aborted: true });
  assert.match(h.statuses.at(-1)!, /cancelled/u);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await h.emit("session_before_compact", event({ signal: aborted.signal })), { cancel: true });
  assert.equal(h.requests.length, 1);
});

test("fallback disabled cancels, never saves bad context, and records a failure", async (t) => {
  const h = harness(t);
  h.store.update({ fallback: false });
  h.setResponse(response({ stopReason: "error", errorMessage: "400 bad request" }));
  assert.deepEqual(await h.emit("session_before_compact", event()), { cancel: true });
  assert.doesNotMatch(h.notifications.at(-1)!.text, /falling back/u);
  await h.emit("session_compact_failed", { aborted: true });
  assert.match(h.statuses.at(-1)!, /failed/u);
  assert.equal((custom(h).at(-1)?.data as any).outcome, "failed");
});

test("missing or too-small models fall back without dropping input", async (t) => {
  const h = harness(t);
  h.store.update({ model: "missing/haiku" });
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  h.store.update({ model: "fixture/haiku-test" });
  h.models[0] = { ...fast, contextWindow: 3000 };
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  assert.equal(h.requests.length, 0);
});

test("off thinking uses Pi's no-reasoning option; non-reasoning models work", async (t) => {
  const h = harness(t);
  h.store.update({ thinking: "off" });
  await h.emit("session_before_compact", event());
  assert.equal(h.requests.at(-1)?.options?.reasoning, undefined);
  h.models[0] = { ...fast, reasoning: false };
  h.store.update({ thinking: "max" });
  const result = await h.emit("session_before_compact", event());
  assert.equal(result.compaction.details[DETAILS_KEY].thinking, "off");
});

test("commands validate and persist, accept friendly numbers, keep slashes, and never alter the coding model", async (t) => {
  const h = harness(t);
  h.models.push({ ...fast, id: "vendor/model" });
  for (const command of ["model fixture/vendor/model", "thinking off", "words 4,000", "tokens 20k", "scope auto", "fallback off", "bar off", "off"]) await h.command(command);
  assert.deepEqual(h.store.load(), { version: 1, enabled: false, model: "fixture/vendor/model", thinking: "off", targetWords: 4000, maxOutputTokens: 20000, scope: "auto", fallback: false, showStatus: false });
  const before = h.store.load();
  for (const bad of ["thinking invalid", "words 3", "words lots", "tokens -1", "scope invalid", "fallback maybe", "model missing/model", "off junk", "unknown"]) await h.command(bad);
  assert.deepEqual(h.store.load(), before);
  assert.equal(h.notifications.filter((n) => n.type === "error").length, 9);
  assert.equal(h.ctx.model?.id, main.id);
});

test("model selection warns about missing credentials and a smaller context window", async (t) => {
  const h = harness(t);
  h.models.push({ ...fast, id: "small", provider: "nokey", contextWindow: 200000 });
  h.unauthenticated.add("nokey");
  await h.command("model nokey/small");
  const text = h.notifications.at(-1)!.text;
  assert.equal(h.notifications.at(-1)!.type, "warning");
  assert.match(text, /no configured credentials/u);
  assert.match(text, /smaller than the coding model/u);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Warning: its provider has no configured credentials/u);
});

test("argument completions cover subcommands, values and models", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  assert.deepEqual((await h.completions("th"))?.map((i) => i.value), ["thinking "]);
  assert.deepEqual((await h.completions("  th"))?.map((i) => i.value), ["thinking "]);
  assert.equal((await h.completions(""))?.length, 14);
  assert.deepEqual((await h.completions("st"))?.map((i) => i.value), ["status"]);
  assert.deepEqual((await h.completions("thinking m"))?.map((i) => i.value), ["thinking minimal", "thinking medium", "thinking max"]);
  assert.deepEqual((await h.completions("scope "))?.map((i) => i.value), ["scope both", "scope auto"]);
  assert.ok((await h.completions("model haiku"))?.some((i) => i.value === "model fixture/haiku-test"));
  assert.equal(await h.completions("zzz"), null);
});

test("menu stays open after a failed action", async (t) => {
  const h = harness(t);
  const picks = ["Model: fixture/haiku-test", "Prose target: 3000 words", undefined];
  h.ui.select = async () => picks.shift();
  h.ui.input = async () => "nonsense";
  await h.command("");
  assert.equal(picks.length, 0, "menu continued after errors until dismissed");
  assert.ok(h.notifications.filter((n) => n.type === "error").length >= 2);
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

test("invalid config uses native behavior and is only replaced by an explicit, confirmed reset", async (t) => {
  const h = harness(t);
  writeFileSync(h.store.path, "{malformed");
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /settings error/u);
  assert.match(h.notifications.at(-1)!.text, /\/compaction reset/u);
  assert.equal(await h.emit("session_before_compact", event()), undefined);
  await commit(h, undefined, false);
  await h.command("on");
  assert.equal(readFileSync(h.store.path, "utf8"), "{malformed");
  h.ui.confirm = async () => false;
  await h.command("reset");
  assert.equal(readFileSync(h.store.path, "utf8"), "{malformed");
  h.ui.confirm = async () => true;
  await h.command("reset");
  assert.deepEqual(h.store.load(), { ...DEFAULTS });
  assert.match(h.statuses.at(-1)!, /choose model/u);
});

test("status shows missing models, auto-only scope, hides on request, and clears on shutdown", async (t) => {
  const h = harness(t);
  h.store.update({ model: "gone/model" });
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /model missing · main/u);
  h.store.update({ model: "fixture/haiku-test", scope: "auto" });
  await h.emit("before_agent_start");
  assert.match(h.statuses.at(-1)!, /auto only/u);
  await h.command("bar off");
  assert.equal(h.statuses.at(-1), undefined);
  await h.command("bar on");
  await h.emit("session_shutdown");
  assert.equal(h.statuses.at(-1), undefined);
});

test("last result restores from the session after reload", async (t) => {
  const h = harness(t);
  h.setRequestMs(30000);
  await commit(h, await h.emit("session_before_compact", event()));
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /last 30s/u);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Last: success · fast · fixture\/haiku-test · low · 30s · 40 output tokens/u);
});

test("elapsed status refreshes each second and stops after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(t);
  const result = await h.emit("session_before_compact", event());
  h.setTime(6000);
  t.mock.timers.tick(1000);
  assert.match(h.statuses.at(-1)!, /compacting 5s/u);
  await commit(h, result);
  const count = h.statuses.length;
  t.mock.timers.tick(5000);
  assert.equal(h.statuses.length, count);
});

test("RPC clients get plain status text; print mode compacts without UI", async (t) => {
  const h = harness(t);
  (h.ctx as any).mode = "rpc";
  (h.ui as any).theme = undefined;
  await h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /^Cmp: Haiku test · low$/u);
  (h.ctx as any).mode = "print";
  (h.ctx as any).hasUI = false;
  const count = h.statuses.length;
  assert.ok((await h.emit("session_before_compact", event())).compaction);
  assert.equal(h.statuses.length, count);
  await h.command("");
  assert.match(h.notifications.at(-1)!.text, /Compaction controls/u);
});
