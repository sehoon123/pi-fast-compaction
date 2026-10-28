import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionBeforeCompactEvent,
  SessionBeforeCompactResult, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compact, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ConfigStore, DEFAULTS, THINKING_LEVELS, splitModelKey } from "./config.ts";
import type { Config, Thinking } from "./config.ts";
import { pickModel } from "./picker.ts";
import {
  buildInstructions, carryFileOperations, DETAILS_KEY, effectiveThinking, formatDuration,
  modelKey, outputBudget, readRunRecord, safeLabel,
} from "./summary.ts";
import type { RunRecord } from "./summary.ts";

const STATUS_KEY = "fast-compaction";
const STATS_TYPE = "fast-compaction-result";
const HELP = `Compaction controls (coding model unchanged):
/compaction                         settings menu
/compaction on | off                enable override / restore normal Pi compaction
/compaction model [provider/id]      searchable picker or exact model
/compaction thinking [level]         independent reasoning level
/compaction scope both | auto        manual + auto, or automatic only
/compaction words 3000 | off         soft prose target (500–20000)
/compaction tokens 16384             output safety cap per request (includes thinking)
/compaction fallback on | off        main-model fallback on failure
/compaction bar on | off             show/hide this status segment
/compaction now [focus]              compact now using configured policy
/compaction main [focus]             use the main model just this once
/compaction status                  settings, last result and config path
/compaction help                    this help
All settings are global and persist across restarts. Off does NOT disable Pi auto-compaction.`;

interface Active {
  started: number;
  route: RunRecord["route"];
  model: string;
  label: string;
  thinking: Thinking;
  reason: RunRecord["reason"];
  targetWords: number;
  servedModel?: string;
}

export interface Dependencies {
  store?: ConfigStore;
  summarize?: typeof compact;
  now?: () => number;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s"']+|\bsk-[\w-]+/giu, "[redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 240);
}

