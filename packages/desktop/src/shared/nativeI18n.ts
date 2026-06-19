export type NativeLanguage = "en" | "zh-CN";

type NativeCatalog = {
  aboutPlanWeave: string;
  ok: string;
  checkForUpdates: string;
  blockInspectorTitle: string;
  taskInspectorTitle: string;
  appUpdateUpToDateMessage: string;
  appUpdateUpToDateDetail: (version: string) => string;
};

const nativeResources: Record<NativeLanguage, NativeCatalog> = {
  en: {
    aboutPlanWeave: "About PlanWeave",
    ok: "OK",
    checkForUpdates: "Check for Updates",
    blockInspectorTitle: "Block Detail",
    taskInspectorTitle: "Task Detail",
    appUpdateUpToDateMessage: "You're up to date!",
    appUpdateUpToDateDetail: (version) => `PlanWeave ${version} is currently the latest version.`
  },
  "zh-CN": {
    aboutPlanWeave: "关于 PlanWeave",
    ok: "好",
    checkForUpdates: "检查更新",
    blockInspectorTitle: "Block 详情",
    taskInspectorTitle: "Task 详情",
    appUpdateUpToDateMessage: "您使用的就是最新版！",
    appUpdateUpToDateDetail: (version) => `PlanWeave ${version} 是当前的最新版本。`
  }
};

export function resolveNativeLanguage(language: string | undefined, systemLocale?: string): NativeLanguage {
  const locale = language === "system" || !language ? systemLocale : language;
  return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function createNativeTranslator(language: string | undefined, systemLocale?: string): NativeCatalog {
  return nativeResources[resolveNativeLanguage(language, systemLocale)];
}
