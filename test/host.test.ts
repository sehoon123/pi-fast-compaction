import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { temporary } from "./helpers.ts";

// Uses Pi's actual resource loader, Jiti extension mapping, provider runtime, command
// dispatch, compaction lifecycle and persisted projection. No remote calls or credentials.
test("actual Pi host: package load, commands, compaction, native/off and cumulative files", async (t) => {
  const dir = temporary(t);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const store = new ConfigStore(join(dir, "fast-compaction.json"));
  store.update({ model: "compaction-host/fast" });
  const provider = fauxProvider({
    provider: "compaction-host",
    models: [
      { id: "main", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: "fast", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
    ],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, keepRecentTokens: 0 }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("src/index.ts")], systemPrompt: "Test fixture only.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: "Keep the API compatible.", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage([
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/important.ts" } },
    { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/changed.ts", oldText: "old", newText: "new" } },
  ], { stopReason: "toolUse" }));
  for (const [id, name] of [["read-1", "read"], ["edit-1", "edit"]]) {
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 });
  }
  manager.appendMessage(fauxAssistantMessage("Investigated the bug."));
  manager.appendMessage({ role: "user", content: "Continue the fix.", timestamp: 2 });
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, model: provider.getModel("main")!, thinkingLevel: "max",
    settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [],
  });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  assert.ok(session.extensionRunner?.getCommand("compaction"));
  await session.prompt("/compaction words 2500");
  assert.equal(store.load().targetWords, 2500);
  assert.equal(session.messages.filter((m) => m.role === "user").length, 2);
  const calls: { id: string; options?: SimpleStreamOptions }[] = [];
  provider.setResponses([(context, options, _state, model) => {
    calls.push({ id: model.id, options });
    assert.match(JSON.stringify(context), /2500 words/u);
    return fauxAssistantMessage("## Goal\nKeep the API compatible.\n## Next Steps\nContinue fixing the bug.");
  }]);
  const compacted = await session.compact("Keep API constraints.");
  assert.equal(calls[0].id, "fast");
  assert.equal(calls[0].options?.reasoning, "low");
  assert.ok(compacted.usage);
  assert.match(compacted.summary, /src\/important\.ts/u);
  assert.match(compacted.summary, /src\/changed\.ts/u);
  assert.equal(session.model?.id, "main");
  // Pi clamps unsupported max to high on this fixture; compaction must not alter it.
  const thinkingAfter = session.thinkingLevel;
  assert.ok(thinkingAfter === "high" || thinkingAfter === "max");
  const fastEntry = manager.getLeafEntry();
  assert.equal(fastEntry?.type, "compaction", "no metadata entry may follow the compaction");
  assert.equal((fastEntry as any).fromHook, true);
  assert.equal((fastEntry as any).details.fastCompaction.route, "fast");
  // Regression: Pi's guard must still see the compaction as the last entry.
  await assert.rejects(session.compact(), /Already compacted/u);
  await session.prompt("/compaction off");
  manager.appendMessage({ role: "user", content: "Another follow-up.", timestamp: 3 });
  provider.setResponses([(_context, options, _state, model) => {
    calls.push({ id: model.id, options });
    return fauxAssistantMessage("## Goal\nNative summary.");
  }]);
  const native = await session.compact();
  assert.equal(calls[1].id, "main");
  assert.match(native.summary, /src\/important\.ts/u);
  assert.match(native.summary, /src\/changed\.ts/u);
  assert.equal(session.thinkingLevel, thinkingAfter);
  assert.equal(manager.getLeafEntry()?.type, "compaction");
  await assert.rejects(session.compact(), /Already compacted/u, "also preserved when the override is off");
  await session.prompt("/compaction on");
  manager.appendMessage({ role: "user", content: "Test safe fallback.", timestamp: 4 });
  const truncated = (_context: unknown, options: SimpleStreamOptions | undefined, _state: unknown, model: { id: string }) => {
    calls.push({ id: model.id, options });
    return fauxAssistantMessage("Incomplete checkpoint", { stopReason: "length" });
  };
  provider.setResponses([
    truncated,
    truncated,
    (_context, options, _state, model) => {
      calls.push({ id: model.id, options });
      return fauxAssistantMessage("## Goal\nSafe fallback checkpoint.");
    },
    fauxAssistantMessage("Next answer."),
  ]);
  const recovered = await session.compact();
  assert.deepEqual(calls.slice(-3).map((call) => call.id), ["fast", "fast", "main"], "condensed fast retry before fallback");
  assert.doesNotMatch(recovered.summary, /Incomplete checkpoint/u);
  assert.match(recovered.summary, /Safe fallback/u);
  assert.equal(manager.getLeafEntry()?.type, "compaction");
  // The deferred fallback record is written when the next prompt starts, before its message.
  await session.prompt("Next question");
  const branch = manager.getBranch();
  const at = branch.findLastIndex((entry) => entry.type === "compaction");
  const next = branch[at + 1];
  assert.equal(next?.type === "custom" && next.customType, "fast-compaction-result");
  assert.ok(branch.slice(at + 2).some((entry) => entry.type === "message" && entry.message.role === "user"), "a context message follows");
  assert.equal(manager.getLeafEntry()?.type, "message");
  // Pending records flush in order, so the newest compaction's record is the last one.
  const records = branch.filter((entry) => entry.type === "custom" && entry.customType === "fast-compaction-result");
  assert.deepEqual(records.map((entry: any) => entry.data.route), ["main", "fallback"]);
  assert.equal(errors.length, 0, JSON.stringify(errors));
});
