import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEvent, Model, RetryCallbacks, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type {
  CompactionResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionBeforeCompactEvent,
  SessionBeforeCompactResult, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compact, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  ConfigFileError, ConfigStore, DEFAULTS, THINKING_LEVELS, TIMEOUT_RANGE, parseCount, parseSeconds, splitModelKey,
} from "./config.ts";
import type { Config, Thinking } from "./config.ts";
import { pickModel, refreshLocalModels } from "./picker.ts";
import {
  buildInstructions, carryFileOperations, checkpointProblem, DETAILS_KEY, describeContext, effectiveThinking,
  formatDuration, formatTokens, modelKey, outputBudget, readRunRecord, reducedThinking, safeError, safeLabel,
  sizingAdvice, THINKING_BUDGETS,
} from "./summary.ts";
import type { RunRecord } from "./summary.ts";

export { THINKING_BUDGETS };

const STATUS_KEY = "fast-compaction";
const STATS_TYPE = "fast-compaction-result";
/** Transient provider failures (overloaded, 5xx, dropped streams) retry before any fallback. */
export const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 10_000 };

const SUBCOMMANDS = [
  ["on", false, "Use the selected compaction model"],
  ["off", false, "Restore normal Pi compaction"],
  ["model", true, "Choose the compaction model"],
  ["thinking", true, "Compaction reasoning level"],
  ["scope", true, "both = auto + /compact, auto = automatic only"],
  ["words", true, "Soft summary prose target"],
  ["tokens", true, "Output safety cap per request"],
  ["timeout", true, "Time limit for the selected model"],
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
  words: ["off", "1500", "3000", "5000"], tokens: ["8192", "16384", "32768"], timeout: ["off", "120", "300", "600"],
};
const HELP = `Compaction controls (coding model unchanged):
/compaction                        settings menu
/compaction on | off               use selected model / restore normal Pi compaction
/compaction model [provider/id]    searchable picker, exact model, or a partial name to search
/compaction thinking [level]       independent reasoning level
/compaction scope both | auto      manual + automatic, or automatic only
/compaction words 3000 | off       soft prose target (500–20000)
/compaction tokens 16384           output cap per request, including thinking
/compaction timeout 300 | off      time limit for the selected model (30–3600s, e.g. 90s, 5m)
/compaction fallback on | off      main-model fallback on failure
/compaction bar on | off           show/hide this status segment
/compaction now [focus]            compact now using configured policy
/compaction main [focus]           use the coding model just this once
/compaction status                 settings, last result and config path
/compaction reset                  restore defaults (also repairs a broken file)
All settings are global and persist across restarts. Off does NOT disable Pi auto-compaction.`;

/** One compaction, from session_before_compact until Pi reports success or failure. */
interface Run {
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
  /** Characters streamed by the current request: progress, and evidence the provider is alive. */
  streamed: number;
  /** Output tokens of the accepted checkpoint (usage may also include discarded attempts). */
  outputTokens?: number;
  /** Cancelled because fallback is off: a failure, not a user cancellation. */
  policyFailure?: boolean;
  /** Why the selected model was not used. */
  error?: string;
  /** Shown once the compaction completes. */
  hint?: string;
}

export interface Dependencies {
  store?: ConfigStore;
  summarize?: typeof compact;
  now?: () => number;
  retry?: RetryPolicy;
}

type Tone = "dim" | "accent" | "warning";

function abortError(): Error {
  return new DOMException("Compaction cancelled", "AbortError");
}

/** Settles as soon as `signal` aborts, even if a provider adapter ignores the abort. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: (a.cost?.input ?? 0) + (b.cost?.input ?? 0),
      output: (a.cost?.output ?? 0) + (b.cost?.output ?? 0),
      cacheRead: (a.cost?.cacheRead ?? 0) + (b.cost?.cacheRead ?? 0),
      cacheWrite: (a.cost?.cacheWrite ?? 0) + (b.cost?.cacheWrite ?? 0),
      total: (a.cost?.total ?? 0) + (b.cost?.total ?? 0),
    },
  };
}

/** Our record inside a compaction entry's details, if any. */
function embeddedRecord(details: unknown): RunRecord | undefined {
  return details && typeof details === "object" ? readRunRecord((details as Record<string, unknown>)[DETAILS_KEY]) : undefined;
}

/** Streams a request's events in the background to count progress. Cosmetic: never throws. */
function observe(request: AsyncIterable<AssistantMessageEvent>, run: Run) {
  void (async () => {
    try {
      for await (const item of request) {
        if (item.type === "text_delta" || item.type === "thinking_delta") run.streamed += item.delta.length;
      }
    } catch { /* progress display only */ }
  })();
}

