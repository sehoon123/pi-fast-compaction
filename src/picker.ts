import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, fuzzyFilter } from "@earendil-works/pi-tui";
import { describeContext, modelKey, safeLabel } from "./summary.ts";

const REFRESH_TIMEOUT_MS = 3000;
const SUGGESTION_LIMIT = 6;

/**
 * Reload models.json and cached catalogs without network access. A slow or failing
 * refresh must never block or break the picker: the current snapshot remains usable.
 */
export async function refreshLocalModels(ctx: Pick<ExtensionCommandContext, "modelRegistry">): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Not unref'd: this bound must settle the wait even if the refresh holds no I/O handle.
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, REFRESH_TIMEOUT_MS);
  });
  try {
    await Promise.race([ctx.modelRegistry.refresh({ allowNetwork: false, signal: controller.signal }), timeout]);
  } catch {
    // Keep the cached snapshot.
  } finally {
    clearTimeout(timer);
  }
}

const searchText = (m: Model<Api>) => `${m.name} ${modelKey(m)}`;

/**
 * Let the user choose a model. `query` pre-fills the search (e.g. a partial ID typed after
 * `/compaction model`): matches are offered, never selected silently, because the choice
 * decides which provider receives the conversation.
 */
export async function pickModel(
  ctx: ExtensionCommandContext, current: string | null, query?: string, options: { refresh?: boolean } = {},
): Promise<string | undefined> {
  if (options.refresh !== false) await refreshLocalModels(ctx);
  const models = ctx.modelRegistry.getAvailable().sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
  if (!models.length) {
    ctx.ui.notify("No available chat models. Configure a provider in Pi first.", "warning");
    return;
  }
  const matches = query ? fuzzyFilter(models, query, searchText) : models;
  if (!matches.length) {
    throw new Error(`No available chat model matches "${safeLabel(query ?? "", 60)}". Run /compaction model to browse them.`);
  }
  if (!ctx.hasUI) {
    const closest = matches.slice(0, SUGGESTION_LIMIT).map((m) => safeLabel(modelKey(m), 120)).join(", ");
    throw new Error(`Use /compaction model provider/modelId outside interactive mode.${query ? ` Closest: ${closest}` : ""}`);
  }
  if (ctx.mode !== "tui") {
    const title = query ? `Models matching "${safeLabel(query, 40)}" (coding model is unchanged)` : "Compaction model (coding model is unchanged)";
    return ctx.ui.select(title, matches.map(modelKey));
  }
  return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
    const container = new Container();
    const input = new Input({ placeholder: "Search models and providers…" });
    const listTheme = getSelectListTheme();
    if (query) input.setValue(query);
    let filtered = query ? matches : models;
    const makeList = (items: Model<Api>[]) => {
      const list = new SelectList(items.map((m) => ({
        value: modelKey(m),
        label: `${modelKey(m) === current ? "✓ " : ""}${safeLabel(m.name || m.id)}`,
        description: `${safeLabel(modelKey(m), 120)} · ${describeContext(m.contextWindow)}`,
      })), 10, listTheme);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = makeList(filtered);
    const rebuild = () => {
      container.clear();
      container.addChild(new Text(theme.fg("accent", "Compaction model — coding model unchanged"), 1, 0));
      container.addChild(input);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "Type to search · ↑↓ move · Enter select · Esc cancel"), 1, 0));
    };
    const initial = filtered.findIndex((m) => modelKey(m) === current);
    if (initial >= 0) list.setSelectedIndex(initial);
    rebuild();
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) {
        const navigation = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
        if (navigation.some((action) => kb.matches(data, action))) {
          list.handleInput(data);
          if (!filtered.length && kb.matches(data, "tui.select.cancel")) done(undefined);
        } else {
          input.handleInput(data);
          filtered = fuzzyFilter(models, input.getValue(), searchText);
          list = makeList(filtered);
          rebuild();
        }
        tui.requestRender();
      },
    };
  });
}
