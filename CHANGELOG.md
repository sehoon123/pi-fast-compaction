# Changelog

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
