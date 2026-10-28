# pi-fast-compaction

[![CI](https://github.com/sehoon123/pi-fast-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/sehoon123/pi-fast-compaction/actions/workflows/ci.yml)

**Use a separate model for Pi's conversation compaction, without changing your coding model.**

Keep a capable model for coding and choose a faster model for automatic and manual summaries. Control the model, reasoning, on/off state, summary target, fallback, and status bar with `/compaction`.

## Install

Requires **Pi 1.4.0** (or a compatible later version) and Node.js 22.19+.

```sh
pi install git:https://github.com/sehoon123/pi-fast-compaction
```

Run `/reload` in existing sessions. Then:

```text
/compaction model
```

Type to search available chat models, use arrow keys to move, Enter to select, and Escape to cancel. The picker shows providers and context sizes. It does not change the coding model or restrict you to Pi's model-cycling scope. In RPC mode it uses the client's regular selector instead of a terminal component.

Or select an exact model:

```text
/compaction model anthropic/claude-haiku-5-5
/compaction thinking low
/compaction on
```

The provider/model ID must exist in **your** Pi registry. Custom gateways and local providers work too. A model ID may contain slashes, e.g. `openrouter/anthropic/some-model`. There are no built-in credentials or vendor-specific routes.

**No model is selected automatically in a fresh install.** Until you choose one, Pi's normal compaction remains the fallback. This avoids silently choosing a provider for your conversation data.

## Controls

`/compaction` opens the settings menu. Changes save immediately and persist across restarts.

| Command | Behavior |
|---|---|
| `/compaction on` | Enable the separate-model override |
| `/compaction off` | Restore normal Pi compaction; **does not disable auto-compaction** |
| `/compaction model [provider/modelId]` | Search/select a model, or set its exact ID |
| `/compaction thinking [level]` | Independent reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `/compaction scope both` | Use selected model for automatic compaction and `/compact` (default) |
| `/compaction scope auto` | Use selected model only for automatic compaction, including overflow recovery |
| `/compaction words 3000` | Set the soft prose target (500–20000 words) |
| `/compaction words off` | Remove the word target; still request a concise checkpoint |
| `/compaction tokens 16384` | Set the per-request output safety cap (2048–131072 tokens) |
| `/compaction fallback on` | Warn and fall back to normal main-model compaction on failure (default) |
| `/compaction fallback off` | Cancel instead of falling back; never save a failed summary |
| `/compaction bar on` / `bar off` | Show/hide only this extension's status segment |
| `/compaction now [focus]` | Compact now under your configured policy |
| `/compaction main [focus]` | Use Pi's main model **just once**, without changing saved settings |
| `/compaction status` | Show settings, config path, effective thinking, warnings, current run and last result |
| `/compaction reset` | Restore defaults after confirmation; also repairs a malformed settings file |
| `/compaction help` | Command reference |

Tab completion covers subcommands, values such as thinking levels, and available model IDs. Numbers accept `3,000`, `3_000` and `16k`. Selecting a model warns when its provider has no configured credentials or its context window is smaller than the current coding model's.

Pi's built-in `/compact [focus]` continues to work. The extension adds no model-facing tools.

Manual `now` and `main` actions require the agent to be idle. A settings change during a compaction applies to the **next** compaction, not to the in-flight request. The one-shot main-model action does not use the extension's word target or output cap.

## Status bar

The extension uses `ctx.ui.setStatus("fast-compaction", ...)`, so it **does not replace your footer** or other extensions' statuses.

```text
Cmp: Claude Haiku 5.5 · low
Cmp: Claude Haiku 5.5 · compacting 12s
Cmp: Claude Haiku 5.5 · retry 1/2 · compacting 15s
Cmp: Claude Haiku 5.5 · condensing · compacting 40s
Cmp: Claude Haiku 5.5 · low · last 24s
Cmp: Claude Haiku 5.5 · low · last 48s (fallback)
Cmp: Claude Haiku 5.5 · low · auto only
Cmp: claude-haiku-5-5 missing · main
Cmp: off
```

Elapsed time refreshes once per second during compaction, including native/main-model fallback. The last duration covers the whole operation, including a failed fast attempt before fallback. Warnings (fallback, failure, settings error, missing model) use the theme's warning color. RPC clients receive the same text without colors or per-second updates. `/compaction status` shows the route, outcome, requested model, output tokens, model reported by the response when available, and timestamp.

The last result survives `/reload` and follows the session branch. For a summary produced by the selected model, the outcome is stored inside Pi's compaction entry. Other outcomes (native/fallback compaction, failures) are stored as non-context metadata entries. **This metadata never becomes the entry directly after a compaction**: Pi uses that position to report "Already compacted" and to avoid back-to-back threshold compactions. Such records are written when the next turn or prompt starts; a record still waiting when Pi exits or you move in `/tree` is dropped rather than misplaced. Timers stop on completion, failure, cancellation, reload, session replacement, and shutdown. Custom footers must display extension statuses to show this segment.

The idle segment shows the **requested** thinking level. Models with a reasoning floor may clamp it; `/compaction status` also shows the effective level. Provider-reported model IDs are not independent attestations of a gateway's actual serving backend.

## Defaults and summary quality

- Enabled, after you select a model.
- Independent **low** reasoning, not your coding model's `max`.
- Both automatic and manual compaction.
- **3,000-word soft target for summary prose.** Critical details take priority.
- **16,384-token output cap per request**, including thinking where the adapter honors model caps.
- Main-model fallback on; status bar on.

The target is a practical starting point, not a universal optimum or hard word limit. A few thousand words leave room for goals, constraints, decisions, unfinished work, test outcomes, and exact identifiers without rewriting an ever-growing changelog. Small conversations should be much shorter. For complex work, try 4000–6000 words; for simple work, try 1500–2000. Non-English text and code do not map reliably from words to tokens.

The prompt asks the model to consolidate completed work, remove obsolete repetition, preserve critical details, and distinguish verified facts from plans. It never mechanically truncates a completed summary to meet the target. For split turns requiring two summary requests, each request receives half the total prose target.

**File lists are separate and excluded from the prose target.** They are preserved programmatically, not shortened to save words. Large cumulative file lists can still make the final checkpoint large. Reducing the prose target does not reduce those lists.

A smaller summarizer can lose important information, especially over repeated compactions. Recent messages remain verbatim according to your existing Pi retention settings, and source files can be re-read, but these are not guarantees against information loss. Use `/compaction main` for a particularly delicate checkpoint. No large-context quality or latency benchmark is implied by the automated tests.

## Safety and compatibility

The extension delegates to Pi's built-in `compact()` rather than implementing its own cut point or summary format. It preserves:

- `firstKeptEntryId`, recent-message retention and original session history;
- previous-summary updates and split-turn handling;
- cumulative read/modified file tracking, including the next native compaction after turning the override off;
- successful summary usage for Pi's session totals;
- cancellation via the compaction's `AbortSignal`.

Calls go through `ctx.modelRegistry.streamSimple()`: the **selected provider** resolves its own request-time authentication. Main-model credentials are not copied to another provider. One-off summary requests disable cache writes and use Pi's fresh routing IDs. Token-budget providers receive thinking budgets of 1024 tokens for `minimal`/`low` (Anthropic's minimum), 4096 for `medium` and 8192 above; adaptive-thinking providers use their effort setting instead.

Empty output, tool calls, provider errors, truncated (`length`) output, and cancellation are never accepted as successful checkpoints. Before falling back, the selected model gets:

- **up to 2 retries for transient errors** (overloaded, rate limits, 5xx, dropped streams) with short backoff. Non-retryable errors such as authentication failures fall back immediately;
- **one condensed retry when the output cap is hit.** Repeating the same prompt would hit the cap again, so the retry asks for a substantially shorter checkpoint that keeps critical details.

If these fail, control returns to Pi's normal compaction. Only **your** cancellation (Escape) skips fallback; a provider-side abort or timeout counts as a failure and falls back. With fallback disabled, failure cancels compaction, writes no replacement checkpoint, and is recorded as a failure. Usage from failed attempts is not added to Pi's session totals.

Choose a model whose context window can hold the serialized conversation. A conservative byte-based estimate reduces the output budget or falls back when the selected window looks too small; the provider makes the final token-limit decision. **The input is never silently truncated to fit a smaller model.** A 200K summarizer may be unsuitable for a 1M-context coding session. Virtual models and custom adapters may apply their own limits and reasoning behavior.

Nested registry calls use provider implementations, but do **not** emit the main agent's request hooks. Provider-based authentication/key rotation works; an extension that only rewrites top-level request payloads or displays its own routing status may not apply to these nested calls. Prefer a concrete summarizer model over an automatically routed alias when you want a predictable tier. Other compaction overrides follow Pi's handler order; avoid enabling two summarizers at once.

This extension does not change Pi's compaction trigger thresholds, recent-token budgets, global auto-compaction switch, or `/tree` branch summaries. When disabled, keep the extension loaded if you want its status and one-time transfer of its cumulative file metadata into native compaction.

## Settings and privacy

Preferences are saved separately from Pi's settings and credentials:

```text
~/.pi/agent/fast-compaction.json
```

`PI_CODING_AGENT_DIR` changes this location. For an embedded SDK with a custom `agentDir`, also set that environment variable or supply a `ConfigStore` to `installExtension()`.

Example (replace the model with one in your registry):

```json
{
  "version": 1,
  "enabled": true,
  "model": "anthropic/claude-haiku-5-5",
  "thinking": "low",
  "scope": "both",
  "targetWords": 3000,
  "maxOutputTokens": 16384,
  "fallback": true,
  "showStatus": true
}
```

The file uses atomic replacement and restrictive permissions. Each edit re-reads the current file. Settings reload on commands, new agent runs and compaction; an already-idle second Pi window may not refresh its footer until its next event. Simultaneous writes from separate processes are last-writer-wins; there is no cross-process locking. Invalid settings are reported, are not silently overwritten, and defer to normal Pi compaction. Repair the file, or run `/compaction reset` to replace it with defaults.

The model picker shows the cached model list and reloads `models.json` locally, without network catalog refreshes. A slow or failing reload never blocks the picker.

Only preferences and minimal session outcome metadata are stored by this extension; no API keys, raw provider error bodies, or additional prompt copies. Pi still stores its normal session transcript and compaction summary. Error notifications redact common credential forms (bearer tokens, `key=` query parameters, API-key headers, `sk-`/`AIza`/`ghp_` keys, JWTs), but may still contain other provider diagnostics: review terminal logs before sharing them. Persisted metadata is validated and stripped of control, bidi-override and zero-width characters before display. There is no telemetry.

**Changing the compaction provider sends your serialized session context to that provider.** Use a provider you trust, especially for proprietary code. Nothing in your local configuration, credentials, or sessions is published to GitHub by this package.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Tests use synthetic conversations and in-process fixtures: no external model calls, credentials or real user sessions. Coverage includes the actual Pi resource loader and compaction lifecycle, Pi's "Already compacted" guard with the override on and off, native fallback, transient-error and condensed retries, split turns, file tracking across off/on, user versus provider aborts, invalid output, settings persistence and reset, completions, status cleanup, and the searchable picker at narrow widths and with a failing refresh. CI checks Node.js 22 and 24.

## Update / remove

```sh
pi update git:https://github.com/sehoon123/pi-fast-compaction
pi remove git:https://github.com/sehoon123/pi-fast-compaction
```

Run `/reload` afterward. Removing the package does not remove your preferences file or historical session entries.

Load only one copy of the extension. For example, do not combine the installed package with `pi -e ./src/index.ts` during development: both copies would handle compaction.

## License

MIT © SH Jung
