import {
  getRuntimeBridgeMocks,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv,
  registeredHandler
} from "./support/runtimeBridgeTestHarness.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { childProcessMock, electronMock, runtimeMock } = getRuntimeBridgeMocks();

describe("runtime bridge handlers: terminal", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
  });

  afterEach(async () => {
    await restoreRuntimeBridgeEnv();
  });

  it("detects terminal apps with icon data from application bundle icons", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const pngBytes = Buffer.from("terminal-icon-png");
    childProcessMock.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (command === "/usr/bin/sips") {
          const outputPath = args.at(-1);
          if (!outputPath) {
            callback(new Error("Missing sips output path."), "", "");
            return;
          }
          void writeFile(outputPath, pngBytes).then(
            () => callback(null, "", ""),
            (caught: unknown) =>
              callback(caught instanceof Error ? caught : new Error(String(caught)), "", "")
          );
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    try {
      const result = await electronMock.handlers.get(
        desktopBridgeInvokeChannels.detectTerminalApps
      )?.(null);

      expect(result).toEqual([
        {
          appId: "terminal",
          label: "Terminal",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        },
        {
          appId: "iterm2",
          label: "iTerm2",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        },
        {
          appId: "ghostty",
          label: "Ghostty",
          available: true,
          iconDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          unavailableReason: null
        }
      ]);
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        "/usr/bin/sips",
        [
          "-z",
          "64",
          "64",
          "-s",
          "format",
          "png",
          "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns",
          "--out",
          expect.stringMatching(/terminal\.png$/)
        ],
        { timeout: 5_000, maxBuffer: 64 * 1024 },
        expect.any(Function)
      );
      expect(electronMock.app.getFileIcon).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("returns unavailable terminal apps without failing detection", async () => {
    childProcessMock.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (command === "/usr/bin/open" && args[0] === "-Ra" && args[1] === "Ghostty") {
          callback(new Error("Unable to find application named 'Ghostty'"), "", "");
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const result = await electronMock.handlers.get(
      desktopBridgeInvokeChannels.detectTerminalApps
    )?.(null);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          appId: "ghostty",
          label: "Ghostty",
          available: false,
          iconDataUrl: null,
          unavailableReason: "Unable to find application named 'Ghostty'"
        }
      ])
    );
  });

  it("reads and updates terminal preferences in PlanWeave Home", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getTerminalPreferences)?.(null)
    ).resolves.toEqual({
      defaultTerminalAppId: null
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.updateTerminalPreferences)?.(null, {
        defaultTerminalAppId: "ghostty"
      })
    ).resolves.toEqual({
      defaultTerminalAppId: "ghostty"
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getTerminalPreferences)?.(null)
    ).resolves.toEqual({
      defaultTerminalAppId: "ghostty"
    });
    await expect(
      readFile(
        join(process.env.PLANWEAVE_HOME ?? "", "config", "terminal-preferences.json"),
        "utf8"
      )
    ).resolves.toContain('"defaultTerminalAppId": "ghostty"');
  });

  it("migrates legacy terminal preferences from Electron user data into PlanWeave Home", async () => {
    await writeFile(
      join(electronMock.userDataDir, "terminal-preferences.json"),
      '{ "defaultTerminalAppId": "iterm2" }',
      "utf8"
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getTerminalPreferences)?.(null)
    ).resolves.toEqual({
      defaultTerminalAppId: "iterm2"
    });
    await expect(
      readFile(
        join(process.env.PLANWEAVE_HOME ?? "", "config", "terminal-preferences.json"),
        "utf8"
      )
    ).resolves.toContain('"defaultTerminalAppId": "iterm2"');
  });

  it("rejects unsupported terminal preferences values", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.updateTerminalPreferences)?.(null, {
        defaultTerminalAppId: "wezterm"
      })
    ).rejects.toThrow("Terminal preferences defaultTerminalAppId is invalid.");
  });

  it("rejects invalid terminal parser inputs", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
    const ch = desktopBridgeInvokeChannels;
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const recordId = "T-001#B-001::RUN-001";
    const cases: Array<[string, unknown, string]> = [
      [
        ch.openTerminal,
        { ref: { canvasId: "canvas-a" }, appId: "terminal" },
        "Desktop canvas reference projectRoot is invalid."
      ],
      [
        ch.openRunTerminal,
        { ref: null, recordId, appId: "terminal" },
        "Desktop canvas reference is invalid."
      ],
      [
        ch.getRunTerminalAvailability,
        { ref: { projectRoot: "/tmp/project", canvasId: 42 }, recordIds: [recordId] },
        "Desktop canvas reference canvasId is invalid."
      ],
      [ch.openTerminal, { ref }, "Terminal app id is invalid."],
      [ch.openTerminal, { ref, appId: "wezterm" }, "Terminal app id is invalid."],
      [ch.openRunTerminal, { ref, appId: "terminal" }, "Open terminal recordId is invalid."],
      [ch.openRunTerminal, { ref, recordId }, "Terminal app id is invalid."],
      [
        ch.openTerminal,
        { ref, appId: "terminal", cwd: "/tmp/elsewhere" },
        "Unsupported open terminal field 'cwd'."
      ],
      [
        ch.openRunTerminal,
        { ref, recordId, appId: "terminal", cwd: "/tmp/elsewhere" },
        "Unsupported open terminal field 'cwd'."
      ],
      [
        ch.getRunTerminalAvailability,
        { ref, recordIds: [recordId], cwd: "/tmp/elsewhere" },
        "Unsupported terminal availability field 'cwd'."
      ]
    ];

    for (const [channel, input, message] of cases) {
      await expect(registeredHandler(channel)(null, input)).rejects.toThrow(message);
    }
  });

  it("returns run terminal availability from live tmux sessions", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        available: true,
        unavailableReason: null
      }
    ]);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "planweave-T-001-B-001-RUN-001-abcd1234"],
      { timeout: 2_000, env: process.env, maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("marks stale run terminal metadata unavailable when the live tmux session is gone", async () => {
    childProcessMock.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (command === "tmux" && args[0] === "has-session") {
          callback(new Error("no such session"), "", "");
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        available: false,
        unavailableReason: "tmux_session_not_running"
      }
    ]);
  });

  it("marks run terminal availability unavailable without tmux metadata", async () => {
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      tmuxSessionId: null,
      metadata: {}
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"]
      })
    ).resolves.toEqual([
      {
        recordId: "T-001#B-001::RUN-001",
        tmuxSessionId: null,
        available: false,
        unavailableReason: "no_tmux_session"
      }
    ]);
  });

  it("rejects renderer-provided commands in run terminal availability requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: ["T-001#B-001::RUN-001"],
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("rejects oversized run terminal availability requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.getRunTerminalAvailability)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordIds: Array.from({ length: 101 }, (_value, index) => `T-001#B-001::RUN-${index}`)
      })
    ).rejects.toThrow("Terminal availability recordIds must not exceed 100.");
  });

  it("opens a regular terminal at the run record cwd without tmux attach", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      cwd: "/tmp/project"
    });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getRunRecord).toHaveBeenCalledWith(
      {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      "T-001#B-001::RUN-001"
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "Terminal", "/tmp/project"],
      { maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(
      childProcessMock.execFile.mock.calls.some((call) => call[0] === "/usr/bin/osascript")
    ).toBe(false);
  });

  it("opens regular iTerm2 and Ghostty windows at the run record cwd", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/Ecco the Dolphin",
      projectRoot: "/tmp/project"
    });

    await electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      appId: "iterm2"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "iTerm", "/tmp/Ecco the Dolphin"],
      { maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(
      childProcessMock.execFile.mock.calls.some((call) => call[0] === "/usr/bin/osascript")
    ).toBe(false);

    childProcessMock.execFile.mockClear();
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/Ecco the Dolphin",
      projectRoot: "/tmp/project"
    });
    await electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      appId: "ghostty"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-n", "-a", "Ghostty", "--args", "--working-directory=/tmp/Ecco the Dolphin"],
      { cwd: "/tmp/Ecco the Dolphin", maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
    expect(childProcessMock.execFile.mock.calls.some((call) => call[0] === "tmux")).toBe(false);
  });

  it("opens a regular terminal at the project root when no run record is supplied", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      cwd: "/tmp/project"
    });

    expect(runtimeMock.getRunRecord).not.toHaveBeenCalled();
  });

  it("rejects renderer-provided commands in regular terminal open requests", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal",
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("opens a run terminal in smoke mode after validating app id, record, and tmux metadata", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).resolves.toEqual({
      appId: "terminal",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "interactive"
    });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.getRunRecord).toHaveBeenCalledWith(
      {
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        source: "task"
      },
      "T-001#B-001::RUN-001"
    );
    expect(
      childProcessMock.execFile.mock.calls.some(
        (call) =>
          call[0] === "/usr/bin/osascript" || (call[0] === "/usr/bin/open" && call[1]?.[0] === "-a")
      )
    ).toBe(false);
  });

  it("accepts explicit terminal attach modes and rejects invalid modes", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "iterm2",
        mode: "interactive"
      })
    ).resolves.toEqual({
      appId: "iterm2",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "interactive"
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "iterm2",
        mode: "readOnly"
      })
    ).resolves.toEqual({
      appId: "iterm2",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "readOnly"
    });

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "iterm2",
        mode: "writeable"
      })
    ).rejects.toThrow("Terminal attach mode is invalid.");
  });

  it("rejects unknown terminal app ids and renderer-provided terminal commands", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "wezterm"
      })
    ).rejects.toThrow("Terminal app id is invalid.");

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal",
        command: "tmux attach-session -t injected"
      })
    ).rejects.toThrow("Renderer must not provide terminal commands.");
  });

  it("rejects run terminal requests when the run record has no tmux metadata", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    runtimeMock.getRunRecord.mockResolvedValueOnce({
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      tmuxSessionId: null,
      metadata: {}
    });
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).rejects.toThrow("Run record has no tmux session.");
  });

  it("launches Ghostty as a new macOS app instance before passing tmux args", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "ghostty"
      })
    ).resolves.toEqual({
      appId: "ghostty",
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      mode: "interactive"
    });

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      [
        "-n",
        "-a",
        "Ghostty",
        "--args",
        "-e",
        "tmux",
        "attach-session",
        "-t",
        "planweave-T-001-B-001-RUN-001-abcd1234"
      ],
      { cwd: "/tmp/project", maxBuffer: 64 * 1024 },
      expect.any(Function)
    );
  });

  it("does not swallow launcher failures outside desktop smoke mode", async () => {
    childProcessMock.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (command === "/usr/bin/open" && args[0] === "-Ra") {
          callback(null, "", "");
          return;
        }
        if (command === "tmux" && args[0] === "has-session") {
          callback(new Error("no such session"), "", "");
          return;
        }
        callback(null, "", "");
      }
    );
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    await expect(
      electronMock.handlers.get(desktopBridgeInvokeChannels.openRunTerminal)?.(null, {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001",
        appId: "terminal"
      })
    ).rejects.toThrow("tmux session does not exist.");
  });
});
