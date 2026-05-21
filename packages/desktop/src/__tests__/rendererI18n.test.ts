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
    const appSource = await readFile(resolve(sourceDir, "renderer", "App.tsx"), "utf8");

    expect(appSource).not.toContain(">Task Prompt<");
    expect(appSource).not.toContain(">Block Stack<");
    expect(appSource).not.toContain(">Exception Overlay<");
    expect(appSource).not.toContain('"New review step"');
    expect(appSource).not.toContain('"Check work"');
    expect(appSource).not.toContain('"Review work"');
    expect(appSource).not.toContain('"Implement work"');
    expect(appSource).not.toContain(">Implementation + Check<");
    expect(appSource).toContain('t("blockSetImplementationCheckReview")');
    expect(appSource).toContain('t("packageDefaultCycles")');
    expect(appSource).toContain('t("averageImplementationTime")');
  });

  it("translates the default task card labels", () => {
    const zh = createTranslator("zh-CN");
    const en = createTranslator("en");

    expect(zh("taskPrompt")).toBe("Task Prompt");
    expect(en("defaultImplementationBlockTitle")).toBe("Implement work");
  });
});
