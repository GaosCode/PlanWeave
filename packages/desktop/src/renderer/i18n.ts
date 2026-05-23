import { resources, type SupportedLanguage, type TranslationKey } from "./i18nCatalog";

export type { SupportedLanguage, TranslationKey };
export type Language = "system" | SupportedLanguage;

export function resolveLanguage(language: Language): SupportedLanguage {
  if (language !== "system") {
    return language;
  }
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export function createTranslator(language: Language) {
  const resolvedLanguage = resolveLanguage(language);
  return (key: keyof (typeof resources)["en"]) => resources[resolvedLanguage][key] ?? key;
}
