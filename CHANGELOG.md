# Changelog

## 0.4.0

### Performance

- **Split-turn compactions run both summary requests at once.** When the cut point falls inside the current turn — common in long agentic turns — Pi requests the history summary and the turn-prefix summary one after the other, although they are independent. Both now go through Pi's own `compact()` concurrently and are joined exactly where Pi joins them; a real-host test checks the checkpoint is byte-identical to Pi's sequential one. A failing half cancels the other, and Pi's own sequence is then tried once, so gateways that reject concurrent requests keep working (after a rate or concurrency limit error, the session stays sequential). If a future Pi changes the format, the extension detects it and uses Pi's sequence.
- The status segment is only updated when its text changes, avoiding a TUI redraw (or RPC message) on every prompt.

### Reliability

- **Pause after failures.** During an outage, every automatic compaction waited up to the full time limit again. After a time-out, or 3 failed runs in a row, the selected model is paused for 10 minutes, doubling up to an hour; automatic compactions use Pi's normal compaction meanwhile and the status shows `paused until HH:MM`. Manual compaction still tries it; a success or any settings change (e.g. `/compaction on`) resumes it. Never with fallback off.
- **A second loaded copy stays inactive.** The installed package plus `pi -e ./src/index.ts` used to summarize every compaction twice and fight over the status segment. The first copy in a session now owns it; others warn and stay out of compaction, status and commands. Sessions in one SDK process are unaffected.
- An incompatible Pi compaction API (e.g. a changed `compact()` signature) is detected: normal compaction with one warning, instead of a failed attempt on every compaction.
- File-tracking recovery can no longer break a compaction if Pi's event shape changes.

### Improved

- `/compaction status` lists outcomes on the current branch (`This branch: 5 fast (avg 21s) · 1 fallback (avg 1m40s)`), shows how long ago the last result was, and the selected model's display name.

## 0.3.1

### Fixed

- With fallback off, the status bar showed `missing · main` for a selected model that is missing from Pi's registry, although compaction is then cancelled rather than run with the main model. It now shows `missing · fallback off`.

### Documentation

- README: input conveniences as a list, status examples for a fallback in progress and a fresh install, the time limit with fallback off, the picker's 3-second reload bound, non-interactive model search, and reloading every Pi session after an update.

## 0.3.0

### Fixed

- **Fresh installs warned on every compaction, and could block compaction entirely.** With no model selected yet, every compaction reported "Fast compaction unavailable; falling back", recorded a fallback, and with fallback off was **cancelled** — including automatic and overflow compaction. Without a model, Pi's compaction now runs untouched, with one hint per session.
- **A stalled provider could hold compaction for Pi's HTTP idle timeout on every attempt and retry**, or indefinitely with that timeout disabled. A new time limit (default 5 minutes, `/compaction timeout`) aborts the selected model and falls back. Escape and the limit take effect immediately, even if a provider adapter ignores cancellation.
- **An exception in the status timer could terminate Pi**, e.g. after the extension context became stale. Status rendering can no longer throw, and the manual-compaction error callback can no longer cause an unhandled rejection.
- **Refusals could become the checkpoint.** OpenAI Responses reports a refusal as ordinary text; a short reply without any heading is now rejected and falls back.
- **Virtual models (and other models reporting 0 for unknown limits) always fell back** with a misleading "context window is too small". Unknown limits are no longer enforced; context labels say "unknown context size", and errors distinguish context window from output limit.
- Per-compaction state replaces a shared global, so the metadata embedded in a compaction — which the next native compaction needs to keep cumulative file lists — can no longer go missing when events overlap.
- A deferred outcome record written after a newer compaction could replace that compaction's result after `/reload`. Records now name their compaction.
- Deferred records are written only once another entry follows the compaction, never directly after it.
- The condensed retry after hitting the output cap used the same thinking level, which could exhaust the cap again. It now thinks no harder than `low`.
- A notice about a fallback was erased when Pi redrew the chat after compacting; it is now repeated after the redraw.
- The manual-compaction error notice duplicated errors Pi itself had already shown.
- The settings file: symlinks (dotfile managers) were replaced by regular files, writes were not flushed before the atomic rename, and a byte order mark made the file unreadable.
- The elapsed-time refresh did not follow `/compaction bar on|off` during a compaction.
- Error messages could be truncated in the middle of an emoji.