export function installExtension(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  const store = dependencies.store ?? new ConfigStore(join(getAgentDir(), "fast-compaction.json"));
  const summarize = dependencies.summarize ?? compact;
  const now = dependencies.now ?? Date.now;
  let config: Config = { ...DEFAULTS };
  let configError: string | undefined;
  let last: RunRecord | undefined;
  let lastError: string | undefined;
  let active: Active | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let forceMainOnce = false;
  let manualPending = false;
  let warnedConfigError: string | undefined;

  function load(ctx: ExtensionContext) {
    try {
      config = store.load();
      configError = undefined;
      warnedConfigError = undefined;
    } catch (error) {
      configError = errorText(error);
      if (warnedConfigError !== configError) {
        ctx.ui.notify(`Fast compaction settings error; using normal Pi compaction. ${configError}`, "warning");
        warnedConfigError = configError;
      }
    }
  }

  function configuredLabel(ctx: ExtensionContext): string {
    if (!config.model) return "choose model";
    const { provider, id } = splitModelKey(config.model);
    const model = ctx.modelRegistry.find(provider, id);
    return safeLabel(model?.name || id);
  }

  function render(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (!config.showStatus) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
    let text: string;
    if (active) {
      const route = active.route === "fast" ? "" : ` · ${active.route}`;
      text = `Cmp: ${active.label}${route} · compacting ${formatDuration(now() - active.started)}`;
    } else if (configError) {
      text = "Cmp: settings error · main";
    } else {
      text = config.enabled ? `Cmp: ${configuredLabel(ctx)}${config.model ? ` · ${config.thinking}` : ""}` : "Cmp: off";
      if (last) text += ` · ${last.outcome === "success" ? "last" : last.outcome} ${formatDuration(last.durationMs)}${last.route === "fallback" ? " (fallback)" : ""}`;
    }
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function begin(ctx: ExtensionContext, reason: RunRecord["reason"]) {
    stopTimer();
    active = {
      started: now(), route: "main", model: ctx.model ? modelKey(ctx.model) : "main",
      label: safeLabel(ctx.model?.name || ctx.model?.id || "main"),
      thinking: ctx.thinkingLevel ?? "off", reason, targetWords: 0,
    };
    lastError = undefined;
    render(ctx);
    if (ctx.mode === "tui") {
      timer = setInterval(() => render(ctx), 1000);
      timer.unref();
    }
  }

  function record(outcome: RunRecord["outcome"]): RunRecord | undefined {
    if (!active) return;
    return {
      version: 1, route: active.route, outcome, model: active.model,
      ...(active.servedModel ? { servedModel: active.servedModel } : {}),
      thinking: active.thinking, reason: active.reason, targetWords: active.targetWords,
      durationMs: Math.max(0, now() - active.started), timestamp: new Date(now()).toISOString(),
    };
  }

  function finish(ctx: ExtensionContext, outcome: RunRecord["outcome"]) {
    const result = record(outcome);
    stopTimer();
    active = undefined;
    if (result) {
      last = result;
      // Metadata only: no prompts, credentials, summaries, or provider error bodies.
      pi.appendEntry(STATS_TYPE, result);
    }
    render(ctx);
  }

  function restore(entries: SessionEntry[]) {
    last = undefined;
    for (const entry of entries) {
      const r = entry.type === "custom" && entry.customType === STATS_TYPE
        ? readRunRecord(entry.data)
        : entry.type === "compaction" && entry.details && typeof entry.details === "object"
          ? readRunRecord((entry.details as Record<string, unknown>)[DETAILS_KEY]) : undefined;
      if (r) last = r;
    }
  }

  function update(ctx: ExtensionContext, patch: Partial<Omit<Config, "version">>) {
    config = store.update(patch);
    configError = undefined;
    render(ctx);
  }

  function status(ctx: ExtensionContext) {
    load(ctx);
    const lines = [
      `Fast compaction: ${config.enabled ? "on" : "off (normal Pi compaction)"}`,
      `Model: ${config.model ?? "not selected — normal Pi compaction until selected"}`,
      `Thinking: ${config.thinking} (independent of coding-model thinking)`,
      `Scope: ${config.scope === "both" ? "automatic and manual" : "automatic only"}`,
      `Prose target: ${config.targetWords || "off"} words (soft; file lists excluded)`,
      `Output cap: ${config.maxOutputTokens} tokens per request, including thinking`,
      `Fallback: ${config.fallback ? "main model" : "cancel; do not replace context"}`,
      `Status bar: ${config.showStatus ? "on" : "off"}`,
      `Settings: ${store.path}`,
    ];
    if (config.model) {
      const { provider, id } = splitModelKey(config.model);
      const model = ctx.modelRegistry.find(provider, id);
      lines.push(model ? `Effective thinking: ${effectiveThinking(model, config.thinking)}` : "Selected model is missing from Pi's registry.");
    }
    if (active) lines.push(`Running: ${active.model} · ${active.route} · ${formatDuration(now() - active.started)}`);
    if (last) lines.push(`Last: ${last.outcome} · ${last.route} · ${last.model} · ${last.thinking} · ${formatDuration(last.durationMs)} · ${last.timestamp}${last.servedModel ? `\nServed model: ${last.servedModel}` : ""}`);
    if (lastError) lines.push(`Last error: ${lastError}`);
    if (configError) lines.push(`Settings error: ${configError}`);
    ctx.ui.notify(lines.join("\n"), "info");
    render(ctx);
  }

  async function changeModel(ctx: ExtensionCommandContext, value?: string) {
    const chosen = value || await pickModel(ctx, config.model);
    if (!chosen) return;
    const { provider, id } = splitModelKey(chosen);
    if (!ctx.modelRegistry.find(provider, id)) throw new Error(`Unknown chat model: ${safeLabel(chosen)}. Use /compaction model to choose from Pi's registry.`);
    update(ctx, { model: chosen });
    ctx.ui.notify(`Compaction model: ${chosen}. Coding model unchanged.`, "info");
  }

  async function menu(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) { status(ctx); ctx.ui.notify(HELP, "info"); return; }
    for (;;) {
      const choices = [
        `Enabled: ${config.enabled ? "on" : "off"}`,
        `Model: ${config.model ?? "choose model"}`,
        `Thinking: ${config.thinking}`,
        `Scope: ${config.scope}`,
        `Prose target: ${config.targetWords || "off"} words`,
        `Output cap: ${config.maxOutputTokens} tokens`,
        `Fallback: ${config.fallback ? "on" : "off"}`,
        `Status bar: ${config.showStatus ? "on" : "off"}`,
        "Compact now", "Compact with main model once", "Show status", "Done",
      ];
      const selected = await ctx.ui.select("Fast compaction — global settings", choices);
      const index = selected === undefined ? -1 : choices.indexOf(selected);
      if (index < 0 || index === 11) return;
      if (index === 0) update(ctx, { enabled: !config.enabled });
      if (index === 1) await changeModel(ctx);
      if (index === 2) {
        const value = await ctx.ui.select("Compaction thinking (never inherits coding-model max)", [...THINKING_LEVELS]);
        if (value) update(ctx, { thinking: value as Thinking });
      }
      if (index === 3) {
        const value = await ctx.ui.select("Apply selected model to", ["both", "auto"]);
        if (value) update(ctx, { scope: value as Config["scope"] });
      }
      if (index === 4 || index === 5) {
        const value = await ctx.ui.input(index === 4 ? "Soft word target (500–20000, or off)" : "Output token cap (2048–131072)", String(index === 4 ? config.targetWords : config.maxOutputTokens));
        if (value?.trim()) update(ctx, index === 4 ? { targetWords: value.trim() === "off" ? 0 : Number(value) } : { maxOutputTokens: Number(value) });
      }
      if (index === 6) update(ctx, { fallback: !config.fallback });
      if (index === 7) update(ctx, { showStatus: !config.showStatus });
      if (index === 8 || index === 9) { trigger(ctx, index === 9); return; }
      if (index === 10) status(ctx);
    }
  }

  function trigger(ctx: ExtensionCommandContext, main: boolean, focus?: string) {
    if (!ctx.isIdle() || active || manualPending) throw new Error("Wait until the agent and any compaction are idle before compacting manually.");
    manualPending = true;
    forceMainOnce = main;
    const reset = () => { manualPending = false; forceMainOnce = false; };
    try {
      ctx.compact({ customInstructions: focus, onComplete: reset, onError: (error) => {
        reset();
        ctx.ui.notify(`Compaction did not complete: ${errorText(error)}`, "warning");
      } });
    } catch (error) { reset(); throw error; }
  }

  pi.registerCommand("compaction", {
    description: "Choose compaction model, reasoning, on/off, summary size, fallback and status",
    getArgumentCompletions: (prefix) => {
      const choices = ["on", "off", "model", "thinking", "scope", "words", "tokens", "fallback", "bar", "now", "main", "status", "help"];
      const matches = choices.filter((value) => value.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        load(ctx);
        const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
        const command = match?.[1] ?? "";
        const value = match?.[2]?.trim();
        if (!command) { await menu(ctx); return; }
        if (command === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (command === "status") { status(ctx); return; }
        if (command === "now" || command === "main") { trigger(ctx, command === "main", value); return; }
        if (command === "model") { await changeModel(ctx, value); return; }
        if (command === "thinking") {
          const level = value ?? (ctx.hasUI ? await ctx.ui.select("Compaction thinking", [...THINKING_LEVELS]) : undefined);
          if (!level) { ctx.ui.notify(`Thinking: ${config.thinking}. Levels: ${THINKING_LEVELS.join(", ")}`, "info"); return; }
          update(ctx, { thinking: level as Thinking });
        } else if (command === "on" || command === "off") {
          if (value) throw new Error("Use /compaction on or /compaction off without extra arguments.");
          update(ctx, { enabled: command === "on" });
        } else if (command === "scope" && value) update(ctx, { scope: value as Config["scope"] });
        else if (command === "words" && value) update(ctx, { targetWords: value === "off" ? 0 : Number(value) });
        else if (command === "tokens" && value) update(ctx, { maxOutputTokens: Number(value) });
        else if ((command === "fallback" || command === "bar") && ["on", "off"].includes(value ?? "")) {
          update(ctx, command === "fallback" ? { fallback: value === "on" } : { showStatus: value === "on" });
        } else throw new Error("Unknown command or invalid arguments. See /compaction help.");
        ctx.ui.notify(`Fast compaction saved: ${config.enabled ? "on" : "off (normal Pi compaction)"} · ${config.model ?? "select a model"} · ${config.thinking}`, "info");
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    load(ctx);
    restore(ctx.sessionManager.getBranch());
    render(ctx);
  });
  pi.on("session_tree", (_event, ctx) => { restore(ctx.sessionManager.getBranch()); render(ctx); });
  pi.on("before_agent_start", (_event, ctx) => { load(ctx); render(ctx); });
  pi.on("model_select", (_event, ctx) => render(ctx));

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    load(ctx);
    // Do this even when disabled or falling back, to preserve cumulative files in native compaction.
    carryFileOperations(event);
    begin(ctx, event.reason);
    const mainOnce = event.reason === "manual" && forceMainOnce;
    if (mainOnce) forceMainOnce = false;
    if (configError || !config.enabled || mainOnce || (config.scope === "auto" && event.reason === "manual")) return;
    const snapshot = { ...config };
    if (event.signal.aborted) return { cancel: true };
    try {
      if (!snapshot.model) throw new Error("No compaction model selected. Use /compaction model.");
      const { provider, id } = splitModelKey(snapshot.model);
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) throw new Error("The selected compaction model is not in Pi's model registry.");
      const thinking = effectiveThinking(model, snapshot.thinking);
      Object.assign(active!, { route: "fast", model: modelKey(model), label: safeLabel(model.name || model.id), thinking, targetWords: snapshot.targetWords });
      render(ctx);
      const stream: StreamFn = (requestedModel, context, options) => {
        const budget = outputBudget(context, requestedModel, snapshot);
        // Token-budget adapters may add thinking to maxTokens. Bound the model cap too,
        // without mutating the shared registry model or the coding model.
        const boundedModel = { ...requestedModel, maxTokens: budget };
        const request = ctx.modelRegistry.streamSimple(boundedModel, context, {
          ...options,
          // Pi represents disabled thinking as undefined; clampThinkingLevel applies model floors.
          reasoning: thinking === "off" ? undefined : thinking,
          thinkingBudgets: { minimal: 512, low: 1024, medium: 4096, high: 8192 },
          maxTokens: budget,
          signal: event.signal,
          cacheRetention: "none",
        });
        const result = request.result.bind(request);
        request.result = async () => {
          const response = await result();
          if (event.signal.aborted || response.stopReason === "aborted") {
            throw new DOMException("Compaction cancelled", "AbortError");
          }
          if (!["stop", "error", "length"].includes(response.stopReason)) {
            throw new Error(`The compaction response is not final (${response.stopReason}).`);
          }
          if (response.stopReason === "stop"
            && !response.content.some((block) => block.type === "text" && block.text.trim())) {
            throw new Error("The compaction model returned an empty summary.");
          }
          if (active && response.provider && response.model) active.servedModel = `${response.provider}/${response.model}`;
          return response;
        };
        return request;
      };
      const result = await summarize(
        event.preparation, model, undefined, undefined,
        buildInstructions(snapshot, event.preparation, event.customInstructions), event.signal,
        thinking, stream,
      );
      if (event.signal.aborted) return { cancel: true };
      const details = result.details && typeof result.details === "object" ? result.details : {};
      return { compaction: { ...result, details: { ...details, [DETAILS_KEY]: record("success") } } };
    } catch (error) {
      if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { cancel: true };
      lastError = errorText(error);
      if (!snapshot.fallback) {
        ctx.ui.notify(`Fast compaction failed; no summary saved. ${lastError}`, "error");
        return { cancel: true };
      }
      Object.assign(active!, {
        route: "fallback", model: ctx.model ? modelKey(ctx.model) : "main",
        label: safeLabel(ctx.model?.name || ctx.model?.id || "main"),
        thinking: ctx.thinkingLevel ?? "off", targetWords: 0, servedModel: undefined,
      });
      ctx.ui.notify(`Fast compaction unavailable; falling back to normal Pi compaction. ${lastError}`, "warning");
      render(ctx);
      return;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    if (active && event.fromExtension && !readRunRecord((event.compactionEntry.details as Record<string, unknown> | undefined)?.[DETAILS_KEY])) active.route = "other-extension";
    finish(ctx, "success");
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (event.errorMessage) lastError = errorText(event.errorMessage);
    finish(ctx, event.aborted ? "cancelled" : "failed");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    active = undefined;
    manualPending = false;
    forceMainOnce = false;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
