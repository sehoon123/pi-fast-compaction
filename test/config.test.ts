import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore, DEFAULTS, parseConfig, splitModelKey } from "../src/config.ts";
import { temporary } from "./helpers.ts";

test("defaults are conservative and use independent low thinking", () => {
  assert.equal(DEFAULTS.thinking, "low");
  assert.equal(DEFAULTS.targetWords, 3000);
  assert.equal(DEFAULTS.scope, "both");
  assert.equal(DEFAULTS.model, null);
  assert.equal(DEFAULTS.fallback, true);
});
test("provider/model parsing retains slashes inside IDs", () => {
  assert.deepEqual(splitModelKey("openrouter/anthropic/haiku"), { provider: "openrouter", id: "anthropic/haiku" });
  for (const key of ["haiku", "/haiku", "provider/", "p/a b", "p/a\n"]) assert.throws(() => splitModelKey(key));
});
test("validation rejects invalid values, future versions and unknown keys", () => {
  for (const patch of [null, [], { version: 2 }, { enabled: "yes" }, { model: 3 }, { model: "bad" }, { thinking: "super" }, { scope: "manual" }, { targetWords: -1 }, { targetWords: 499 }, { targetWords: 1.5 }, { maxOutputTokens: 200 }, { extra: true }, { toString: "bad" }]) {
    assert.throws(() => parseConfig(patch));
  }
  assert.equal(parseConfig({ targetWords: 0 }).targetWords, 0);
  assert.equal(parseConfig({}).maxOutputTokens, 16384);
});
test("settings persist atomically without editing Pi settings or credentials", (t) => {
  const dir = temporary(t);
  const path = join(dir, "fast-compaction.json");
  const a = new ConfigStore(path), b = new ConfigStore(path);
  assert.deepEqual(a.load(), DEFAULTS);
  a.update({ model: "provider/haiku", thinking: "off" });
  b.update({ targetWords: 4000 });
  assert.equal(a.load().thinking, "off");
  assert.equal(a.load().targetWords, 4000);
  assert.deepEqual(readdirSync(dir), ["fast-compaction.json"]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(path, "utf8"), /apiKey|token|password/u);
});
test("a malformed settings file is never silently overwritten", (t) => {
  const path = join(temporary(t), "settings.json");
  writeFileSync(path, "{broken");
  const store = new ConfigStore(path);
  assert.throws(() => store.load(), /Cannot read/u);
  assert.throws(() => store.update({ enabled: true }));
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
