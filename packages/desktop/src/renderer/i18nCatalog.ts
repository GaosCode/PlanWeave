import { enCatalog, type TranslationKey } from "./i18nEn";
import { zhCnCatalog } from "./i18nZhCn";

export type SupportedLanguage = "zh-CN" | "en";

export const resources: Record<SupportedLanguage, Record<TranslationKey, string>> = {
  "zh-CN": zhCnCatalog,
  en: enCatalog
};

export type { TranslationKey };
