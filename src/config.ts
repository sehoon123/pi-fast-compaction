import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  fallback: true,
  showStatus: true,
});

export function splitModelKey(key: string): { provider: string; id: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1 || /\s|[\x00-\x1f\x7f]/u.test(key)) {
    throw new Error("Use an exact provider/modelId (the model ID may itself contain slashes).");
  }
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
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
  if (!THINKING_LEVELS.includes(c.thinking)) throw new Error("Invalid thinking level.");
  if (!["both", "auto"].includes(c.scope)) throw new Error("scope must be both or auto.");
  if (!Number.isSafeInteger(c.targetWords) || (c.targetWords !== 0 && (c.targetWords < 500 || c.targetWords > 20000))) {
    throw new Error("targetWords must be 0 (no target) or an integer from 500 to 20000.");
  }
  if (!Number.isSafeInteger(c.maxOutputTokens) || c.maxOutputTokens < 2048 || c.maxOutputTokens > 131072) {
    throw new Error("maxOutputTokens must be an integer from 2048 to 131072.");
  }
  return c;
}

/** Separate from Pi settings and credentials. Invalid files are never silently overwritten. */
export class ConfigStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  load(): Config {
    try {
      return parseConfig(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
      throw new Error(`Cannot read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  update(patch: Partial<Omit<Config, "version">>): Config {
    // Re-read before each edit, so another Pi session's unrelated changes are retained.
    const config = parseConfig({ ...this.load(), ...patch });
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally {
      try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return config;
  }
}
