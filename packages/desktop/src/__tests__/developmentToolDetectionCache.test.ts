import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDevelopmentToolDetection } from "@planweave-ai/runtime";
import {
  DEVELOPMENT_TOOL_DETECTION_TTL_MS,
  detectDevelopmentTools,
  openProjectInDevelopmentTool,
  resetDevelopmentToolDetectionCacheForTests,
  setDetectedMacApplicationPathForTests,
  setDevelopmentToolDetectionDepsForTests
} from "../main/codeEditors.js";
import {
  TERMINAL_APP_DETECTION_TTL_MS,
  detectTerminalApps,
  resetTerminalAppDetectionCacheForTests,
  setTerminalAppDetectionDepsForTests
} from "../main/terminalApps.js";

const accessMock = vi.hoisted(() => vi.fn(async () => undefined));
const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, "", "");
    }
  )
);

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, access: accessMock };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileMock };
});

vi.mock("electron", () => ({
  app: {
    getFileIcon: vi.fn(async () => ({ toDataURL: () => "" })),
    getPath: vi.fn(() => "/tmp")
  },
  shell: {
    openPath: vi.fn(async () => "")
  }
}));

function sampleTools(): DesktopDevelopmentToolDetection[] {
  return [
    {
      toolId: "vscode",
      label: "VS Code",
      available: true,
      iconDataUrl: "data:image/png;base64,aaa",
      iconUnavailableReason: null,
      unavailableReason: null
    },
    {
      toolId: "cursor",
      label: "Cursor",
      available: false,
      iconDataUrl: null,
      iconUnavailableReason: null,
      unavailableReason: "not installed"
    }
  ];
}