### Improved

- Live progress in the status bar (`~1.8K tokens`) while the selected model streams, so a slow model can be told apart from a stalled one.
- The status bar shows the thinking level actually used after model clamping; `/compaction thinking` says when a model clamps the request.
- Subcommands and setting values are case-insensitive; commands confirm what changed, ask for a missing value (`words`, `tokens`, `timeout`), and suggest the intended subcommand for typos. Select prompts show the current value.
- `/compaction model <partial name>` opens the picker pre-filtered, never selecting a match silently; outside interactive mode it lists the closest matches. A mistyped ID reloads `models.json` once.
- Settings that cannot fit together, such as a word target that exceeds the output cap, are flagged on change and in `/compaction status`.
- When the selected model succeeds, the compaction's usage covers all of its attempts, including a discarded over-length one.
- Commands that fail because of an unreadable settings file explain how to recover.
- Context sizes read `1M` instead of `1000K`.
- Real-host test for a fresh install without a model.

## 0.2.0

### Fixed

- **Pi's "Already compacted" guard was broken** after every compaction, even with the override off. The outcome entry written directly after the compaction made a repeated `/compact` report "Nothing to compact" or compact again. It could also allow back-to-back threshold compactions while context stayed above the limit. Results from the selected model are now stored inside the compaction entry. Other outcome records wait until the next turn or prompt, and never directly follow a compaction.
- `minimal` thinking used a 512-token budget, below Anthropic's 1024-token minimum for budget-based thinking. Budgets are now at least 1024.
- Provider-side aborts and timeouts were treated as user cancellation, so compaction was silently skipped without fallback. Only Pi's own compaction signal now counts as cancellation.
- With fallback off, failures were recorded as "cancelled"; they are now recorded as failures.
- The model picker waited on a catalog refresh that could use the network, without a timeout, and a refresh error aborted the picker. It now reloads locally, with a timeout, and keeps the cached list on failure.
- A stale "last" duration could be shown for a newer compaction without recorded metadata.

### Improved

- Transient provider errors (overloaded, rate limits, 5xx, dropped streams) get up to two retries with the selected model before falling back to the slow main model.
- Hitting the output cap triggers one condensed retry with the selected model before fallback.
- Empty checkpoints, including summaries with only file lists, are rejected.
- Status bar: retry and condensing indicators, auto-only scope, missing-model warning, theme colors, and RPC support.
- `/compaction status` shows output tokens, effective thinking, context window, and warnings.
- Model selection warns about missing credentials and a context window smaller than the coding model's.
- Tab completion for subcommands, values and model IDs; numbers accept `3,000`, `3_000` and `16k`.
- `/compaction reset` explicitly repairs a malformed settings file.
- The settings menu stays open after an invalid entry.
- Hardened display of untrusted text: no split emoji, no bidi-override or zero-width characters, validated persisted records, and broader credential redaction in errors.

## 0.1.0

- Separate, configurable compaction model and reasoning level.
- Persistent global settings with interactive menu, searchable model picker and `/compaction` commands.
- Automatic/manual scope, one-shot native compaction, on/off controls and optional main-model fallback.
- Soft summary-length target with output-token safeguards and split-turn budget sharing.
- Live additive status segment, elapsed time and session-persisted last-result metadata.
- Reuse Pi's built-in compaction format, retained boundary, summary usage and cumulative file tracking.
- Never accept empty/truncated/tool-call summaries; respect cancellation without falling back.
- Actual Pi-host integration and offline UI/policy tests; no runtime dependencies beyond Pi peers.
