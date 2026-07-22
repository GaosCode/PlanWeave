import { describe, expect, it, vi } from "vitest";
import { readPosixShellEnvironment } from "../main/agentShellEnvironment.js";

describe("desktop agent shell environment", () => {
  it("reads PATH and provider credentials after shell startup output", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          "startup message\n\0PLANWEAVE_AGENT_SHELL_ENV_V1\0" +
            "PATH=/Users/example/.grok/bin:/Users/example/.nvm/bin:/usr/bin:/bin\0" +
            "DEEPSEEK_API_KEY=from-shell\0"
        )
      );

    const result = await readPosixShellEnvironment({
      env: { SHELL: "/bin/zsh" },
      runner
    });

    expect(result).toEqual({
      kind: "loaded",
      shell: "/bin/zsh",
      environment: {
        PATH: "/Users/example/.grok/bin:/Users/example/.nvm/bin:/usr/bin:/bin",
        DEEPSEEK_API_KEY: "from-shell"
      }
    });
    expect(runner).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l", "-i", "-c", expect.stringContaining("PLANWEAVE_AGENT_SHELL_ENV_V1")],
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it("returns an explicit diagnostic when the login shell cannot be read", async () => {
    const result = await readPosixShellEnvironment({
      env: { SHELL: "/bin/failing-shell" },
      runner: vi.fn().mockRejectedValue(new Error("shell startup failed"))
    });

    expect(result).toEqual({
      kind: "unavailable",
      shell: "/bin/failing-shell",
      reason:
        "Could not read agent environment from login shell '/bin/failing-shell': shell startup failed"
    });
  });
});
