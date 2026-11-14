import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.skipIf(process.platform === "win32").each([
    {
      name: "ignores the termination signal until the probe deadline",
      body: "trap '' TERM\nexec /bin/sleep 3",
      timeoutMs: 100,
      diagnostic: "timed out after 100 ms"
    },
    {
      name: "exits before the environment marker",
      body: "exit 17",
      timeoutMs: 5_000,
      diagnostic: "exited with code 17"
    }
  ])(
    "diagnoses a login shell that $name without exposing startup output",
    async ({ body, timeoutMs, diagnostic }) => {
      const directory = await mkdtemp(join(tmpdir(), "planweave-login-shell-"));
      try {
        const shell = join(directory, "test-shell");
        await writeFile(shell, `#!/bin/sh\necho 'EXAMPLE_TOKEN=user-shell-output' >&2\n${body}\n`);
        await chmod(shell, 0o755);
        const result = await readPosixShellEnvironment({ env: { SHELL: shell }, timeoutMs });
        expect(result).toMatchObject({ kind: "unavailable", shell });
        if (result.kind !== "unavailable") throw new Error("Expected a shell probe diagnostic");
        expect(result.reason).toContain(diagnostic);
        expect(result.reason).not.toContain("EXAMPLE_TOKEN");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
