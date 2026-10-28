import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type {
  CompactionResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionBeforeCompactEvent,
  SessionBeforeCompactResult, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compact, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { ConfigStore, DEFAULTS, THINKING_LEVELS, parseCount, splitModelKey } from "./config.ts";
import type { Config, Thinking } from "./config.ts";
import { pickModel, refreshLocalModels } from "./picker.ts";
import {
  buildInstructions, carryFileOperations, DETAILS_KEY, effectiveThinking, formatDuration, formatTokens,
  modelKey, outputBudget, readRunRecord, safeError, safeLabel,
} from "./summary.ts";
import type { RunRecord } from "./summary.ts";

const STATUS_KEY = "fast-compaction";
const STATS_TYPE = "fast-compaction-result";
/** Transient provider failures (overloaded, 5xx, dropped streams) retry before any fallback. */
export const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 10_000 };
/** Anthropic budget-based thinking rejects budgets below 1024 tokens. */
export const THINKING_BUDGETS = { minimal: 1024, low: 1024, medium: 4096, high: 8192 } as const;

const SUBCOMMANDS = [
  ["on", false, "Use the selected compaction model"],
  ["off", false, "Restore normal Pi compaction"],
  ["model", true, "Choose the compaction model"],
  ["thinking", true, "Compaction reasoning level"],
  ["scope", true, "both = auto + /compact, auto = automatic only"],
  ["words", true, "Soft summary prose target"],
  ["tokens", true, "Output safety cap per request"],
  ["fallback", true, "Main-model fallback on failure"],
  ["bar", true, "Show or hide the status segment"],
  ["now", true, "Compact now (optional focus)"],
  ["main", true, "Compact once with the coding model"],
  ["status", false, "Settings and last result"],
  ["reset", false, "Restore default settings"],
  ["help", false, "Command reference"],
] as const;
const VALUE_CHOICES: Record<string, readonly string[]> = {
  thinking: THINKING_LEVELS, scope: ["both", "auto"], fallback: ["on", "off"], bar: ["on", "off"],
  words: ["off", "1500", "3000", "5000"], tokens: ["8192", "16384", "32768"],
};
const HELP = `Compaction controls (coding model unchanged):
/compaction                        settings menu
/compaction on | off               use selected model / restore normal Pi compaction
/compaction model [provider/id]    searchable picker or exact model
/compaction thinking [level]       independent reasoning level
/compaction scope both | auto      manual + automatic, or automatic only
/compaction words 3000 | off       soft prose target (500–20000)
/compaction tokens 16384           output cap per request, including thinking
/compaction fallback on | off      main-model fallback on failure
/compaction bar on | off           show/hide this status segment
/compaction now [focus]            compact now using configured policy
/compaction main [focus]           use the coding model just this once
/compaction status                 settings, last result and config path
/compaction reset                  restore defaults (also repairs a broken file)
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
  retry?: string;
  condensed?: boolean;
  /** Cancelled because fallback is off: a failure, not a user cancellation. */
  policyFailure?: boolean;
}

export interface Dependencies {
  store?: ConfigStore;
  summarize?: typeof compact;
  now?: () => number;
  retry?: RetryPolicy;
}

function abortError(): Error {
  return new DOMException("Compaction cancelled", "AbortError");
}

/** Model prose without Pi's appended file lists, to detect an empty checkpoint. */
function hasProse(summary: string): boolean {
  return summary.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/gu, "").trim().length > 0;
}

function contextLabel(model: Pick<Model<Api>, "contextWindow">): string {
  return `${formatTokens(model.contextWindow)} context`;
}

export function installExtension(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  const store = dependencies.store ?? new ConfigStore(join(getAgentDir(), "fast-compaction.json"));
  const summarize = dependencies.summarize ?? compact;
  const now = dependencies.now ?? Date.now;
  const retry = dependencies.retry ?? DEFAULT_RETRY;
  let config: Config = { ...DEFAULTS };
  let configError: string | undefined;
  let warnedConfigError: string | undefined;
  let last: RunRecord | undefined;
  let lastError: string | undefined;
  let active: Active | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let forceMainOnce = false;
  let manualPending = false;
  let registry: ExtensionContext["modelRegistry"] | undefined;
  /** Records waiting for a safe moment to be written (see persist()). */
  const pending: RunRecord[] = [];

  function load(ctx: ExtensionContext) {
    try {
      config = store.load();
      configError = undefined;
      warnedConfigError = undefined;
    } catch (error) {
      configError = safeError(error);
      if (warnedConfigError !== configError) {
        ctx.ui.notify(`Fast compaction settings error; using normal Pi compaction. Fix the file or run /compaction reset. ${configError}`, "warning");
        warnedConfigError = configError;
      }
    }
  }

  function findSelected(ctx: ExtensionContext, key = config.model): Model<Api> | undefined {
    if (!key) return;
    const { provider, id } = splitModelKey(key);
    return ctx.modelRegistry.find(provider, id);
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!config.showStatus) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
    let tone: "dim" | "accent" | "warning" = "dim";
    let text: string;
    if (active) {
      tone = active.route === "fallback" ? "warning" : "accent";
      const parts = [`Cmp: ${active.label}`];
      if (active.route !== "fast") parts.push(active.route === "other-extension" ? "extension" : active.route);
      if (active.retry) parts.push(`retry ${active.retry}`);
      if (active.condensed) parts.push("condensing");
      parts.push(`compacting ${formatDuration(now() - active.started)}`);
      text = parts.join(" · ");
    } else if (configError) {
      tone = "warning";
      text = "Cmp: settings error · main";
    } else if (!config.enabled) {
      text = "Cmp: off";
    } else if (!config.model) {
      text = "Cmp: choose model · main";
    } else {
      const model = findSelected(ctx);
      if (model) {
        text = `Cmp: ${safeLabel(model.name || model.id)} · ${config.thinking}${config.scope === "auto" ? " · auto only" : ""}`;
      } else {
        tone = "warning";
        text = `Cmp: ${safeLabel(splitModelKey(config.model).id)} missing · main`;
      }
    }
    if (!active && last) {
      text += ` · ${last.outcome === "success" ? "last" : last.outcome} ${formatDuration(last.durationMs)}${last.route === "fallback" ? " (fallback)" : ""}`;
      if (last.outcome === "failed" || last.route === "fallback") tone = "warning";
    }
    ctx.ui.setStatus(STATUS_KEY, ctx.mode === "tui" ? ctx.ui.theme.fg(tone, text) : text);
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
    if (ctx.mode === "tui" && config.showStatus) {
      timer = setInterval(() => render(ctx), 1000);
      timer.unref?.();
    }
  }

  function record(outcome: RunRecord["outcome"], outputTokens?: number): RunRecord | undefined {
    if (!active) return;
    return {
      version: 1, route: active.route, outcome, model: active.model,
      ...(active.servedModel ? { servedModel: active.servedModel } : {}),
      thinking: active.thinking, reason: active.reason, targetWords: active.targetWords,
      durationMs: Math.max(0, now() - active.started), timestamp: new Date(now()).toISOString(),
      ...(Number.isSafeInteger(outputTokens) ? { outputTokens } : {}),
      ...(active.condensed ? { condensed: true } : {}),
    };
  }

  /**
   * Pi reports "Already compacted" (and skips repeated threshold compaction) only while the
   * compaction is the last entry. Never end the branch with our metadata: defer it until the
   * next turn or prompt, when a context message follows immediately.
   */
  function persist(ctx: ExtensionContext, value: RunRecord) {
    if (ctx.sessionManager.getLeafEntry()?.type === "compaction") pending.push(value);
    else pi.appendEntry(STATS_TYPE, value);
  }

  function flushPending() {
    for (const value of pending.splice(0)) pi.appendEntry(STATS_TYPE, value);
  }

  function finish(ctx: ExtensionContext, outcome: RunRecord["outcome"], options: { embedded?: RunRecord; outputTokens?: number } = {}) {
    const result = options.embedded ?? record(outcome, options.outputTokens);
    stopTimer();
    active = undefined;
    if (result) {
      last = result;
      // Metadata only: no prompts, credentials, summaries, or provider error bodies.
      if (!options.embedded) persist(ctx, result);
    }
    render(ctx);
  }

  function restore(entries: SessionEntry[]) {
    last = undefined;
    for (const entry of entries) {
      if (entry.type === "compaction") {
        // A compaction without our metadata clears the display rather than showing an older result.
        last = entry.details && typeof entry.details === "object"
          ? readRunRecord((entry.details as Record<string, unknown>)[DETAILS_KEY]) : undefined;
      } else if (entry.type === "custom" && entry.customType === STATS_TYPE) {
        last = readRunRecord(entry.data) ?? last;
      }
    }
  }

  function update(ctx: ExtensionContext, patch: Partial<Omit<Config, "version">>) {
    config = store.update(patch);
    configError = undefined;
    warnedConfigError = undefined;
    render(ctx);
  }

  function modelWarnings(ctx: ExtensionContext, model: Model<Api>): string[] {
    const warnings: string[] = [];
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) warnings.push("its provider has no configured credentials");
    if (ctx.model && ctx.model.contextWindow > 0 && model.contextWindow < ctx.model.contextWindow) {
      warnings.push(`its ${contextLabel(model)} is smaller than the coding model's ${contextLabel(ctx.model)}; very large compactions may fall back`);
    }
    return warnings;
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
      const model = findSelected(ctx);
      if (model) {
        lines.push(`Effective thinking: ${effectiveThinking(model, config.thinking)} · ${contextLabel(model)}`);
        for (const warning of modelWarnings(ctx, model)) lines.push(`Warning: ${warning}`);
      } else lines.push("Warning: the selected model is missing from Pi's registry; normal Pi compaction is used.");
    }
    if (active) lines.push(`Running: ${active.model} · ${active.route} · ${formatDuration(now() - active.started)}`);
    if (last) {
      const tokens = last.outputTokens !== undefined ? ` · ${formatTokens(last.outputTokens)} output tokens` : "";
      lines.push(`Last: ${last.outcome} · ${last.route} · ${last.model} · ${last.thinking} · ${formatDuration(last.durationMs)}${tokens}${last.condensed ? " · condensed retry" : ""} · ${last.timestamp}`);
      if (last.servedModel) lines.push(`Served model (reported by response): ${last.servedModel}`);
    }
    if (lastError) lines.push(`Last error: ${lastError}`);
    if (configError) lines.push(`Settings error: ${configError}`);
    ctx.ui.notify(lines.join("\n"), "info");
    render(ctx);
  }

  async function changeModel(ctx: ExtensionCommandContext, value?: string) {
    const chosen = value || await pickModel(ctx, config.model);
    if (!chosen) return;
    splitModelKey(chosen);
    let model = findSelected(ctx, chosen);
    if (!model) {
      await refreshLocalModels(ctx);
      model = findSelected(ctx, chosen);
    }
    if (!model) throw new Error(`Unknown chat model: ${safeLabel(chosen, 120)}. Use /compaction model to choose from Pi's registry.`);
    update(ctx, { model: chosen });
    const warnings = modelWarnings(ctx, model);
    ctx.ui.notify(`Compaction model: ${chosen}. Coding model unchanged.${warnings.length ? `\nWarning: ${warnings.join("; ")}.` : ""}`, warnings.length ? "warning" : "info");
  }

  async function choose(ctx: ExtensionCommandContext, title: string, options: readonly string[], value?: string) {
    if (value) return value;
    if (!ctx.hasUI) throw new Error(`${title}: ${options.join(" | ")}`);
    return ctx.ui.select(title, [...options]);
  }

  function trigger(ctx: ExtensionCommandContext, main: boolean, focus?: string) {
    if (!ctx.isIdle() || active || manualPending) throw new Error("Wait until the agent and any compaction are idle before compacting manually.");
    manualPending = true;
    forceMainOnce = main;
    const reset = () => { manualPending = false; forceMainOnce = false; };
    try {
      ctx.compact({ customInstructions: focus, onComplete: reset, onError: (error) => {
        reset();
        ctx.ui.notify(`Compaction did not complete: ${safeError(error)}`, "warning");
      } });
    } catch (error) { reset(); throw error; }
  }

  async function resetSettings(ctx: ExtensionCommandContext) {
    if (ctx.hasUI && !await ctx.ui.confirm("Reset fast compaction settings?", "Restores defaults. The compaction model is cleared, so normal Pi compaction is used until you choose one.")) return;
    config = store.reset();
    configError = undefined;
    warnedConfigError = undefined;
    render(ctx);
    ctx.ui.notify("Fast compaction settings reset. Choose a model with /compaction model.", "info");
  }

  async function menu(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) { status(ctx); ctx.ui.notify(HELP, "info"); return; }
    for (;;) {
      load(ctx);
      const choices = [
        `Enabled: ${config.enabled ? "on" : "off"}`,
        `Model: ${config.model ?? "choose model"}`,
        `Thinking: ${config.thinking}`,
        `Scope: ${config.scope}`,
        `Prose target: ${config.targetWords || "off"} words`,
        `Output cap: ${config.maxOutputTokens} tokens`,
        `Fallback: ${config.fallback ? "on" : "off"}`,
        `Status bar: ${config.showStatus ? "on" : "off"}`,
        "Compact now", "Compact with main model once", "Show status", "Reset settings", "Done",
      ];
      const selected = await ctx.ui.select("Fast compaction — global settings", choices);
      const index = selected === undefined ? -1 : choices.indexOf(selected);
      if (index < 0 || index === 12) return;
      try {
        if (index === 0) update(ctx, { enabled: !config.enabled });
        if (index === 1) await changeModel(ctx);
        if (index === 2) {
          const value = await ctx.ui.select("Compaction thinking (never inherits coding-model thinking)", [...THINKING_LEVELS]);
          if (value) update(ctx, { thinking: value as Thinking });
        }
        if (index === 3) {
          const value = await ctx.ui.select("Apply selected model to", ["both", "auto"]);
          if (value) update(ctx, { scope: value as Config["scope"] });
        }
        if (index === 4 || index === 5) {
          const value = await ctx.ui.input(index === 4 ? "Soft word target (500–20000, or off)" : "Output token cap (2048–131072)", String(index === 4 ? config.targetWords : config.maxOutputTokens));
          if (value?.trim()) update(ctx, index === 4 ? { targetWords: value.trim() === "off" ? 0 : parseCount(value) } : { maxOutputTokens: parseCount(value) });
        }
        if (index === 6) update(ctx, { fallback: !config.fallback });
        if (index === 7) update(ctx, { showStatus: !config.showStatus });
        if (index === 8 || index === 9) { trigger(ctx, index === 9); return; }
        if (index === 10) status(ctx);
        if (index === 11) await resetSettings(ctx);
      } catch (error) {
        ctx.ui.notify(safeError(error), "error");
      }
    }
  }

  function completions(argumentPrefix: string): AutocompleteItem[] | null {
    // Pi replaces the whole argument text with the chosen value, so leading spaces can be dropped.
    const prefix = argumentPrefix.trimStart();
    const space = prefix.indexOf(" ");
    if (space < 0) {
      const items = SUBCOMMANDS.filter(([name]) => name.startsWith(prefix))
        .map(([name, args, description]) => ({ value: args ? `${name} ` : name, label: name, description }));
      return items.length ? items : null;
    }
    const command = prefix.slice(0, space);
    const partial = prefix.slice(space + 1).trimStart();
    if (command === "model") {
      const models = registry?.getAvailable() ?? [];
      const items = fuzzyFilter(models, partial, (m) => `${modelKey(m)} ${m.name}`).slice(0, 30)
        .map((m) => ({ value: `model ${modelKey(m)}`, label: modelKey(m), description: `${safeLabel(m.name || m.id)} · ${contextLabel(m)}` }));
      return items.length ? items : null;
    }
    const items = (VALUE_CHOICES[command] ?? []).filter((value) => value.startsWith(partial))
      .map((value) => ({ value: `${command} ${value}`, label: value }));
    return items.length ? items : null;
  }

  pi.registerCommand("compaction", {
    description: "Choose compaction model, reasoning, on/off, summary size, fallback and status",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      try {
        load(ctx);
        const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
        const command = match?.[1] ?? "";
        const value = match?.[2]?.trim() || undefined;
        if (!command) { await menu(ctx); return; }
        if (command === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (command === "status") { status(ctx); return; }
        if (command === "reset") { await resetSettings(ctx); return; }
        if (command === "now" || command === "main") { trigger(ctx, command === "main", value); return; }
        if (command === "model") { await changeModel(ctx, value); return; }
        if (command === "on" || command === "off") {
          if (value) throw new Error("Use /compaction on or /compaction off without extra arguments.");
          update(ctx, { enabled: command === "on" });
        } else if (command === "thinking") {
          const level = await choose(ctx, "Compaction thinking", THINKING_LEVELS, value);
          if (!level) return;
          update(ctx, { thinking: level as Thinking });
        } else if (command === "scope") {
          const scope = await choose(ctx, "Apply selected model to", VALUE_CHOICES.scope, value);
          if (!scope) return;
          update(ctx, { scope: scope as Config["scope"] });
        } else if (command === "fallback" || command === "bar") {
          const choice = await choose(ctx, command === "fallback" ? "Main-model fallback" : "Status segment", ["on", "off"], value);
          if (!choice) return;
          if (choice !== "on" && choice !== "off") throw new Error(`Use /compaction ${command} on or off.`);
          update(ctx, command === "fallback" ? { fallback: choice === "on" } : { showStatus: choice === "on" });
        } else if (command === "words" && value) update(ctx, { targetWords: value === "off" ? 0 : parseCount(value) });
        else if (command === "tokens" && value) update(ctx, { maxOutputTokens: parseCount(value) });
        else throw new Error("Unknown command or invalid arguments. See /compaction help.");
        ctx.ui.notify(`Fast compaction saved: ${config.enabled ? "on" : "off (normal Pi compaction)"} · ${config.model ?? "select a model"} · ${config.thinking}`, "info");
      } catch (error) { ctx.ui.notify(safeError(error), "error"); }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    registry = ctx.modelRegistry;
    load(ctx);
    restore(ctx.sessionManager.getBranch());
    render(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    // Unwritten records belong to the branch that was left.
    pending.length = 0;
    restore(ctx.sessionManager.getBranch());
    render(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => { flushPending(); load(ctx); render(ctx); });
  pi.on("turn_start", () => { flushPending(); });
  pi.on("model_select", (_event, ctx) => render(ctx));

  async function runFast(event: SessionBeforeCompactEvent, ctx: ExtensionContext, snapshot: Config): Promise<CompactionResult> {
    if (!snapshot.model) throw new Error("No compaction model selected. Use /compaction model.");
    const model = findSelected(ctx, snapshot.model);
    if (!model) throw new Error(`The selected compaction model ${safeLabel(snapshot.model, 120)} is not in Pi's model registry.`);
    const thinking = effectiveThinking(model, snapshot.thinking);
    if (active) Object.assign(active, { route: "fast", model: modelKey(model), label: safeLabel(model.name || model.id), thinking, targetWords: snapshot.targetWords });
    render(ctx);
    let hitLength = false;
    const stream: StreamFn = (requestedModel, context, options) => {
      const budget = outputBudget(context, requestedModel, snapshot);
      // Token-budget adapters may add thinking to maxTokens. Bound the model cap too,
      // without mutating the shared registry model or the coding model.
      const request = ctx.modelRegistry.streamSimple({ ...requestedModel, maxTokens: budget }, context, {
        ...options,
        // Pi represents disabled thinking as undefined; adapters then send their explicit "off".
        reasoning: thinking === "off" ? undefined : thinking,
        thinkingBudgets: THINKING_BUDGETS,
        maxTokens: budget,
        signal: event.signal,
        cacheRetention: "none",
      });
      const result = request.result.bind(request);
      request.result = async () => {
        const response = await result();
        // Only Pi's compaction signal means the user cancelled. Provider-side aborts are failures.
        if (event.signal.aborted) throw abortError();
        if (response.stopReason === "aborted") throw new Error("The provider aborted the compaction request.");
        if (response.stopReason === "length") hitLength = true;
        if (!["stop", "error", "length"].includes(response.stopReason)) {
          throw new Error(`The compaction response is not final (${response.stopReason}).`);
        }
        if (response.stopReason === "stop" && !response.content.some((block) => block.type === "text" && block.text.trim())) {
          throw new Error("The compaction model returned an empty summary.");
        }
        if (active && response.provider && response.model) active.servedModel = safeLabel(`${response.provider}/${response.model}`, 160);
        return response;
      };
      return request;
    };
    const callbacks: RetryCallbacks = {
      onRetryScheduled: (attempt, max) => { if (active) active.retry = `${attempt}/${max}`; render(ctx); },
      onRetryFinished: () => { if (active) active.retry = undefined; render(ctx); },
    };
    const attempt = async (condensed: boolean) => {
      const result = await summarize(
        event.preparation, model, undefined, undefined,
        buildInstructions(snapshot, event.preparation, event.customInstructions, condensed), event.signal,
        thinking, stream, undefined, retry, callbacks,
      );
      if (event.signal.aborted) throw abortError();
      if (!hasProse(result.summary)) throw new Error("The compaction model returned an empty summary.");
      return result;
    };
    try {
      return await attempt(false);
    } catch (error) {
      // Hitting the output cap is deterministic: retrying the same prompt would hit it again.
      // One firmer, shorter attempt with the fast model is still far cheaper than the main model.
      if (!hitLength || event.signal.aborted) throw error;
      hitLength = false;
      if (active) active.condensed = true;
      render(ctx);
      return await attempt(true);
    }
  }

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
      const result = await runFast(event, ctx, snapshot);
      const details = result.details && typeof result.details === "object" ? result.details : {};
      return { compaction: { ...result, details: { ...details, [DETAILS_KEY]: record("success", result.usage?.output) } } };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      lastError = safeError(error);
      if (!snapshot.fallback) {
        if (active) active.policyFailure = true;
        ctx.ui.notify(`Fast compaction failed; no summary saved. ${lastError}`, "error");
        return { cancel: true };
      }
      if (active) {
        Object.assign(active, {
          route: "fallback", model: ctx.model ? modelKey(ctx.model) : "main",
          label: safeLabel(ctx.model?.name || ctx.model?.id || "main"),
          thinking: ctx.thinkingLevel ?? "off", targetWords: 0,
          servedModel: undefined, retry: undefined, condensed: undefined,
        });
      }
      ctx.ui.notify(`Fast compaction unavailable; falling back to normal Pi compaction. ${lastError}`, "warning");
      render(ctx);
      return;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const details = event.compactionEntry.details;
    const embedded = event.fromExtension && details && typeof details === "object"
      ? readRunRecord((details as Record<string, unknown>)[DETAILS_KEY]) : undefined;
    if (embedded) { finish(ctx, "success", { embedded }); return; }
    if (active && event.fromExtension) active.route = "other-extension";
    finish(ctx, "success", { outputTokens: event.compactionEntry.usage?.output });
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (event.errorMessage) lastError = safeError(event.errorMessage);
    finish(ctx, active?.policyFailure || !event.aborted ? "failed" : "cancelled");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    active = undefined;
    manualPending = false;
    forceMainOnce = false;
    registry = undefined;
    // Writing now could leave our entry directly after a compaction; drop instead.
    pending.length = 0;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
