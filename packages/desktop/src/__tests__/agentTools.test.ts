import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

describe("desktop agent tool detection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
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
        version: agent.version
      }))
    ).toEqual([
      { command: "codex", installed: true, version: "codex 1.2.3" },
      { command: "claude", installed: true, version: "claude 1.2.3" },
      { command: "opencode", installed: true, version: "opencode 1.2.3" },
      { command: "pi", installed: true, version: "pi 1.2.3" }
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringContaining("/opt/homebrew/bin")
        }),
        timeout: 2_000
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
});
