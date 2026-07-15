import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, execFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock
}));

describe("desktop agent tool detection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    accessMock.mockReset();
    accessMock.mockResolvedValue(undefined);
  });

  it("adds Homebrew paths when detecting agent CLI versions", async () => {
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

    const agents = await detectAgentTools();

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
      ["--no-auto-update", "agent", "stdio", "--help"],
      expect.objectContaining({
        maxBuffer: 64 * 1024,
        timeout: 15_000
      }),
      expect.any(Function)
    );
  });

  it("deduplicates agent detection PATH entries", async () => {
    const { agentDetectionPath } = await import("../main/agentTools");

    expect(agentDetectionPath("/usr/bin:/bin").split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin"
    ]);
    expect(agentDetectionPath("/opt/homebrew/bin").split(":")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ]);
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
    const agents = await detectAgentTools();
    const opencodeAcp = agents.find(
      (agent) => agent.kind === "opencode" && agent.runnerKind === "acp"
    );

    expect(opencodeAcp).toMatchObject({
      installed: false,
      unavailableReason: "unknown command acp"
    });
  });
});
