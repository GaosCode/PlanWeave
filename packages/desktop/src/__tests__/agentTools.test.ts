import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  accessMock,
  execFileMock,
  listWslDistributionsMock,
  readWslLoginPathMock,
  resolveWindowsProcessInvocationMock
} = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
  listWslDistributionsMock: vi.fn(),
  readWslLoginPathMock: vi.fn(),
  resolveWindowsProcessInvocationMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: accessMock
  };
});

vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@planweave-ai/runtime")>();
  return {
    ...actual,
    listWslDistributions: listWslDistributionsMock,
    readWslLoginPath: readWslLoginPathMock,
    resolveWindowsProcessInvocation: resolveWindowsProcessInvocationMock
  };
});

describe("desktop agent tool detection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    accessMock.mockReset();
    listWslDistributionsMock.mockReset();
    readWslLoginPathMock.mockReset();
    resolveWindowsProcessInvocationMock.mockReset();
    accessMock.mockResolvedValue(undefined);
    listWslDistributionsMock.mockResolvedValue({
      available: true,
      distributions: ["Ubuntu"],
      unavailableReason: null
    });
    readWslLoginPathMock.mockResolvedValue("/home/dev/.local/bin:/usr/bin:/bin");
  });

  it("adds Homebrew paths when detecting agent CLI versions on POSIX", async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, `${command} 1.2.3\n`, "");
      }
    );
    const { detectAgentTools } = await import("../main/agentTools");

    const agents = await detectAgentTools("darwin");

    expect(
      agents.map((agent) => ({
        command: agent.command,
        installed: agent.installed,
        runnerKind: agent.runnerKind,
        version: agent.version
      }))
    ).toEqual([
      { command: "codex", installed: true, runnerKind: "cli", version: "codex 1.2.3" },
      { command: "claude", installed: true, runnerKind: "cli", version: "claude 1.2.3" },
      { command: "opencode", installed: true, runnerKind: "cli", version: "opencode 1.2.3" },
      { command: "pi", installed: true, runnerKind: "cli", version: "pi 1.2.3" },
      { command: "grok", installed: true, runnerKind: "cli", version: "grok 1.2.3" },
      { command: "codex-acp", installed: true, runnerKind: "acp", version: null },
      { command: "claude-agent-acp", installed: true, runnerKind: "acp", version: null },
      { command: "opencode", installed: true, runnerKind: "acp", version: null },
      { command: "pi-acp", installed: true, runnerKind: "acp", version: null },
      { command: "grok", installed: true, runnerKind: "acp", version: null }
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringContaining("/opt/homebrew/bin")
        }),
        timeout: 5_000
      }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "opencode",
      ["acp", "--help"],
      expect.objectContaining({
        maxBuffer: 64 * 1024,
        timeout: 15_000
      }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "grok",
      ["--version"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "grok",
      ["--no-auto-update", "agent", "stdio", "--help"],
      expect.objectContaining({
        maxBuffer: 64 * 1024,
        timeout: 15_000
      }),
      expect.any(Function)
    );
    expect(resolveWindowsProcessInvocationMock).not.toHaveBeenCalled();
  });

  it("uses POSIX path delimiter and Homebrew fallbacks", async () => {
    const { agentDetectionPath } = await import("../main/agentTools");

    const darwinEntries = agentDetectionPath({
      envPath: "/usr/bin:/bin",
      platform: "darwin",
      env: { HOME: "/Users/example" }
    }).split(":");
    expect(darwinEntries.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(darwinEntries).toEqual(
      expect.arrayContaining([
        "/Users/example/.grok/bin",
        "/Users/example/Library/pnpm",
        "/opt/homebrew/bin",
        "/usr/local/bin"
      ])
    );

    const linuxEntries = agentDetectionPath({
      envPath: "/opt/homebrew/bin",
      platform: "linux",
      env: { HOME: "/home/example" }
    }).split(":");
    expect(linuxEntries).toEqual(
      expect.arrayContaining([
        "/home/example/.local/bin",
        "/home/example/.opencode/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin"
      ])
    );
    expect(linuxEntries).not.toContain("/home/example/Library/pnpm");
  });

  it("uses Windows path delimiter and appends common user install locations", async () => {
    const { agentDetectionPath, agentDetectionEnv } = await import("../main/agentTools");

    expect(
      agentDetectionPath({
        envPath: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        platform: "win32",
        env: {
          USERPROFILE: String.raw`C:\Users\dev`,
          APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
          LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
        }
      }).split(";")
    ).toEqual(
      expect.arrayContaining([
        String.raw`C:\Tools`,
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`
      ])
    );

    const env = agentDetectionEnv({
      platform: "win32",
      env: {
        Path: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        PATH: "should-not-survive",
        USERPROFILE: String.raw`C:\Users\dev`,
        APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
      }
    });
    expect(env.Path?.split(";")[0]).toBe(String.raw`C:\Tools`);
    expect(env.Path?.split(";")).toEqual(
      expect.arrayContaining([
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`
      ])
    );
    expect(env.PATH).toBeUndefined();
    expect(env.Path).not.toContain("/opt/homebrew/bin");
  });

  it("runs Windows probes through resolved native or cmd.exe batch invocations", async () => {
    resolveWindowsProcessInvocationMock.mockImplementation(
      ({ command, args }: { command: string; args?: readonly string[] }) => {
        if (command === "codex") {
          return {
            command: String.raw`C:\Windows\System32\cmd.exe`,
            args: [
              "/d",
              "/s",
              "/c",
              String.raw`"C:\Users\dev\AppData\Roaming\npm\codex.cmd" --version`
            ],
            target: {
              executable: String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`,
              launchMode: "batch"
            },
            windowsVerbatimArguments: true
          };
        }
        if (command === "claude") {
          return {
            command: String.raw`C:\Users\dev\.local\bin\claude.exe`,
            args: [...(args ?? [])],
            target: {
              executable: String.raw`C:\Users\dev\.local\bin\claude.exe`,
              launchMode: "native"
            },
            windowsVerbatimArguments: false
          };
        }
        if (command === "opencode" && args?.[0] === "acp") {
          return {
            command: String.raw`C:\Windows\System32\cmd.exe`,
            args: [
              "/d",
              "/s",
              "/c",
              String.raw`"C:\Users\dev\AppData\Roaming\npm\opencode.cmd" acp --help`
            ],
            target: {
              executable: String.raw`C:\Users\dev\AppData\Roaming\npm\opencode.cmd`,
              launchMode: "batch"
            },
            windowsVerbatimArguments: true
          };
        }
        if (command === "opencode") {
          return {
            command: String.raw`C:\Windows\System32\cmd.exe`,
            args: [
              "/d",
              "/s",
              "/c",
              String.raw`"C:\Users\dev\AppData\Roaming\npm\opencode.cmd" --version`
            ],
            target: {
              executable: String.raw`C:\Users\dev\AppData\Roaming\npm\opencode.cmd`,
              launchMode: "batch"
            },
            windowsVerbatimArguments: true
          };
        }
        if (command === "pi") {
          return {
            command: String.raw`C:\Windows\System32\cmd.exe`,
            args: [
              "/d",
              "/s",
              "/c",
              String.raw`"C:\Users\dev\AppData\Roaming\npm\pi.cmd" --version`
            ],
            target: {
              executable: String.raw`C:\Users\dev\AppData\Roaming\npm\pi.cmd`,
              launchMode: "batch"
            },
            windowsVerbatimArguments: true
          };
        }
        if (command === "grok") {
          return {
            command: String.raw`C:\Users\dev\.grok\bin\grok.exe`,
            args: [...(args ?? [])],
            target: {
              executable: String.raw`C:\Users\dev\.grok\bin\grok.exe`,
              launchMode: "native"
            },
            windowsVerbatimArguments: false
          };
        }
        return null;
      }
    );
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (String(command).endsWith("claude.exe")) {
          callback(null, "2.1.216 (Claude Code)\n", "");
          return;
        }
        if (String(command).endsWith("grok.exe")) {
          callback(null, "grok 0.2.106\n", "");
          return;
        }
        if (args.includes("/c")) {
          const payload = args.at(-1) ?? "";
          if (payload.includes("codex.cmd")) {
            callback(null, "codex-cli 0.144.6\n", "");
            return;
          }
          if (payload.includes("opencode.cmd") && payload.includes("acp")) {
            callback(null, "OpenCode ACP\n", "");
            return;
          }
          if (payload.includes("opencode.cmd")) {
            callback(null, "1.18.4\n", "");
            return;
          }
          if (payload.includes("pi.cmd")) {
            callback(null, "0.80.10\n", "");
            return;
          }
        }
        callback(new Error(`unexpected probe ${command} ${args.join(" ")}`), "", "");
      }
    );

    const { detectAgentTools } = await import("../main/agentTools");
    const agents = await detectAgentTools("win32");

    expect(
      agents
        .filter((agent) => agent.runnerKind === "cli")
        .map((agent) => ({
          command: agent.command,
          installed: agent.installed,
          version: agent.version
        }))
    ).toEqual([
      { command: "codex", installed: true, version: "codex-cli 0.144.6" },
      { command: "claude", installed: true, version: "2.1.216 (Claude Code)" },
      { command: "opencode", installed: true, version: "1.18.4" },
      { command: "pi", installed: true, version: "0.80.10" },
      { command: "grok", installed: true, version: "grok 0.2.106" }
    ]);
    expect(
      agents.find((agent) => agent.kind === "opencode" && agent.runnerKind === "acp")
    ).toMatchObject({ installed: true, version: null });
    expect(agents.find((agent) => agent.command === "codex-acp")).toMatchObject({
      installed: false,
      installCommand: "npm install -g @agentclientprotocol/codex-acp",
      unavailableReason: expect.stringContaining("npm install -g @agentclientprotocol/codex-acp")
    });
    expect(execFileMock).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\cmd.exe`,
      ["/d", "/s", "/c", String.raw`"C:\Users\dev\AppData\Roaming\npm\codex.cmd" --version`],
      expect.objectContaining({
        windowsVerbatimArguments: true,
        windowsHide: true
      }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      String.raw`C:\Users\dev\.local\bin\claude.exe`,
      ["--version"],
      expect.objectContaining({
        windowsVerbatimArguments: false,
        windowsHide: true
      }),
      expect.any(Function)
    );
  });

  it("returns a stable missing-executable reason when Windows resolution fails", async () => {
    resolveWindowsProcessInvocationMock.mockReturnValue(null);
    const { detectAgentTools } = await import("../main/agentTools");

    const agents = await detectAgentTools("win32");
    const codex = agents.find((agent) => agent.command === "codex" && agent.runnerKind === "cli");

    expect(codex).toMatchObject({
      installed: false,
      unavailableReason: expect.stringMatching(/codex.*not found/i)
    });
  });

  it("detects CLI and ACP agents only inside the explicitly selected WSL distribution", async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(command).toBe("wsl.exe");
        expect(args.slice(0, 2)).toEqual(["--distribution", "Ubuntu"]);
        const commandIndex = args.findIndex((argument) =>
          ["codex", "claude", "opencode", "pi", "grok"].includes(argument)
        );
        const detectedCommand = commandIndex >= 0 ? args[commandIndex] : args.at(-1);
        callback(null, detectedCommand === "grok" ? "grok 0.3.0\n" : "1.2.3\n", "");
      }
    );
    const { detectAgentTools } = await import("../main/agentTools");

    const agents = await detectAgentTools("win32", {
      kind: "wsl",
      distribution: "Ubuntu"
    });

    expect(agents).toHaveLength(10);
    expect(agents.every((agent) => agent.installed)).toBe(true);
    expect(agents.every((agent) => agent.executionHost?.kind === "wsl")).toBe(true);
    expect(agents.find((agent) => agent.command === "pi-acp")).toMatchObject({
      runnerKind: "acp",
      installed: true,
      version: null,
      executionHost: { kind: "wsl", distribution: "Ubuntu" }
    });
    expect(
      agents.find((agent) => agent.kind === "grok" && agent.runnerKind === "acp")
    ).toMatchObject({ installed: true, version: null });
    expect(listWslDistributionsMock).toHaveBeenCalledWith({ platform: "win32" });
    expect(readWslLoginPathMock).toHaveBeenCalledWith("Ubuntu", { platform: "win32" });
    expect(resolveWindowsProcessInvocationMock).not.toHaveBeenCalled();
  });

  it("does not forward Windows credentials through WSLENV during WSL agent detection", async () => {
    const previousWslEnv = process.env.WSLENV;
    const previousXaiKey = process.env.XAI_API_KEY;
    process.env.WSLENV = "XAI_API_KEY/u";
    process.env.XAI_API_KEY = "desktop-secret-sentinel";
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(options.env).not.toHaveProperty("WSLENV");
        expect(options.env).not.toHaveProperty("XAI_API_KEY");
        callback(null, "1.2.3\n", "");
      }
    );

    try {
      const { detectAgentTools } = await import("../main/agentTools");
      const agents = await detectAgentTools("win32", {
        kind: "wsl",
        distribution: "Ubuntu"
      });

      expect(agents.every((agent) => agent.installed)).toBe(true);
    } finally {
      if (previousWslEnv === undefined) delete process.env.WSLENV;
      else process.env.WSLENV = previousWslEnv;
      if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXaiKey;
    }
  });

  it("reports a deleted WSL distribution for every agent without probing native Windows", async () => {
    listWslDistributionsMock.mockResolvedValue({
      available: true,
      distributions: ["Debian"],
      unavailableReason: null
    });
    const { detectAgentTools } = await import("../main/agentTools");

    const agents = await detectAgentTools("win32", {
      kind: "wsl",
      distribution: "Ubuntu"
    });

    expect(agents.every((agent) => !agent.installed)).toBe(true);
    expect(
      agents.every(
        (agent) => agent.unavailableReason === "WSL distribution 'Ubuntu' is not installed."
      )
    ).toBe(true);
    expect(readWslLoginPathMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(resolveWindowsProcessInvocationMock).not.toHaveBeenCalled();
  });

  it("does not mark OpenCode ACP available when its ACP subcommand probe fails", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(args[0] === "acp" ? new Error("unknown command acp") : null, "1.2.3", "");
      }
    );

    const { detectAgentTools } = await import("../main/agentTools");
    const agents = await detectAgentTools("darwin");
    const opencodeAcp = agents.find(
      (agent) => agent.kind === "opencode" && agent.runnerKind === "acp"
    );

    expect(opencodeAcp).toMatchObject({
      installed: false,
      unavailableReason: "unknown command acp"
    });
  });
});
