import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConfigFileError, ConfigStore, DEFAULTS, parseConfig, parseCount, parseSeconds, splitModelKey } from "../src/config.ts";
import { temporary } from "./helpers.ts";

test("defaults are conservative and use independent low thinking", () => {
  assert.equal(DEFAULTS.thinking, "low");
  assert.equal(DEFAULTS.targetWords, 3000);
  assert.equal(DEFAULTS.scope, "both");
  assert.equal(DEFAULTS.model, null);
  assert.equal(DEFAULTS.fallback, true);
  assert.equal(DEFAULTS.timeoutSeconds, 300);
});
test("provider/model parsing retains slashes inside IDs", () => {
  assert.deepEqual(splitModelKey("openrouter/anthropic/haiku"), { provider: "openrouter", id: "anthropic/haiku" });
  for (const key of ["haiku", "/haiku", "provider/", "p/a b", "p/a\n"]) assert.throws(() => splitModelKey(key));
});
test("validation rejects invalid values, future versions and unknown keys", () => {
  for (const patch of [null, [], { version: 2 }, { enabled: "yes" }, { model: 3 }, { model: "bad" }, { thinking: "super" }, { scope: "manual" }, { targetWords: -1 }, { targetWords: 499 }, { targetWords: 1.5 }, { maxOutputTokens: 200 }, { timeoutSeconds: 5 }, { timeoutSeconds: 4000 }, { timeoutSeconds: 90.5 }, { timeoutSeconds: "300" }, { extra: true }, { toString: "bad" }]) {
    assert.throws(() => parseConfig(patch));
  }
  assert.equal(parseConfig({ targetWords: 0 }).targetWords, 0);
  assert.equal(parseConfig({}).maxOutputTokens, 16384);
  assert.equal(parseConfig({ timeoutSeconds: 0 }).timeoutSeconds, 0);
  assert.equal(parseConfig({ timeoutSeconds: 30 }).timeoutSeconds, 30);
  const legacy = { version: 1, enabled: true, model: "p/m", thinking: "low", scope: "both", targetWords: 3000, maxOutputTokens: 16384, fallback: true, showStatus: true };
  assert.equal(parseConfig(legacy).timeoutSeconds, 300, "0.2.0 files load with the new default");
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
test("a malformed settings file is never silently overwritten, only by explicit reset", (t) => {
  const path = join(temporary(t), "settings.json");
  writeFileSync(path, "{broken");
  const store = new ConfigStore(path);
  assert.throws(() => store.load(), (error) => error instanceof ConfigFileError && /Cannot read/u.test(error.message));
  assert.throws(() => store.update({ enabled: true }));
  assert.equal(readFileSync(path, "utf8"), "{broken");
  assert.deepEqual(store.reset(), { ...DEFAULTS });
  assert.deepEqual(store.load(), { ...DEFAULTS });
});
test("friendly counts parse, junk does not", () => {
  assert.equal(parseCount("3,000"), 3000);
  assert.equal(parseCount(" 3_000 "), 3000);
  assert.equal(parseCount("16k"), 16000);
  assert.equal(parseCount("1.5K"), 1500);
  for (const bad of ["", "lots", "-5", "1e5", "0x10", "3 000 words"]) assert.ok(Number.isNaN(parseCount(bad)), bad);
});
test("time limits parse seconds, minutes and off", () => {
  assert.equal(parseSeconds("300"), 300);
  assert.equal(parseSeconds(" 90s "), 90);
  assert.equal(parseSeconds("5m"), 300);
  assert.equal(parseSeconds("1.5 min"), 90);
  assert.equal(parseSeconds("OFF"), 0);
  for (const bad of ["", "soon", "-5", "5h", "1e3"]) assert.ok(Number.isNaN(parseSeconds(bad)), bad);
});
test("a byte order mark from a Windows editor does not break the settings file", (t) => {
  const path = join(temporary(t), "settings.json");
  writeFileSync(path, `\uFEFF${JSON.stringify({ version: 1, thinking: "high" })}`);
  assert.equal(new ConfigStore(path).load().thinking, "high");
});
test("a symlinked settings file stays a symlink, including a dangling one", { skip: process.platform === "win32" }, (t) => {
  const dir = temporary(t);
  mkdirSync(join(dir, "dotfiles"));
  const target = join(dir, "dotfiles", "fast-compaction.json");
  const link = join(dir, "fast-compaction.json");
  symlinkSync(target, link);
  const store = new ConfigStore(link);
  store.update({ thinking: "medium" });
  assert.ok(lstatSync(link).isSymbolicLink(), "dangling link: written through to its target");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).thinking, "medium");
  store.update({ targetWords: 4000 });
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(readdirSync(join(dir, "dotfiles")), ["fast-compaction.json"], "no temp files left behind");
  assert.equal(store.load().targetWords, 4000);
});
