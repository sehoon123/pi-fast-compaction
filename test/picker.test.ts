import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { pickModel } from "../src/picker.ts";
import { harness } from "./helpers.ts";

initTheme("dark", false);

test("searchable picker supports typing, focus propagation and narrow widths", async (t) => {
  const h = harness(t);
  let renders = 0;
  (h.ctx.ui as any).custom = async (factory: any) => {
    let chosen: string | undefined;
    const component = factory({ requestRender() { renders++; } }, { fg: (_color: string, text: string) => text }, getKeybindings(), (value: string | undefined) => { chosen = value; });
    component.focused = true;
    assert.equal(component.focused, true);
    component.handleInput("opus");
    for (const width of [20, 40, 80]) {
      const lines = component.render(width);
      assert.ok(lines.some((line: string) => line.includes("Opus")));
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
    component.handleInput("\r");
    return chosen;
  };
  assert.equal(await pickModel(h.ctx, "fixture/haiku-test"), "fixture/opus-test");
  assert.ok(renders > 0);
});

test("picker can cancel an empty search result", async (t) => {
  const h = harness(t);
  (h.ctx.ui as any).custom = async (factory: any) => {
    let cancelled = false;
    const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, getKeybindings(), (value: unknown) => {
      assert.equal(value, undefined);
      cancelled = true;
    });
    component.handleInput("no-such-model");
    component.handleInput("\x1b");
    assert.ok(cancelled);
    return undefined;
  };
  assert.equal(await pickModel(h.ctx, null), undefined);
});

test("a failing or hanging local refresh never blocks or breaks the picker", async (t) => {
  const h = harness(t);
  (h.ctx as any).mode = "rpc";
  (h.ui as any).select = async (_title: string, options: string[]) => options[0];
  let options: any;
  (h.ctx.modelRegistry as any).refresh = async (value: unknown) => { options = value; throw new Error("bad models.json"); };
  assert.equal(await pickModel(h.ctx, null), "fixture/haiku-test");
  assert.equal(options.allowNetwork, false, "no network catalog refresh");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  (h.ctx.modelRegistry as any).refresh = () => new Promise(() => {});
  const pending = pickModel(h.ctx, null);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3000);
  assert.equal(await pending, "fixture/haiku-test");
});

test("RPC uses supported selector instead of a custom terminal component", async (t) => {
  const h = harness(t);
  (h.ctx as any).mode = "rpc";
  (h.ctx.ui as any).select = async (_title: string, options: string[]) => options.find((value) => value.endsWith("haiku-test"));
  assert.equal(await pickModel(h.ctx, null), "fixture/haiku-test");
});
