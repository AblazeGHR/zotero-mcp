import type { PanelSettings } from "../types.ts";
import { isCustomProfile, readCustomAgent } from "../custom-agent.ts";
import { env, errMessage, h } from "./dom.ts";
import { hint, sub } from "./settings-parts.ts";
import { t } from "../i18n.ts";

/** Keep unfinished JSON while a health or catalog answer rebuilds the settings page. */
export function customAgentEditor(get: () => PanelSettings, save: (patch: Partial<PanelSettings>) => Promise<void>, render: () => void): () => HTMLElement {
  let source: string | undefined;
  let adding = false;
  let draft = { label: "", command: "", args: "[]", env: "{}" };
  let error = "";
  return () => {
    const s = get();
    const id = !adding && isCustomProfile(s.backend) ? s.backend : null;
    const profile = id ? s.customAgents?.[id] : undefined;
    const current = JSON.stringify([id, profile]);
    if (source !== current) {
      source = current;
      error = "";
      draft = { label: profile?.label ?? "", command: profile?.command ?? "", args: JSON.stringify(profile?.args ?? []), env: JSON.stringify(profile?.env ?? {}, null, 2) };
    }
    const add = h("button.btn.btn--sm", { type: "button", onclick: () => { adding = !adding; render(); } },
      adding ? t("common.cancel") : t("settings.custom.add"));
    if (!id && !adding) return add;
    const status = h("p.sec__hint", { role: "alert" }, error);
    const field = (key: keyof typeof draft, label: string, rows?: number) => {
      const input = h(rows ? "textarea.input" : "input.input", {
        value: draft[key], rows, type: rows ? undefined : "text", spellcheck: "false", autocomplete: "off",
        "aria-label": label, dataset: { fid: `custom:${key}` }, oninput: () => { draft[key] = (input as HTMLInputElement).value; },
      });
      return h("label.field", null, h("span.field__l", null, label), input);
    };
    return sub(t("settings.custom.title"),
      add, hint(t("settings.custom.hint")),
      h("div.fields", null, field("label", t("settings.custom.name")), field("command", t("settings.custom.command")), field("args", t("settings.custom.args"), 2), field("env", t("settings.custom.env"), 3)),
      hint(t("settings.custom.envHint")),
      h("button.btn.btn--sm", { type: "button", onclick: async () => {
        try {
          const config = readCustomAgent({ label: draft.label, command: draft.command, args: JSON.parse(draft.args), env: JSON.parse(draft.env) });
          const now = get();
          if (id && now.customAgents?.[id]?.revision !== profile?.revision) throw new Error(t("common.tryAgain"));
          const target = id ?? `custom:${env.win.crypto.randomUUID()}` as const;
          const sameLaunch = profile && JSON.stringify([profile.command, profile.args, profile.env]) === JSON.stringify([config.command, config.args, config.env]);
          const revision = sameLaunch ? profile.revision : env.win.crypto.randomUUID();
          adding = false;
          await save({ backend: target, customAgents: { ...now.customAgents, [target]: { ...config, revision } },
            ...(!sameLaunch ? { model: { ...now.model, [target]: "" }, mode: { ...now.mode, [target]: "" }, effort: { ...now.effort, [target]: "" } } : {}) });
        } catch (e) { error = errMessage(e); status.textContent = error; }
      } }, t("settings.custom.save")), status,
      hint(t("settings.custom.limits")));
  };
}
