import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectRendererFileManagerPlatform, fileManagerLabelKey } from "../renderer/fileManagerLabels";
import { createTranslator, resolveLanguage } from "../renderer/i18n";
import { resources } from "../renderer/i18nCatalog";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop renderer i18n", () => {
  it("keeps zh-CN and en resources on the same key contract", () => {
    expect(Object.keys(resources["zh-CN"]).sort()).toEqual(Object.keys(resources.en).sort());
  });

  it("keeps catalog data outside the translator runtime module", async () => {
    const i18nSource = await readFile(resolve(sourceDir, "renderer", "i18n.ts"), "utf8");

    expect(i18nSource).not.toContain("export const resources");
    expect(i18nSource).not.toContain('newTask: "');
    expect(i18nSource).toContain("createTranslator");
    expect(i18nSource).toContain("resolveLanguage");
  });

  it("resolves explicit and system languages", () => {
    expect(resolveLanguage("zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("en")).toBe("en");

    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "zh-CN" }
    });
    expect(resolveLanguage("system")).toBe("zh-CN");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator
    });
  });

  it("uses translation keys for task card and review default copy", async () => {
    const [
      settingsSource,
      settingsGeneralSource,
      settingsComponentsSource,
      settingsReviewSource,
      reviewHookSource,
      reviewViewSource,
      statsSource
    ] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "views", "SettingsView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "settings", "SettingsGeneralSection.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "settings", "SettingsComponentsSection.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "settings", "SettingsReviewSection.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useReviewPipeline.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "ReviewPipelineView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "StatisticsView.tsx"), "utf8")
    ]);
    const rendererSource = `${settingsSource}\n${settingsGeneralSource}\n${settingsComponentsSource}\n${settingsReviewSource}\n${reviewHookSource}\n${reviewViewSource}\n${statsSource}`;

    expect(rendererSource).not.toContain(">Task Prompt<");
    expect(rendererSource).not.toContain(">Block Stack<");
    expect(rendererSource).not.toContain(">Exception Overlay<");
    expect(rendererSource).not.toContain('"New review step"');
    expect(rendererSource).not.toContain('"Check work"');
    expect(rendererSource).not.toContain('"Review work"');
    expect(rendererSource).not.toContain('"Implement work"');
    expect(rendererSource).not.toContain(">Implementation + Check<");
    expect(rendererSource).toContain('t("defaultReviewBlockHint")');
    expect(rendererSource).toContain('t("packageDefaultCycles")');
    expect(rendererSource).toContain('t("addHookArg")');
    expect(rendererSource).toContain('t("averageImplementationTime")');
  });

  it("translates the default task card labels", () => {
    const zh = createTranslator("zh-CN");
    const en = createTranslator("en");

    expect(zh("taskPrompt")).toBe("任务提示");
    expect(zh("defaultTaskAcceptance")).toBe("Task 完成实现。");
    expect(en("defaultImplementationBlockTitle")).toBe("Implement work");
    expect(en("defaultTaskAcceptance")).toBe("Task is implemented.");
  });

  it("resolves file manager labels from renderer platform data", () => {
    expect(detectRendererFileManagerPlatform({ platform: "MacIntel", userAgent: "Mac OS X" })).toBe("darwin");
    expect(detectRendererFileManagerPlatform({ platform: "Win32", userAgent: "Windows NT" })).toBe("win32");
    expect(detectRendererFileManagerPlatform({ platform: "Linux x86_64", userAgent: "X11; Linux x86_64" })).toBe("generic");

    const zh = createTranslator("zh-CN");
    const en = createTranslator("en");

    expect(zh(fileManagerLabelKey("planWorkspace", "darwin"))).toBe("在 Finder 中打开计划工作区");
    expect(zh(fileManagerLabelKey("sourceRoot", "win32"))).toBe("在文件资源管理器中打开代码仓库");
    expect(en(fileManagerLabelKey("taskCanvas", "generic"))).toBe("Open task canvas in file manager");
  });
});
