# pi-fast-compaction

[![CI](https://github.com/sehoon123/pi-fast-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/sehoon123/pi-fast-compaction/actions/workflows/ci.yml)

**Use a separate model for Pi's conversation compaction, without changing your coding model.**

Keep a capable model for coding and choose a faster model for automatic and manual summaries. Control the model, reasoning, on/off state, summary target, time limit, fallback, and status bar with `/compaction`.

## Install

Requires **Pi 1.4.0** (or a compatible later version) and Node.js 22.19+.

```sh
pi install git:https://github.com/sehoon123/pi-fast-compaction
```

Run `/reload` in existing sessions. Then:

```text
/compaction model
```

Type to search available chat models, use arrow keys to move, Enter to select, and Escape to cancel. The picker shows providers and context sizes. It does not change the coding model or restrict you to Pi's model-cycling scope. In RPC mode it uses the client's regular selector instead of a terminal component. A partial name such as `/compaction model haiku` opens the picker already filtered; a match is never selected without your confirmation, because the choice decides which provider receives your conversation. Outside interactive mode, the closest matches are listed instead.

Or select an exact model:

```text
/compaction model anthropic/claude-haiku-5-5
/compaction thinking low
/compaction on
```

The provider/model ID must exist in **your** Pi registry. Custom gateways and local providers work too. A model ID may contain slashes, e.g. `openrouter/anthropic/some-model`. There are no built-in credentials or vendor-specific routes.

**No model is selected automatically in a fresh install.** Until you choose one, Pi's normal compaction runs unchanged, without fallback warnings and even with fallback off; you get one hint per session. This avoids silently choosing a provider for your conversation data.

## Controls

`/compaction` opens the settings menu. Changes save immediately and persist across restarts.

| Command | Behavior |
|---|---|
| `/compaction on` | Enable the separate-model override; also resumes a paused model |
| `/compaction off` | Restore normal Pi compaction; **does not disable auto-compaction** |
| `/compaction model [provider/modelId]` | Search/select a model, set its exact ID, or search with a partial name |
| `/compaction thinking [level]` | Independent reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `/compaction scope both` | Use selected model for automatic compaction and `/compact` (default) |
| `/compaction scope auto` | Use selected model only for automatic compaction, including overflow recovery |
| `/compaction words 3000` | Set the soft prose target (500–20000 words) |
| `/compaction words off` | Remove the word target; still request a concise checkpoint |
| `/compaction tokens 16384` | Set the per-request output safety cap (2048–131072 tokens) |
| `/compaction timeout 300` | Time limit for the selected model, retries included (30–3600 s; `90s`, `5m` work too) |
| `/compaction timeout off` | No extension time limit; only Pi's HTTP timeouts apply |
| `/compaction fallback on` | Warn and fall back to normal main-model compaction on failure (default) |
| `/compaction fallback off` | Cancel instead of falling back; never save a failed summary |
| `/compaction bar on` / `bar off` | Show/hide only this extension's status segment |
| `/compaction now [focus]` | Compact now under your configured policy |
| `/compaction main [focus]` | Use Pi's main model **just once**, without changing saved settings |
| `/compaction status` | Show settings, config path, effective thinking, warnings, current run, last result and outcomes on this branch |
| `/compaction reset` | Restore defaults after confirmation; also repairs a malformed settings file |
| `/compaction help` | Command reference |

- Subcommands and setting values are case-insensitive (exact model IDs are not; a partial name searches case-insensitively). A typo gets a suggestion: `/compaction thnking` → *Did you mean /compaction thinking?*
- Without a value, `thinking`, `scope`, `fallback` and `bar` open a selector, and `words`, `tokens` and `timeout` ask for input.
- Numbers accept `3,000`, `3_000` and `16k`; durations accept `300`, `90s` and `5m`.
- Tab completion covers subcommands, values such as thinking levels, and available model IDs.

Every change confirms what it did. Selecting a model warns when its provider has no configured credentials or its context window is smaller than the current coding model's. Settings that cannot fit together, e.g. a 20,000-word target under a 16K output cap, are flagged when you change them and in `/compaction status`.

Pi's built-in `/compact [focus]` continues to work. The extension adds no model-facing tools.

Manual `now` and `main` actions require the agent to be idle. A settings change during a compaction applies to the **next** compaction, not to the in-flight request. The one-shot main-model action does not use the extension's word target, output cap or time limit.

## Status bar

The extension uses `ctx.ui.setStatus("fast-compaction", ...)`, so it **does not replace your footer** or other extensions' statuses.

```text
Cmp: Claude Haiku 5.5 · low
Cmp: Claude Haiku 5.5 · compacting 12s · ~1.8K tokens
Cmp: Claude Haiku 5.5 · retry 1/2 · compacting 15s
Cmp: Claude Haiku 5.5 · condensing · compacting 40s
Cmp: Claude Opus 5.5 · fallback · compacting 1m05s
Cmp: Claude Haiku 5.5 · low · last 24s
Cmp: Claude Haiku 5.5 · low · last 48s (fallback)
Cmp: Claude Haiku 5.5 · low · auto only
Cmp: Claude Haiku 5.5 · paused until 14:05 · main
Cmp: choose model · main
Cmp: claude-haiku-5-5 missing · main
Cmp: claude-haiku-5-5 missing · fallback off
Cmp: off
```

`main` means Pi's normal compaction with the coding model will be used. A missing model with fallback off shows `fallback off` instead, because compaction is then cancelled. Elapsed time refreshes once per second during compaction, including native/main-model fallback. While the selected model streams, an approximate token count shows that it is making progress rather than stalled. The last duration covers the whole operation, including a failed fast attempt before fallback. Warnings (fallback, failure, settings error, missing model) use the theme's warning color. Pi redraws the chat when a compaction completes, which would erase a warning shown during it, so the reason for a fallback is repeated right after the redraw. RPC clients receive the same text without colors or per-second updates, and only when it changes. `/compaction status` shows the route, outcome, requested model, output tokens, model reported by the response when available, and how long ago it happened, plus the outcomes on this branch, e.g. `This branch: 5 fast (avg 21s) · 1 fallback (avg 1m40s)`.

The last result survives `/reload` and follows the session branch. For a summary produced by the selected model, the outcome is stored inside Pi's compaction entry. Other outcomes (native/fallback compaction, failures) are stored as non-context metadata entries. **This metadata never becomes the entry directly after a compaction**: Pi uses that position to report "Already compacted" and to avoid back-to-back threshold compactions. Such records wait until another entry has followed the compaction, and are written after the next response; each names the compaction it describes, so a late record never overrides a newer result. A record still waiting when Pi exits right after compacting, or when you move in `/tree`, is dropped rather than misplaced. Timers stop on completion, failure, cancellation, reload, session replacement, and shutdown, and a failing status display can never take Pi down. Custom footers must display extension statuses to show this segment.

The idle segment shows the thinking level **actually sent**: a model with a reasoning floor or ceiling clamps the requested level, and a non-reasoning model shows `off`. `/compaction status` and `/compaction thinking` show both levels. Provider-reported model IDs are not independent attestations of a gateway's actual serving backend.

## Defaults and summary quality

- Enabled, after you select a model.
- Independent **low** reasoning, whatever the coding model's level.
- Both automatic and manual compaction.
- **3,000-word soft target for summary prose.** Critical details take priority.
- **16,384-token output cap per request**, including thinking where the adapter honors model caps.
- **5-minute time limit** for the selected model, covering requests, retries and the condensed retry.
- Main-model fallback on; status bar on.

The target is a practical starting point, not a universal optimum or hard word limit. A few thousand words leave room for goals, constraints, decisions, unfinished work, test outcomes, and exact identifiers without rewriting an ever-growing changelog. Small conversations should be much shorter. For complex work, try 4000–6000 words; for simple work, try 1500–2000. Non-English text and code do not map reliably from words to tokens.

The prompt asks the model to consolidate completed work, remove obsolete repetition, preserve critical details, and distinguish verified facts from plans. It never mechanically truncates a completed summary to meet the target. For split turns requiring two summary requests, each request receives half the total prose target, and both run at once (see below).

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

**Split turns are summarized in parallel.** When the cut point falls inside the current turn — common in long agentic turns — Pi needs two summaries: the earlier history and the start of the turn. Pi requests them one after the other, although the second never sees the first. The extension runs both through Pi's own `compact()` at once and joins them exactly where Pi would, so the checkpoint is byte-identical to Pi's and arrives sooner. A failure of one half cancels the other, and Pi's own sequence is then tried once, so a gateway that rejects concurrent requests still works; after a rate or concurrency limit error, the rest of the session stays sequential. Should a future Pi change the split-turn format, the extension detects it and uses Pi's sequence.

Empty output, tool calls, provider errors, truncated (`length`) output, and cancellation are never accepted as successful checkpoints. Before falling back, the selected model gets:

- **up to 2 retries for transient errors** (overloaded, rate limits, 5xx, dropped streams) with short backoff. Non-retryable errors such as authentication failures fall back immediately;
- **one condensed retry when the output cap is hit.** Repeating the same prompt would hit the cap again, so the retry asks for a substantially shorter checkpoint that keeps critical details, and thinks no harder than `low`, since reasoning shares the cap.

If these fail, control returns to Pi's normal compaction. Only **your** cancellation (Escape) skips fallback; a provider-side abort or timeout counts as a failure and falls back.

**Time limit.** Without one, a stalled provider could hold compaction for Pi's HTTP idle timeout on every attempt — easily many minutes. The selected model gets `timeout` seconds in total (default 300); then its request is aborted and, without further retries, Pi's normal compaction takes over (with fallback off, compaction is cancelled instead). Escape and the limit both take effect immediately, even with an adapter that ignores cancellation. Slow local summarizers may need `/compaction timeout 900` or `off`. The limit does not apply to Pi's own (fallback) compaction.

**Pause after failures.** During an outage, every compaction would otherwise wait for the time limit again. After a time-out, or after 3 failed runs in a row, the selected model is paused for 10 minutes (doubling with each further pause, up to an hour): automatic compactions go straight to Pi's normal compaction, and the status bar shows `paused until 14:05`. A manual compaction (`/compact` or `/compaction now`) still tries the selected model, and a success or any settings change, such as `/compaction on`, resumes it. With fallback off there is no alternative, so nothing is paused. The pause is kept in memory: `/reload` or switching sessions clears it.

**Implausible replies are rejected.** Some providers report a refusal as ordinary text with a normal stop. A reply that has no Markdown heading and fewer than 400 characters is treated as a failure, not saved as the checkpoint of your whole conversation.

With fallback disabled, failure cancels compaction, writes no replacement checkpoint, and is recorded as a failure. When the selected model succeeds, the compaction's usage covers all of its attempts, including a discarded over-length one; usage of a selected-model run that ended in fallback is not added to Pi's session totals.

Choose a model whose context window can hold the serialized conversation. A conservative byte-based estimate reduces the output budget or falls back when the selected window looks too small; the provider makes the final token-limit decision. **The input is never silently truncated to fit a smaller model.** A 200K summarizer may be unsuitable for a 1M-context coding session. Limits reported as 0 (unknown, e.g. virtual models) are not enforced by the extension; virtual models and custom adapters apply their own limits and reasoning behavior.

Nested registry calls use provider implementations, but do **not** emit the main agent's request hooks. Provider-based authentication/key rotation works; an extension that only rewrites top-level request payloads or displays its own routing status may not apply to these nested calls. Prefer a concrete summarizer model over an automatically routed alias when you want a predictable tier. Other compaction overrides follow Pi's handler order; avoid enabling two summarizers at once. If this Pi version's compaction API differs from what the extension expects, it uses Pi's normal compaction and says so once, rather than failing on every compaction.

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
  "timeoutSeconds": 300,
  "fallback": true,
  "showStatus": true
}
```

The file uses atomic, flushed replacement and restrictive permissions; a symlinked file (dotfile managers) stays a symlink, and a byte order mark from a Windows editor is accepted. Each edit re-reads the current file. Files from 0.2.0 load unchanged, with the new time limit at its default. Settings reload on commands, new agent runs and compaction; an already-idle second Pi window may not refresh its footer until its next event. Simultaneous writes from separate processes are last-writer-wins; there is no cross-process locking. Invalid settings are reported, are not silently overwritten, and defer to normal Pi compaction. Repair the file, or run `/compaction reset` to replace it with defaults; commands that cannot save because of it say so.

The model picker shows the cached model list and reloads `models.json` locally, without network catalog refreshes. A slow reload delays the picker by at most 3 seconds; a failing one is ignored.

Only preferences and minimal session outcome metadata are stored by this extension; no API keys, raw provider error bodies, or additional prompt copies. Pi still stores its normal session transcript and compaction summary. Error notifications redact common credential forms (bearer tokens, `key=` query parameters, API-key headers, `sk-`/`AIza`/`ghp_` keys, JWTs), but may still contain other provider diagnostics: review terminal logs before sharing them. Persisted metadata is validated and stripped of control, bidi-override and zero-width characters before display. There is no telemetry.

**Changing the compaction provider sends your serialized session context to that provider.** Use a provider you trust, especially for proprietary code. Nothing in your local configuration, credentials, or sessions is published to GitHub by this package.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Tests use synthetic conversations and in-process fixtures: no external model calls, credentials or real user sessions. CI checks Node.js 22 and 24. Coverage includes:

- the actual Pi resource loader and compaction lifecycle, including Pi's "Already compacted" guard with the override on and off, and a fresh install without a model;
- native fallback, transient-error and condensed retries, stalled providers and the time limit (also with adapters that ignore cancellation), user versus provider aborts;
- refusals and other invalid output, split turns (run concurrently in the actual host, with a checkpoint byte-identical to Pi's sequential one), file tracking across off/on, unknown model limits;
- pausing after time-outs and repeated failures, a second loaded copy, an incompatible Pi API;
- settings persistence, symlinks and reset; command parsing and completions;
- status cleanup and a failing status display; the searchable picker at narrow widths, pre-filtered, and with a failing refresh.

## Update / remove

```sh
pi update git:https://github.com/sehoon123/pi-fast-compaction
pi remove git:https://github.com/sehoon123/pi-fast-compaction
```

Run `/reload` afterward, in **every** open Pi session. Once a newer version saves your settings, an older version still running elsewhere may reject the file (0.2.0 does not know `timeoutSeconds`) and use normal Pi compaction until reloaded. Removing the package does not remove your preferences file or historical session entries.

Load only one copy of the extension, e.g. not the installed package together with `pi -e ./src/index.ts` during development. If both copies are 0.4.0 or later, the first one in the session handles compaction and the other warns and stays inactive, so nothing is summarized twice.

## License

MIT © SH Jung
