import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTranslator, resources, resolveLanguage } from "../renderer/i18n";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop renderer i18n", () => {
  it("keeps zh-CN and en resources on the same key contract", () => {
    expect(Object.keys(resources["zh-CN"]).sort()).toEqual(Object.keys(resources.en).sort());
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
    const [settingsSource, reviewHookSource, reviewViewSource, statsSource] = await Promise.all([
      readFile(resolve(sourceDir, "renderer", "views", "SettingsView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "hooks", "useReviewPipeline.ts"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "ReviewPipelineView.tsx"), "utf8"),
      readFile(resolve(sourceDir, "renderer", "views", "StatisticsView.tsx"), "utf8")
    ]);
    const rendererSource = `${settingsSource}\n${reviewHookSource}\n${reviewViewSource}\n${statsSource}`;

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
    expect(rendererSource).toContain('t("averageImplementationTime")');
  });

  it("translates the default task card labels", () => {
    const zh = createTranslator("zh-CN");
    const en = createTranslator("en");

    expect(zh("taskPrompt")).toBe("Task Prompt");
    expect(en("defaultImplementationBlockTitle")).toBe("Implement work");
  });
});
