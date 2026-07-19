import path from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_LOCALES as CONTROL_UI_LOCALES } from "../ui/src/i18n/lib/registry.js";
import { getAndroidLocaleDirectory } from "./android-app-i18n.js";
import { APPLE_I18N_LOCALES, getAppleLocaleDirectory } from "./apple-app-i18n.js";
import { CONTROL_UI_LOCALE_ENTRIES } from "./lib/control-ui-i18n-config.js";
import { GENERATED_LOCALES } from "./lib/docs-i18n-locales.mjs";
import { findLocalizationSurfaceConvergenceIssues } from "./lib/localization-surface-convergence.js";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.js";

export function checkLocalizationSurfaceConvergence(): void {
  const issues = findLocalizationSurfaceConvergenceIssues({
    controlUiEntries: CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.locale),
    controlUiLocales: CONTROL_UI_LOCALES,
    nativeLocales: NATIVE_I18N_LOCALES,
    appleLocales: APPLE_I18N_LOCALES,
    docsLocales: GENERATED_LOCALES,
    androidLocaleDirectory: getAndroidLocaleDirectory,
    appleLocaleDirectory: getAppleLocaleDirectory,
  });
  if (issues.length > 0) {
    throw new Error(`localization surface convergence failed:\n${issues.join("\n")}`);
  }
  process.stdout.write(
    `localization-surface-convergence: ui=${CONTROL_UI_LOCALES.length} native=${NATIVE_I18N_LOCALES.length} docs=${GENERATED_LOCALES.length}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkLocalizationSurfaceConvergence();
}