describe("development tool detection cache", () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000;
    accessMock.mockReset();
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, "", "");
      }
    );
    resetDevelopmentToolDetectionCacheForTests();
    resetTerminalAppDetectionCacheForTests();
    setDevelopmentToolDetectionDepsForTests({
      now: () => nowMs
    });
    setTerminalAppDetectionDepsForTests({
      now: () => nowMs
    });
  });

  afterEach(() => {
    resetDevelopmentToolDetectionCacheForTests();
    resetTerminalAppDetectionCacheForTests();
  });

  it("shares one in-flight detector call across concurrent first requests", async () => {
    let resolveDetect!: (value: DesktopDevelopmentToolDetection[]) => void;
    const detect = vi.fn(
      () =>
        new Promise<DesktopDevelopmentToolDetection[]>((resolve) => {
          resolveDetect = resolve;
        })
    );
    setDevelopmentToolDetectionDepsForTests({ detect, now: () => nowMs });

    const first = detectDevelopmentTools();
    const second = detectDevelopmentTools();
    expect(detect).toHaveBeenCalledTimes(1);

    resolveDetect(sampleTools());
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(sampleTools());
    expect(right).toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("returns cached success within TTL and re-detects after expiry", async () => {
    const detect = vi.fn(async () => sampleTools());
    setDevelopmentToolDetectionDepsForTests({ detect, now: () => nowMs });

    await expect(detectDevelopmentTools()).resolves.toEqual(sampleTools());
    await expect(detectDevelopmentTools()).resolves.toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(1);

    nowMs += DEVELOPMENT_TOOL_DETECTION_TTL_MS - 1;
    await expect(detectDevelopmentTools()).resolves.toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(detectDevelopmentTools()).resolves.toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("does not cache rejections and allows the next request to succeed", async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new Error("mdfind failed"))
      .mockResolvedValueOnce(sampleTools());
    setDevelopmentToolDetectionDepsForTests({ detect, now: () => nowMs });

    await expect(detectDevelopmentTools()).rejects.toThrow("mdfind failed");
    await expect(detectDevelopmentTools()).resolves.toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("returns defensive copies so caller mutations cannot pollute the cache", async () => {
    const detect = vi.fn(async () => sampleTools());
    setDevelopmentToolDetectionDepsForTests({ detect, now: () => nowMs });

    const first = await detectDevelopmentTools();
    first.pop();
    first[0] = {
      toolId: "xcode",
      label: "mutated",
      available: false,
      iconDataUrl: null,
      iconUnavailableReason: null,
      unavailableReason: "mutated"
    };

    const second = await detectDevelopmentTools();
    expect(second).toEqual(sampleTools());
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("caches successful empty detections as empty success results", async () => {
    const detect = vi.fn(async () => [] as DesktopDevelopmentToolDetection[]);
    setDevelopmentToolDetectionDepsForTests({ detect, now: () => nowMs });

    await expect(detectDevelopmentTools()).resolves.toEqual([]);
    await expect(detectDevelopmentTools()).resolves.toEqual([]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("rejects launch when a cached application path is no longer available", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    setDetectedMacApplicationPathForTests("vscode", "/Missing/Visual Studio Code.app");
    accessMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "/usr/bin/mdfind") {
          callback(null, "", "");
          return;
        }
        callback(null, "", "");
      }
    );

    try {
      await expect(openProjectInDevelopmentTool("/tmp/project", "vscode")).rejects.toThrow(
        "VS Code application bundle was not found."
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("rejects launch when re-resolved path fails the availability check", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    setDetectedMacApplicationPathForTests("vscode", null);
    accessMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (command === "/usr/bin/mdfind") {
          callback(null, "/Gone/Visual Studio Code.app\n", "");
          return;
        }
        callback(null, "", "");
      }
    );

    try {
      await expect(openProjectInDevelopmentTool("/tmp/project", "vscode")).rejects.toThrow(
        "VS Code is no longer available at /Gone/Visual Studio Code.app."
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("terminal app detection cache", () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 2_000_000;
    resetTerminalAppDetectionCacheForTests();
    setTerminalAppDetectionDepsForTests({ now: () => nowMs });
  });

  afterEach(() => {
    resetTerminalAppDetectionCacheForTests();
  });

  it("shares one in-flight terminal detector across concurrent first requests", async () => {
    const apps = [
      {
        appId: "terminal" as const,
        label: "Terminal",
        available: true,
        iconDataUrl: null,
        unavailableReason: null
      }
    ];
    let resolveDetect!: (value: typeof apps) => void;
    const detect = vi.fn(
      () =>
        new Promise<typeof apps>((resolve) => {
          resolveDetect = resolve;
        })
    );
    setTerminalAppDetectionDepsForTests({ detect, now: () => nowMs });

    const first = detectTerminalApps();
    const second = detectTerminalApps();
    expect(detect).toHaveBeenCalledTimes(1);
    resolveDetect(apps);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(apps);
    expect(right).toEqual(apps);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("returns cached terminal success within TTL and re-detects after expiry", async () => {
    const apps = [
      {
        appId: "terminal" as const,
        label: "Terminal",
        available: true,
        iconDataUrl: null,
        unavailableReason: null
      }
    ];
    const detect = vi.fn(async () => apps);
    setTerminalAppDetectionDepsForTests({ detect, now: () => nowMs });

    await expect(detectTerminalApps()).resolves.toEqual(apps);
    await expect(detectTerminalApps()).resolves.toEqual(apps);
    expect(detect).toHaveBeenCalledTimes(1);

    nowMs += TERMINAL_APP_DETECTION_TTL_MS - 1;
    await expect(detectTerminalApps()).resolves.toEqual(apps);
    expect(detect).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(detectTerminalApps()).resolves.toEqual(apps);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("does not cache terminal detection failures", async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new Error("open failed"))
      .mockResolvedValueOnce([]);
    setTerminalAppDetectionDepsForTests({ detect, now: () => nowMs });

    await expect(detectTerminalApps()).rejects.toThrow("open failed");
    await expect(detectTerminalApps()).resolves.toEqual([]);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});
