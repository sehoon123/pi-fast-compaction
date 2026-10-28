# Changelog

## 0.1.0

- Separate, configurable compaction model and reasoning level.
- Persistent global settings with interactive menu, searchable model picker and `/compaction` commands.
- Automatic/manual scope, one-shot native compaction, on/off controls and optional main-model fallback.
- Soft summary-length target with output-token safeguards and split-turn budget sharing.
- Live additive status segment, elapsed time and session-persisted last-result metadata.
- Reuse Pi's built-in compaction format, retained boundary, summary usage and cumulative file tracking.
- Never accept empty/truncated/tool-call summaries; respect cancellation without falling back.
- Actual Pi-host integration and offline UI/policy tests; no runtime dependencies beyond Pi peers.