const ON = new Set(["on", "true", "yes", "enable", "enabled"]);
const OFF = new Set(["off", "false", "no", "disable", "disabled"]);
function parseSwitch(value: string, command: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (ON.has(normalized)) return true;
  if (OFF.has(normalized)) return false;
  throw new Error(`Use /compaction ${command} on or off.`);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Closest subcommand for a typo, e.g. "thnking" → "thinking". */
function suggestSubcommand(input: string): string | undefined {
  const names: string[] = SUBCOMMANDS.map(([name]) => name);
  if (input.length >= 2) {
    const prefixed = names.filter((name) => name.startsWith(input));
    if (prefixed.length === 1) return prefixed[0];
  }
  const allowed = Math.min(2, Math.floor(input.length / 2));
  return names.map((name) => [name, editDistance(input, name)] as const)
    .filter(([, distance]) => distance <= allowed)
    .sort((a, b) => a[1] - b[1])[0]?.[0];
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
  /** The compaction shown in the status bar. Each handler keeps its own Run, so records never go missing. */
  let active: Run | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let forceMainOnce = false;
  let manualPending = false;
  /** Pi already reported the failure of the manual compaction we started: avoid a duplicate notice. */
  let manualFailureReported = false;
  let hintedNoModel = false;
  let registry: ExtensionContext["modelRegistry"] | undefined;
  /** Records waiting for a safe moment to be written (see persist()). */
  const pending: RunRecord[] = [];

  /** Notifications must never throw into Pi, e.g. from a callback that outlived a /reload. */
  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
    try { ctx.ui.notify(message, type); } catch { /* stale context */ }
  }

  function load(ctx: ExtensionContext) {
    try {
      config = store.load();
      configError = undefined;
      warnedConfigError = undefined;
    } catch (error) {
      configError = safeError(error);
      if (warnedConfigError !== configError) {
        warnedConfigError = configError;
        notify(ctx, `Fast compaction settings are unreadable, so Pi's normal compaction is used. Fix the file or run /compaction reset. ${configError}`, "warning");
      }
    }
  }

  function findSelected(ctx: ExtensionContext, key = config.model): Model<Api> | undefined {
    if (!key) return;
    const { provider, id } = splitModelKey(key);
    return ctx.modelRegistry.find(provider, id);
  }

  function statusLine(ctx: ExtensionContext): { text: string; tone: Tone } {
    if (active) {
      const parts = [`Cmp: ${active.label}`];
      if (active.route !== "fast") parts.push(active.route === "other-extension" ? "extension" : active.route);
      if (active.retry) parts.push(`retry ${active.retry}`);
      if (active.condensed) parts.push("condensing");
      parts.push(`compacting ${formatDuration(now() - active.started)}`);
      if (active.streamed > 0) parts.push(`~${formatTokens(Math.round(active.streamed / 4))} tokens`);
      return { text: parts.join(" · "), tone: active.route === "fallback" ? "warning" : "accent" };
    }
    let tone: Tone = "dim";
    let text: string;
    if (configError) {
      tone = "warning";
      text = "Cmp: settings error · main";
    } else if (!config.enabled) {
      text = "Cmp: off";
    } else if (!config.model) {
      text = "Cmp: choose model · main";
    } else {
      const model = findSelected(ctx);
      if (model) {
        // The level actually sent: models with a reasoning floor or ceiling clamp the request.
        text = `Cmp: ${safeLabel(model.name || model.id)} · ${effectiveThinking(model, config.thinking)}${config.scope === "auto" ? " · auto only" : ""}`;
      } else {
        tone = "warning";
        // With fallback off, a missing model cancels compaction rather than using the main model.
        text = `Cmp: ${safeLabel(splitModelKey(config.model).id)} missing · ${config.fallback ? "main" : "fallback off"}`;
      }
    }
    if (last) {
      text += ` · ${last.outcome === "success" ? "last" : last.outcome} ${formatDuration(last.durationMs)}${last.route === "fallback" ? " (fallback)" : ""}`;
      if (last.outcome === "failed" || last.route === "fallback") tone = "warning";
    }
    return { text, tone };
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  /**
   * The status segment is cosmetic: it must never throw into a compaction, or out of the
   * one-second timer (an uncaught exception there would take down the whole Pi process).
   */
  function render(ctx: ExtensionContext): boolean {
    try {
      if (!ctx.hasUI) {
        stopTimer();
        return true;
      }
      if (!config.showStatus) {
        stopTimer();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return true;
      }
      const { text, tone } = statusLine(ctx);
      ctx.ui.setStatus(STATUS_KEY, ctx.mode === "tui" ? ctx.ui.theme.fg(tone, text) : text);
      // Elapsed time refreshes every second while a compaction runs (terminal only).
      if (active && ctx.mode === "tui") {
        if (!timer) {
          timer = setInterval(() => render(ctx), 1000);
          timer.unref?.();
        }
      } else stopTimer();
      return true;
    } catch {
      stopTimer();
      return false;
    }
  }

  function begin(ctx: ExtensionContext, reason: RunRecord["reason"]): Run {
    const run: Run = {
      started: now(), route: "main", model: ctx.model ? modelKey(ctx.model) : "main",
      label: safeLabel(ctx.model?.name || ctx.model?.id || "main"),
      thinking: ctx.thinkingLevel ?? "off", reason, targetWords: 0, streamed: 0,
    };
    active = run;
    lastError = undefined;
    render(ctx);
    return run;
  }

  function record(run: Run, outcome: RunRecord["outcome"], extra: { outputTokens?: number; compactionId?: string } = {}): RunRecord {
    return {
      version: 1, route: run.route, outcome, model: run.model,
      ...(run.servedModel ? { servedModel: run.servedModel } : {}),
      thinking: run.thinking, reason: run.reason, targetWords: run.targetWords,
      durationMs: Math.max(0, now() - run.started), timestamp: new Date(now()).toISOString(),
      ...(Number.isSafeInteger(extra.outputTokens) ? { outputTokens: extra.outputTokens } : {}),
      ...(run.condensed ? { condensed: true } : {}),
      ...(extra.compactionId ? { compactionId: safeLabel(extra.compactionId, 64) } : {}),
    };
  }

  /**
   * Pi reports "Already compacted" (and skips repeated threshold compaction) only while a
   * compaction is the last entry. Never write our metadata directly after one: queue it until
   * another entry (the next prompt or response) has followed.
   */
  function canWrite(ctx: ExtensionContext): boolean {
    return ctx.sessionManager.getLeafEntry()?.type !== "compaction";
  }

  function flushPending(ctx: ExtensionContext) {
    try {
      while (pending.length && canWrite(ctx)) {
        pi.appendEntry(STATS_TYPE, pending[0]);
        pending.shift();
      }
    } catch {
      // Metadata only, and the session is likely being torn down.
      pending.length = 0;
    }
  }

  function persist(ctx: ExtensionContext, value: RunRecord) {
    // Metadata only: no prompts, credentials, summaries, or provider error bodies.
    pending.push(value);
    flushPending(ctx);
  }

  /**
   * After a successful compaction the TUI clears and redraws the chat, which would erase a
   * notice shown during it. Deliver it right after that redraw instead.
   */
  function noticeAfterCompaction(ctx: ExtensionContext, message: string, type: "info" | "warning") {
    if (ctx.mode !== "tui") {
      notify(ctx, message, type);
      return;
    }
    const handle = setTimeout(() => notify(ctx, message, type), 0);
    handle.unref?.();
  }

  function restore(entries: SessionEntry[]) {
    last = undefined;
    let compactionId: string | undefined;
    for (const entry of entries) {
      if (entry.type === "compaction") {
        compactionId = entry.id;
        // A compaction without our metadata clears the display rather than showing an older result.
        last = embeddedRecord(entry.details);
      } else if (entry.type === "custom" && entry.customType === STATS_TYPE) {
        const value = readRunRecord(entry.data);
        // A deferred record names its compaction; one written after a newer compaction is stale.
        if (value && (value.compactionId === undefined || value.compactionId === compactionId)) last = value;
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
    if (ctx.model && ctx.model.contextWindow > 0 && model.contextWindow > 0 && model.contextWindow < ctx.model.contextWindow) {
      warnings.push(`its ${describeContext(model.contextWindow)} is smaller than the coding model's ${describeContext(ctx.model.contextWindow)}; very large compactions may fall back`);
    }
    return warnings;
  }

  /** Thinking the selected model will actually use, for display and advice. */
  function usedThinking(ctx: ExtensionContext): Thinking {
    const model = config.model ? findSelected(ctx) : undefined;
    return model ? effectiveThinking(model, config.thinking) : config.thinking;
  }

  function confirm(ctx: ExtensionContext, message: string, withAdvice = false) {
    const advice = withAdvice ? sizingAdvice(config, usedThinking(ctx)) : undefined;
    notify(ctx, advice ? `${message}\nWarning: ${advice}` : message, advice ? "warning" : "info");
  }

  function limitLabel(seconds: number) {
    return seconds ? formatDuration(seconds * 1000) : "off";
  }

  function status(ctx: ExtensionContext) {
    load(ctx);
    const model = config.model ? findSelected(ctx) : undefined;
    const thinking = model ? effectiveThinking(model, config.thinking) : config.thinking;
    const lines = [
      `Fast compaction: ${!config.enabled ? "off (normal Pi compaction)" : config.model ? "on" : "on, but no model selected (normal Pi compaction)"}`,
      `Model: ${config.model ?? "not selected — normal Pi compaction until selected"}`,
      `Thinking: ${config.thinking}${thinking !== config.thinking ? ` (this model uses ${thinking})` : ""} — independent of coding-model thinking`,
      `Scope: ${config.scope === "both" ? "automatic and manual" : "automatic only"}`,
      `Prose target: ${config.targetWords || "off"} words (soft; file lists excluded)`,
      `Output cap: ${config.maxOutputTokens} tokens per request, including thinking`,
      `Time limit: ${config.timeoutSeconds ? `${limitLabel(config.timeoutSeconds)} for the selected model, retries included` : "off (only Pi's HTTP timeouts apply)"}`,
      `Fallback: ${config.fallback ? "main model" : "cancel; do not replace context"}`,
      `Status bar: ${config.showStatus ? "on" : "off"}`,
      `Settings: ${store.path}`,
    ];
    if (config.model) {
      if (model) {
        lines.push(`Effective thinking: ${thinking} · ${describeContext(model.contextWindow)}`);
        for (const warning of modelWarnings(ctx, model)) lines.push(`Warning: ${warning}`);
      } else {
        lines.push(`Warning: the selected model is missing from Pi's registry; ${config.fallback ? "normal Pi compaction is used" : "compaction is cancelled because fallback is off"}.`);
      }
    }
    const advice = sizingAdvice(config, thinking);
    if (advice) lines.push(`Warning: ${advice}`);
    if (active) lines.push(`Running: ${active.model} · ${active.route} · ${formatDuration(now() - active.started)}`);
    if (last) {
      const tokens = last.outputTokens !== undefined ? ` · ${formatTokens(last.outputTokens)} output tokens` : "";
      lines.push(`Last: ${last.outcome} · ${last.route} · ${last.model} · ${last.thinking} · ${formatDuration(last.durationMs)}${tokens}${last.condensed ? " · condensed retry" : ""} · ${last.timestamp}`);
      if (last.servedModel) lines.push(`Served model (reported by response): ${last.servedModel}`);
    }
    if (lastError) lines.push(`Last error: ${lastError}`);
    if (configError) lines.push(`Settings error: ${configError} (run /compaction reset to replace the file with defaults)`);
    notify(ctx, lines.join("\n"), "info");
    render(ctx);
  }

  /** An exact provider/modelId from Pi's registry, or undefined for a partial name. */
  function exactModelKey(ctx: ExtensionContext, text: string): string | undefined {
    try { return findSelected(ctx, text) ? text : undefined; } catch { return undefined; }
  }

  async function changeModel(ctx: ExtensionCommandContext, value?: string) {
    let chosen = value ? exactModelKey(ctx, value) : undefined;
    let refreshed = false;
    if (value && !chosen && value.includes("/")) {
      // Possibly just added to models.json.
      await refreshLocalModels(ctx);
      refreshed = true;
      chosen = exactModelKey(ctx, value);
    }
    // A partial or mistyped ID opens the picker pre-filtered; nothing is selected silently.
    chosen ??= await pickModel(ctx, config.model, value, { refresh: !refreshed });
    if (!chosen) return;
    const model = findSelected(ctx, chosen);
    if (!model) throw new Error(`Unknown chat model: ${safeLabel(chosen, 120)}. Use /compaction model to choose from Pi's registry.`);
    update(ctx, { model: chosen });
    const warnings = modelWarnings(ctx, model);
    const advice = sizingAdvice(config, effectiveThinking(model, config.thinking));
    const lines = [`Compaction model: ${safeLabel(model.name || model.id)} (${safeLabel(chosen, 120)}) · ${describeContext(model.contextWindow)}. Coding model unchanged.`];
    if (!config.enabled) lines.push("Fast compaction is off: turn it on with /compaction on.");
    if (warnings.length) lines.push(`Warning: ${warnings.join("; ")}.`);
    if (advice) lines.push(`Warning: ${advice}`);
    notify(ctx, lines.join("\n"), warnings.length || advice ? "warning" : "info");
  }

  /** A value from the arguments, a selector (UI), or a usage error (no UI). */
  async function choose(ctx: ExtensionCommandContext, title: string, options: readonly string[], value?: string) {
    if (value) return value.toLowerCase();
    if (!ctx.hasUI) throw new Error(`${title}: ${options.join(" | ")}`);
    return ctx.ui.select(title, [...options]);
  }

  /** Free-form value from the arguments, an input box (UI), or a usage error (no UI). */
  async function ask(ctx: ExtensionCommandContext, title: string, placeholder: string, usage: string, value?: string) {
    if (value) return value;
    if (!ctx.hasUI) throw new Error(usage);
    return (await ctx.ui.input(title, placeholder))?.trim() || undefined;
  }

  function setEnabled(ctx: ExtensionCommandContext, enabled: boolean) {
    update(ctx, { enabled });
    if (!enabled) {
      confirm(ctx, "Fast compaction off: Pi's normal compaction is used. Pi auto-compaction itself is unchanged.");
    } else if (!config.model) {
      notify(ctx, "Fast compaction on, but no model is selected yet: choose one with /compaction model. Pi's normal compaction is used until then.", "warning");
    } else {
      const model = findSelected(ctx);
      confirm(ctx, `Fast compaction on: ${model ? safeLabel(model.name || model.id) : config.model}${model ? "" : " (missing from Pi's registry)"}.`);
    }
  }

  async function setThinking(ctx: ExtensionCommandContext, value?: string) {
    const level = await choose(ctx, `Compaction thinking (current: ${config.thinking}; never inherits coding-model thinking)`, THINKING_LEVELS, value);
    if (!level) return;
    update(ctx, { thinking: level as Thinking });
    const used = usedThinking(ctx);
    confirm(ctx, `Compaction thinking: ${config.thinking}${used !== config.thinking ? ` (the selected model uses ${used})` : ""}.`, true);
  }

  async function setScope(ctx: ExtensionCommandContext, value?: string) {
    const scope = await choose(ctx, `Apply the selected model to (current: ${config.scope})`, VALUE_CHOICES.scope, value);
    if (!scope) return;
    update(ctx, { scope: scope as Config["scope"] });
    confirm(ctx, `Scope: ${config.scope === "both" ? "automatic and manual compaction" : "automatic compaction only; /compact uses Pi's normal compaction"}.`);
  }

  async function setWords(ctx: ExtensionCommandContext, value?: string) {
    const text = await ask(ctx, `Soft word target (500–20000, or off; current: ${config.targetWords || "off"})`, String(config.targetWords || "off"),
      "Use /compaction words 3000 (500–20000) or /compaction words off.", value);
    if (!text) return;
    update(ctx, { targetWords: text.toLowerCase() === "off" ? 0 : parseCount(text) });
    confirm(ctx, `Prose target: ${config.targetWords ? `about ${config.targetWords} words (soft)` : "off (concise checkpoint)"}.`, true);
  }

  async function setTokens(ctx: ExtensionCommandContext, value?: string) {
    const text = await ask(ctx, `Output token cap per request (2048–131072; current: ${config.maxOutputTokens})`, String(config.maxOutputTokens),
      "Use /compaction tokens 16384 (2048–131072; 16k also works).", value);
    if (!text) return;
    update(ctx, { maxOutputTokens: parseCount(text) });
    confirm(ctx, `Output cap: ${config.maxOutputTokens} tokens per request, including thinking.`, true);
  }

  async function setTimeLimit(ctx: ExtensionCommandContext, value?: string) {
    const text = await ask(ctx, `Time limit for the selected model (${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max}s, or off; current: ${limitLabel(config.timeoutSeconds)})`,
      String(config.timeoutSeconds || "off"), `Use /compaction timeout 300 (${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max} seconds; 90s and 5m also work) or /compaction timeout off.`, value);
    if (!text) return;
    update(ctx, { timeoutSeconds: parseSeconds(text) });
    confirm(ctx, config.timeoutSeconds
      ? `Time limit: ${limitLabel(config.timeoutSeconds)} for the selected model, retries included; then ${config.fallback ? "Pi's normal compaction takes over" : "compaction is cancelled (fallback is off)"}.`
      : "Time limit: off. Only Pi's HTTP timeouts apply to the selected model.");
  }

  async function setSwitch(ctx: ExtensionCommandContext, command: "fallback" | "bar", value?: string) {
    const current = command === "fallback" ? config.fallback : config.showStatus;
    const choice = await choose(ctx, `${command === "fallback" ? "Main-model fallback" : "Status segment"} (current: ${current ? "on" : "off"})`, ["on", "off"], value);
    if (!choice) return;
    const enabled = parseSwitch(choice, command);
    update(ctx, command === "fallback" ? { fallback: enabled } : { showStatus: enabled });
    if (command === "bar") confirm(ctx, `Status segment: ${enabled ? "on" : "off"}.`);
    else confirm(ctx, enabled ? "Fallback: on. If the selected model fails, Pi's normal compaction runs." : "Fallback: off. If the selected model fails, compaction is cancelled and nothing is saved.");
  }

  function trigger(ctx: ExtensionCommandContext, main: boolean, focus?: string) {
    if (!ctx.isIdle() || active || manualPending) throw new Error("Wait until the agent and any compaction are idle before compacting manually.");
    manualPending = true;
    manualFailureReported = false;
    forceMainOnce = main;
    const reset = () => { manualPending = false; forceMainOnce = false; };
    try {
      ctx.compact({
        customInstructions: focus,
        onComplete: reset,
        // Pi runs this inside a detached promise: it must not throw.
        onError: (error) => {
          reset();
          if (!manualFailureReported) notify(ctx, `Compaction did not complete: ${safeError(error)}`, "warning");
        },
      });
    } catch (error) {
      reset();
      throw error;
    }
  }

  async function resetSettings(ctx: ExtensionCommandContext) {
    if (ctx.hasUI && !await ctx.ui.confirm("Reset fast compaction settings?", "Restores defaults. The compaction model is cleared, so normal Pi compaction is used until you choose one.")) return;
    config = store.reset();
    configError = undefined;
    warnedConfigError = undefined;
    render(ctx);
    notify(ctx, "Fast compaction settings reset. Choose a model with /compaction model.", "info");
  }

  async function menu(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) { status(ctx); notify(ctx, HELP, "info"); return; }
    for (;;) {
      load(ctx);
      const entries: { label: string; run: () => unknown; closes?: boolean }[] = [
        { label: `Enabled: ${config.enabled ? "on" : "off"}`, run: () => setEnabled(ctx, !config.enabled) },
        { label: `Model: ${config.model ?? "choose model"}`, run: () => changeModel(ctx) },
        { label: `Thinking: ${config.thinking}`, run: () => setThinking(ctx) },
        { label: `Scope: ${config.scope}`, run: () => setScope(ctx) },
        { label: `Prose target: ${config.targetWords ? `${config.targetWords} words` : "off"}`, run: () => setWords(ctx) },
        { label: `Output cap: ${config.maxOutputTokens} tokens`, run: () => setTokens(ctx) },
        { label: `Time limit: ${limitLabel(config.timeoutSeconds)}`, run: () => setTimeLimit(ctx) },
        { label: `Fallback: ${config.fallback ? "on" : "off"}`, run: () => setSwitch(ctx, "fallback", config.fallback ? "off" : "on") },
        { label: `Status bar: ${config.showStatus ? "on" : "off"}`, run: () => setSwitch(ctx, "bar", config.showStatus ? "off" : "on") },
        { label: "Compact now", run: () => trigger(ctx, false), closes: true },
        { label: "Compact with main model once", run: () => trigger(ctx, true), closes: true },
        { label: "Show status", run: () => status(ctx) },
        { label: "Reset settings", run: () => resetSettings(ctx) },
        { label: "Done", run: () => undefined, closes: true },
      ];
      const selected = await ctx.ui.select("Fast compaction — global settings", entries.map((entry) => entry.label));
      const entry = entries.find((candidate) => candidate.label === selected);
      if (!entry) return;
      try {
        await entry.run();
        if (entry.closes) return;
      } catch (error) {
        notify(ctx, describeError(error), "error");
      }
    }
  }

  function describeError(error: unknown): string {
    // The hint goes first, so a long path or parser message cannot truncate it away.
    return error instanceof ConfigFileError
      ? `The settings file is unreadable; fix it or run /compaction reset to replace it with defaults. ${safeError(error)}`
      : safeError(error);
  }

  async function handle(args: string, ctx: ExtensionCommandContext) {
    load(ctx);
    const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
    const command = (match?.[1] ?? "").toLowerCase();
    const value = match?.[2]?.trim() || undefined;
    switch (command) {
      case "": return menu(ctx);
      case "help": return notify(ctx, HELP, "info");
      case "status": return status(ctx);
      case "reset": return resetSettings(ctx);
      case "now":
      case "main": return trigger(ctx, command === "main", value);
      case "model": return changeModel(ctx, value);
      case "on":
      case "off":
        if (value) throw new Error(`Use /compaction ${command} without extra arguments.`);
        return setEnabled(ctx, command === "on");
      case "thinking": return setThinking(ctx, value);
      case "scope": return setScope(ctx, value);
      case "words": return setWords(ctx, value);
      case "tokens": return setTokens(ctx, value);
      case "timeout": return setTimeLimit(ctx, value);
      case "fallback":
      case "bar": return setSwitch(ctx, command, value);
      default: {
        const hint = suggestSubcommand(command);
        throw new Error(`Unknown command "${safeLabel(command, 40)}".${hint ? ` Did you mean /compaction ${hint}?` : ""} See /compaction help.`);
      }
    }
  }

  function completions(argumentPrefix: string): AutocompleteItem[] | null {
    // Pi replaces the whole argument text with the chosen value, so leading spaces can be dropped.
    const prefix = argumentPrefix.trimStart();
    const space = prefix.indexOf(" ");
    if (space < 0) {
      const lower = prefix.toLowerCase();
      const items = SUBCOMMANDS.filter(([name]) => name.startsWith(lower))
        .map(([name, args, description]) => ({ value: args ? `${name} ` : name, label: name, description }));
      return items.length ? items : null;
    }
    const command = prefix.slice(0, space).toLowerCase();
    const partial = prefix.slice(space + 1).trimStart();
    if (command === "model") {
      let models: Model<Api>[] = [];
      try { models = registry?.getAvailable() ?? []; } catch { /* registry unavailable */ }
      const items = fuzzyFilter(models, partial, (m) => `${modelKey(m)} ${m.name}`).slice(0, 30)
        .map((m) => ({ value: `model ${modelKey(m)}`, label: modelKey(m), description: `${safeLabel(m.name || m.id)} · ${describeContext(m.contextWindow)}` }));
      return items.length ? items : null;
    }
    const items = (VALUE_CHOICES[command] ?? []).filter((value) => value.startsWith(partial.toLowerCase()))
      .map((value) => ({ value: `${command} ${value}`, label: value }));
    return items.length ? items : null;
  }

  pi.registerCommand("compaction", {
    description: "Choose compaction model, reasoning, on/off, summary size, time limit, fallback and status",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      try {
        await handle(args, ctx);
      } catch (error) {
        notify(ctx, describeError(error), "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    registry = ctx.modelRegistry;
    hintedNoModel = false;
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
  pi.on("before_agent_start", (_event, ctx) => { flushPending(ctx); load(ctx); render(ctx); });
  pi.on("turn_start", (_event, ctx) => { flushPending(ctx); });
  pi.on("agent_end", (_event, ctx) => { flushPending(ctx); });
  pi.on("agent_settled", (_event, ctx) => { flushPending(ctx); });
  pi.on("model_select", (_event, ctx) => { render(ctx); });

  async function runFast(event: SessionBeforeCompactEvent, ctx: ExtensionContext, snapshot: Config, run: Run): Promise<CompactionResult> {
    if (!snapshot.model) throw new Error("No compaction model selected. Use /compaction model.");
    const model = findSelected(ctx, snapshot.model);
    if (!model) throw new Error(`The selected compaction model ${safeLabel(snapshot.model, 120)} is not in Pi's model registry. Choose another with /compaction model.`);
    let thinking = effectiveThinking(model, snapshot.thinking);
    Object.assign(run, { route: "fast", model: modelKey(model), label: safeLabel(model.name || model.id), thinking, targetWords: snapshot.targetWords });
    render(ctx);

    // One time budget for everything the selected model does: requests, retries, condensed retry.
    // Without it, a stalled provider can block compaction for Pi's HTTP idle timeout per attempt.
    const limit = new AbortController();
    const signal = AbortSignal.any([event.signal, limit.signal]);
    let timedOut = false;
    // Not unref'd: this timer is what resolves a stall, so it must keep the process alive.
    // It is bounded and always cleared when the run settles.
    const deadline = snapshot.timeoutSeconds > 0
      ? setTimeout(() => { timedOut = true; limit.abort(); }, snapshot.timeoutSeconds * 1000)
      : undefined;
    const stopIfInterrupted = () => {
      // Only Pi's compaction signal means the user cancelled. A time-out is a failure.
      if (event.signal.aborted) throw abortError();
      if (timedOut) {
        throw new Error(`${run.label} did not finish within ${limitLabel(snapshot.timeoutSeconds)}. Raise the limit with /compaction timeout if this model is just slow.`);
      }
    };

    let hitLength = false;
    const usages: Usage[] = [];
    const stream: StreamFn = (requestedModel, context, options) => {
      stopIfInterrupted();
      const budget = outputBudget(context, requestedModel, snapshot);
      run.streamed = 0;
      // Token-budget adapters may add thinking to maxTokens. Bound the model cap too,
      // without mutating the shared registry model or the coding model.
      const request = ctx.modelRegistry.streamSimple({ ...requestedModel, maxTokens: budget }, context, {
        ...options,
        // Pi represents disabled thinking as undefined; adapters then send their explicit "off".
        reasoning: thinking === "off" ? undefined : thinking,
        thinkingBudgets: THINKING_BUDGETS,
        maxTokens: budget,
        signal,
        cacheRetention: "none",
      });
      observe(request, run);
      const result = request.result.bind(request);
      request.result = async () => {
        let response;
        try {
          response = await untilAborted(result(), signal);
        } catch (error) {
          stopIfInterrupted();
          throw error;
        }
        if (response.usage) usages.push(response.usage);
        stopIfInterrupted();
        if (response.stopReason === "aborted") throw new Error("The provider aborted the compaction request.");
        if (response.stopReason === "length") hitLength = true;
        if (!["stop", "error", "length"].includes(response.stopReason)) {
          throw new Error(`The compaction response is not final (${response.stopReason}).`);
        }
        if (response.stopReason === "stop" && !response.content.some((block) => block.type === "text" && block.text.trim())) {
          throw new Error("The compaction model returned an empty summary.");
        }
        if (response.provider && response.model) run.servedModel = safeLabel(`${response.provider}/${response.model}`, 160);
        return response;
      };
      return request;
    };
    const callbacks: RetryCallbacks = {
      onRetryScheduled: (attempt, max) => { run.retry = `${attempt}/${max}`; render(ctx); },
      onRetryFinished: () => { run.retry = undefined; render(ctx); },
    };
    const attempt = async (condensed: boolean) => {
      const result = await summarize(
        event.preparation, model, undefined, undefined,
        buildInstructions(snapshot, event.preparation, event.customInstructions, condensed), signal,
        thinking, stream, undefined, retry, callbacks,
      );
      stopIfInterrupted();
      const problem = checkpointProblem(result.summary);
      if (problem) throw new Error(problem);
      return result;
    };
    try {
      let result: CompactionResult;
      try {
        result = await attempt(false);
      } catch (error) {
        // Hitting the output cap is deterministic: retrying the same prompt would hit it again.
        // One firmer, shorter attempt with the fast model is still far cheaper than the main model.
        if (!hitLength || event.signal.aborted || timedOut) throw error;
        hitLength = false;
        thinking = reducedThinking(model, thinking);
        Object.assign(run, { condensed: true, thinking });
        render(ctx);
        result = await attempt(true);
      }
      run.outputTokens = result.usage?.output;
      // Session totals should include every attempt of this checkpoint, e.g. a discarded over-length one.
      return { ...result, usage: usages.length ? usages.reduce(addUsage) : result.usage };
    } finally {
      clearTimeout(deadline);
    }
  }

  pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
    load(ctx);
    // Do this even when disabled or falling back, to preserve cumulative files in native compaction.
    carryFileOperations(event);
    const run = begin(ctx, event.reason);
    const mainOnce = event.reason === "manual" && forceMainOnce;
    if (mainOnce) forceMainOnce = false;
    if (configError || !config.enabled || mainOnce || (config.scope === "auto" && event.reason === "manual")) return;
    if (!config.model) {
      // Not configured yet: nothing failed, so this is neither a fallback nor a reason to cancel.
      if (!hintedNoModel) run.hint = "Fast compaction has no model selected yet, so Pi's normal compaction was used. Choose one with /compaction model.";
      return;
    }
    const snapshot = { ...config };
    if (event.signal.aborted) return { cancel: true };
    try {
      const result = await runFast(event, ctx, snapshot, run);
      const details = result.details && typeof result.details === "object" ? result.details : {};
      return { compaction: { ...result, details: { ...details, [DETAILS_KEY]: record(run, "success", { outputTokens: run.outputTokens }) } } };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      run.error = lastError = safeError(error);
      if (!snapshot.fallback) {
        run.policyFailure = true;
        notify(ctx, `Fast compaction failed; no summary saved. ${run.error}`, "error");
        return { cancel: true };
      }
      Object.assign(run, {
        route: "fallback", model: ctx.model ? modelKey(ctx.model) : "main",
        label: safeLabel(ctx.model?.name || ctx.model?.id || "main"),
        thinking: ctx.thinkingLevel ?? "off", targetWords: 0, streamed: 0,
        servedModel: undefined, retry: undefined, condensed: undefined, outputTokens: undefined,
      });
      notify(ctx, `Fast compaction unavailable; falling back to normal Pi compaction. ${run.error}`, "warning");
      render(ctx);
      return;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const run = active;
    active = undefined;
    const embedded = event.fromExtension ? embeddedRecord(event.compactionEntry.details) : undefined;
    if (embedded) {
      last = embedded;
    } else if (run) {
      if (event.fromExtension) run.route = "other-extension";
      last = record(run, "success", { outputTokens: event.compactionEntry.usage?.output, compactionId: event.compactionEntry.id });
      persist(ctx, last);
      if (run.route === "fallback" && run.error && ctx.mode === "tui") {
        noticeAfterCompaction(ctx, `Compacted with the coding model because the fast model failed: ${run.error}`, "warning");
      }
    }
    if (run?.hint && !hintedNoModel) {
      hintedNoModel = true;
      noticeAfterCompaction(ctx, run.hint, "info");
    }
    render(ctx);
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (manualPending && event.reason === "manual") manualFailureReported = true;
    const run = active;
    active = undefined;
    // Without a run, Pi failed before asking extensions (e.g. its overflow-recovery guard) and reports it itself.
    if (run) {
      if (event.errorMessage) {
        lastError = safeError(event.errorMessage);
        run.error ??= lastError;
      }
      last = record(run, run.policyFailure || !event.aborted ? "failed" : "cancelled");
      persist(ctx, last);
    }
    render(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    active = undefined;
    manualPending = false;
    forceMainOnce = false;
    registry = undefined;
    // Save what can be saved safely; anything that would directly follow a compaction is dropped.
    flushPending(ctx);
    pending.length = 0;
    try {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch { /* already torn down */ }
  });
}
