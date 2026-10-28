import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface Config {
  version: 1;
  enabled: boolean;
  model: string | null;
  thinking: Thinking;
  scope: "both" | "auto";
  targetWords: number;
  maxOutputTokens: number;
  /** Total time the selected model gets (requests, retries and the condensed retry) before giving up. 0 = no limit. */
  timeoutSeconds: number;
  fallback: boolean;
  showStatus: boolean;
}

export const DEFAULTS: Readonly<Config> = Object.freeze({
  version: 1,
  enabled: true,
  model: null,
  thinking: "low",
  scope: "both",
  targetWords: 3000,
  maxOutputTokens: 16384,
  timeoutSeconds: 300,
  fallback: true,
  showStatus: true,
});

export const TIMEOUT_RANGE = { min: 30, max: 3600 } as const;

export function splitModelKey(key: string): { provider: string; id: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1 || /\s|[\x00-\x1f\x7f]/u.test(key)) {
    throw new Error("Use an exact provider/modelId (the model ID may itself contain slashes).");
  }
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

/** Accepts "3000", "3,000", "3_000" or "3k". Anything else becomes NaN and fails validation. */
export function parseCount(value: string): number {
  const match = value.trim().replace(/[,_]/gu, "").match(/^(\d+(?:\.\d+)?)(k)?$/iu);
  if (!match) return Number.NaN;
  return Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
}

/** Accepts "300", "90s", "5m" or "off" (0). Anything else becomes NaN and fails validation. */
export function parseSeconds(value: string): number {
  const text = value.trim().toLowerCase();
  if (text === "off" || text === "none" || text === "disabled") return 0;
  const match = text.replace(/[,_]/gu, "").match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins)?$/u);
  if (!match) return Number.NaN;
  return Math.round(Number(match[1]) * (match[2]?.startsWith("m") ? 60 : 1));
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
  }
  const c = { ...DEFAULTS, ...input } as Config;
  if (c.version !== 1) throw new Error("Unsupported settings version.");
  for (const key of ["enabled", "fallback", "showStatus"] as const) {
    if (typeof c[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  if (c.model !== null) {
    if (typeof c.model !== "string") throw new Error("model must be provider/modelId or null.");
    splitModelKey(c.model);
  }
  if (!THINKING_LEVELS.includes(c.thinking)) throw new Error(`Invalid thinking level. Use one of: ${THINKING_LEVELS.join(", ")}.`);
  if (!["both", "auto"].includes(c.scope)) throw new Error("scope must be both or auto.");
  if (!Number.isSafeInteger(c.targetWords) || (c.targetWords !== 0 && (c.targetWords < 500 || c.targetWords > 20000))) {
    throw new Error("targetWords must be off (0) or an integer from 500 to 20000.");
  }
  if (!Number.isSafeInteger(c.maxOutputTokens) || c.maxOutputTokens < 2048 || c.maxOutputTokens > 131072) {
    throw new Error("maxOutputTokens must be an integer from 2048 to 131072.");
  }
  if (!Number.isSafeInteger(c.timeoutSeconds)
    || (c.timeoutSeconds !== 0 && (c.timeoutSeconds < TIMEOUT_RANGE.min || c.timeoutSeconds > TIMEOUT_RANGE.max))) {
    throw new Error(`timeoutSeconds must be off (0) or an integer from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}.`);
  }
  return c;
}

/** The settings file exists but cannot be used. Distinct from validation errors in a requested change. */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileError";
  }
}

/**
 * Where to write so that a symlinked settings file (dotfile managers) stays a symlink:
 * follow existing links, including a dangling one whose target does not exist yet.
 */
function resolveWriteTarget(path: string): string {
  try { return realpathSync(path); } catch { /* missing file or dangling link */ }
  try { return resolve(dirname(path), readlinkSync(path)); } catch { return path; }
}

/** Separate from Pi settings and credentials. Invalid files are never silently overwritten. */
export class ConfigStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  load(): Config {
    try {
      // Editors on Windows may add a byte order mark, which JSON.parse rejects.
      return parseConfig(JSON.parse(readFileSync(this.path, "utf8").replace(/^\uFEFF/u, "")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
      throw new ConfigFileError(`Cannot read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  update(patch: Partial<Omit<Config, "version">>): Config {
    // Re-read before each edit, so another Pi session's unrelated changes are retained.
    return this.write(parseConfig({ ...this.load(), ...patch }));
  }

  /** Explicit recovery path: replaces even a malformed file with defaults. */
  reset(): Config {
    return this.write({ ...DEFAULTS });
  }

  private write(config: Config): Config {
    const target = resolveWriteTarget(this.path);
    mkdirSync(dirname(target), { recursive: true });
    // The temp file lives next to the target so the rename stays atomic on one filesystem.
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
        // Without a flush, a crash right after the rename can leave an empty settings file.
        try { fsyncSync(fd); } catch { /* not supported on every filesystem */ }
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return config;
  }
}
