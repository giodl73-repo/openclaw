import type { OpenClawLocale } from "../../packages/localization-core/src/locale-registry.js";

export type DocsGeneratedLocale = {
  language: string;
  dir: Exclude<OpenClawLocale, "en" | "sv">;
  navFile: string;
  tmFile: string;
  navMode: "overlay" | "clone-en";
  navigation?: false;
};

export const GENERATED_LOCALES: readonly DocsGeneratedLocale[];
