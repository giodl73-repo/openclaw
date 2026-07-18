import {
  createCatalogSnapshot,
  createLocalizationContext,
  renderLocalizedMessage,
  resolveProcessLocalizationContext,
  validateCatalog,
  type LocalizationContext,
  type MessageParam,
  type OpenClawLocale,
} from "@openclaw/localization-core";
import type { TuiActivityStatus } from "../tui-types.js";
import { TUI_ENGLISH_CATALOG, type TuiMessageKey } from "./locales/en.js";
import { TUI_ZH_CN_CATALOG } from "./locales/zh-CN.js";

export const TUI_SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

const validationIssues = validateCatalog({
  namespace: "tui",
  source: TUI_ENGLISH_CATALOG,
  candidate: TUI_ZH_CN_CATALOG,
});
if (validationIssues.length > 0) {
  throw new Error(`Invalid TUI zh-CN catalog: ${JSON.stringify(validationIssues)}`);
}

const TUI_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "tui-runtime:2",
  catalogs: {
    en: TUI_ENGLISH_CATALOG,
    "zh-CN": TUI_ZH_CN_CATALOG,
  },
});

const TUI_ACTIVITY_MESSAGE_KEYS: Readonly<Record<TuiActivityStatus, TuiMessageKey>> = Object.freeze(
  {
    idle: "tui.activity.idle",
    waiting: "tui.activity.waiting",
    streaming: "tui.activity.streaming",
    running: "tui.activity.running",
    "finishing context": "tui.activity.finishingContext",
    "starting up": "tui.activity.startingUp",
    auth: "tui.activity.auth",
    error: "tui.activity.error",
    disconnected: "tui.activity.disconnected",
    sending: "tui.activity.sending",
    aborted: "tui.activity.aborted",
    "abort failed": "tui.activity.abortFailed",
    "tools expanded": "tui.activity.toolsExpanded",
    "tools collapsed": "tui.activity.toolsCollapsed",
    "cleared input; press ctrl+c again to exit": "tui.activity.clearedInput",
    "press ctrl+c again to exit": "tui.activity.pressCtrlCAgain",
    "device approval needed: preview latest request": "tui.activity.deviceApprovalNeeded",
  },
);

const TUI_WAITING_MESSAGE_KEYS = [
  "tui.waiting.flibbertigibbeting",
  "tui.waiting.kerfuffling",
  "tui.waiting.dillydallying",
  "tui.waiting.twiddlingThumbs",
  "tui.waiting.noodling",
  "tui.waiting.bamboozling",
  "tui.waiting.moseying",
  "tui.waiting.hobnobbing",
  "tui.waiting.pondering",
  "tui.waiting.conjuring",
] as const satisfies readonly TuiMessageKey[];

export type TuiLocalization = {
  context: LocalizationContext;
  t: (key: TuiMessageKey, params?: Readonly<Record<string, MessageParam>>) => string;
};

export function createTuiLocalization(options?: {
  env?: NodeJS.ProcessEnv;
  locale?: OpenClawLocale;
}): TuiLocalization {
  const context = options?.locale
    ? createLocalizationContext({
        locale: options.locale,
        source: "explicit-user",
        audience: "operator",
        supportedLocales: TUI_SUPPORTED_LOCALES,
      })
    : resolveProcessLocalizationContext(options?.env ?? process.env, {
        audience: "operator",
        supportedLocales: TUI_SUPPORTED_LOCALES,
      }).context;

  return Object.freeze({
    context,
    t: (key, params) =>
      renderLocalizedMessage(TUI_CATALOG_SNAPSHOT, context, {
        key,
        params,
        fallback: TUI_ENGLISH_CATALOG[key],
      }),
  });
}

export const TUI_ENGLISH_LOCALIZATION = createTuiLocalization({ locale: "en" });

export function localizeTuiActivityStatus(
  localization: TuiLocalization,
  status: TuiActivityStatus,
): string {
  return localization.t(TUI_ACTIVITY_MESSAGE_KEYS[status]);
}

export function getTuiWaitingPhrases(localization: TuiLocalization): readonly string[] {
  return Object.freeze(TUI_WAITING_MESSAGE_KEYS.map((key) => localization.t(key)));
}
