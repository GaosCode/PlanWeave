import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, execFileMock, resolveWindowsProcessInvocationMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
  resolveWindowsProcessInvocationMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock
}));

vi.mock("@planweave-ai/runtime", () => ({
  resolveWindowsProcessInvocation: resolveWindowsProcessInvocationMock
}));

describe("desktop agent tool detection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    accessMock.mockReset();
    resolveWindowsProcessInvocationMock.mockReset();
    accessMock.mockResolvedValue(undefined);
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

    expect(agentDetectionPath("/usr/bin:/bin", "darwin").split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin"
    ]);
    expect(agentDetectionPath("/opt/homebrew/bin", "linux").split(":")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ]);
  });

  it("uses Windows path delimiter and does not append guessed install locations", async () => {
    const { agentDetectionPath, agentDetectionEnv } = await import("../main/agentTools");

    expect(
      agentDetectionPath({
        envPath: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        platform: "win32"
      }).split(";")
    ).toEqual([String.raw`C:\Tools`, String.raw`C:\Users\dev\AppData\Roaming\npm`]);

    const env = agentDetectionEnv({
      platform: "win32",
      env: {
        Path: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        PATH: "should-not-survive"
      }
    });
    expect(env.Path?.split(";")).toEqual([
      String.raw`C:\Tools`,
      String.raw`C:\Users\dev\AppData\Roaming\npm`
    ]);
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
      [
        "/d",
        "/s",
        "/c",
        String.raw`"C:\Users\dev\AppData\Roaming\npm\codex.cmd" --version`
      ],
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
