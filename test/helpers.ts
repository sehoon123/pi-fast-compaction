import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { installExtension } from "../src/extension.ts";
import type { Dependencies } from "../src/extension.ts";

export const fast: Model<Api> = {
  id: "haiku-test", name: "Haiku test", provider: "fixture", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1",
  reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 64000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const main: Model<Api> = { ...fast, id: "opus-test", name: "Opus test" };
export const usage = { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function response(patch: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", api: fast.api, provider: fast.provider, model: fast.id, stopReason: "stop", timestamp: 1000,
    content: [{ type: "text", text: "## Goal\nContinue the task.\n## Next Steps\n1. Run tests." }], usage, ...patch };
}
export function event(patch: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal, branchEntries: [],
    preparation: {
      firstKeptEntryId: "kept", tokensBefore: 100000, messagesToSummarize: [{ role: "user", content: "Fix the test failure.", timestamp: 1 }],
      turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]), written: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    }, ...patch,
  };
}
export function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-compaction-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type StreamOverride = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** A provider that never answers. With `honorAbort`, it ends as aborted once its signal fires. */
export function stalledStream(honorAbort: boolean): StreamOverride {
  return (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    if (honorAbort) options?.signal?.addEventListener("abort", () => stream.end(response({ stopReason: "aborted", content: [] })), { once: true });
    return stream;
  };
}

/** Lets pending promise chains (not timers) run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Lets due real timers run too, e.g. a notice deferred until after Pi redraws the chat. */
export const afterTimers = () => new Promise((resolve) => setTimeout(resolve, 5));

export function harness(t: TestContext, dependencies: Dependencies = {}) {
  const dir = temporary(t);
  const store = new ConfigStore(join(dir, "settings.json"));
  store.update({ model: "fixture/haiku-test" });
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
  const commands = new Map<string, RegisteredCommand>();
  const entries: SessionEntry[] = [];
  const notifications: { text: string; type?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const requests: { model: Model<Api>; context: TranscriptContext; options?: SimpleStreamOptions }[] = [];
  const models = [fast, main];
  const unauthenticated = new Set<string>();
  let queue: AssistantMessage[] = [response()];
  let clock = 1000;
  let requestMs = 0;
  let onRequest: (() => void) | undefined;
  let streamOverride: StreamOverride | undefined;
  let compactOptions: Parameters<ExtensionContext["compact"]>[0];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: String(entries.length), parentId: null, timestamp: new Date(clock).toISOString(), customType, data }); },
  } as unknown as ExtensionAPI;
  const ui = {
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    notify(text: string, type?: string) { notifications.push({ text, type }); },
    select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined,
    input: async (_title: string, _placeholder?: string): Promise<string | undefined> => undefined,
    confirm: async () => true,
    theme: { fg: (_color: string, text: string) => text },
  };
  const ctx = {
    mode: "tui", hasUI: true, cwd: dir, model: main, thinkingLevel: "max", scopedModels: [], ui,
    sessionManager: { getBranch: () => entries, getLeafEntry: () => entries.at(-1) },
    modelRegistry: {
      find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      getAvailable: () => models, refresh: async () => ({}),
      hasConfiguredAuth: (m: Model<Api>) => !unauthenticated.has(m.provider),
      streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
        requests.push({ model, context, options });
        clock += requestMs;
        onRequest?.();
        if (streamOverride) return streamOverride(model, context, options);
        const stream = createAssistantMessageEventStream();
        stream.end(queue.length > 1 ? queue.shift()! : queue[0]);
        return stream;
      },
    },
    isIdle: () => true,
    compact(options: typeof compactOptions) { compactOptions = options; },
  } as unknown as ExtensionCommandContext;
  installExtension(pi, { store, now: () => clock, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, ...dependencies });
  async function emit(name: string, value: any = {}) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  }
  t.after(() => emit("session_shutdown"));
  return {
    store, ctx, ui, entries, notifications, statuses, requests, models, unauthenticated, emit,
    command: (args: string) => commands.get("compaction")!.handler(args, ctx),
    completions: (prefix: string) => commands.get("compaction")!.getArgumentCompletions!(prefix),
    /** Responses are consumed in order; the last one repeats. */
    setResponse: (...values: AssistantMessage[]) => { queue = values; },
    setTime: (value: number) => { clock = value; },
    /** Simulated provider latency, applied to the injected clock on each request. */
    setRequestMs: (value: number) => { requestMs = value; },
    setOnRequest: (fn: (() => void) | undefined) => { onRequest = fn; },
    /** Replaces the provider stream, e.g. to stall or to stream deltas. */
    setStream: (fn: StreamOverride | undefined) => { streamOverride = fn; },
    getCompactOptions: () => compactOptions,
  };
}
