import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { shellEnvironment, windowsInvocation } = vi.hoisted(() => ({
  shellEnvironment: vi.fn(),
  windowsInvocation: vi.fn()
}));
vi.mock("../main/agentShellEnvironment", () => ({ readPosixShellEnvironment: shellEnvironment }));
vi.mock("@planweave-ai/runtime", () => ({
  agentProcessEnv: (options?: { env: NodeJS.ProcessEnv }) => options?.env ?? process.env,
  resolveWindowsProcessInvocation: windowsInvocation
}));
import { detectCliInstallation } from "../main/cliInstallation";

describe("CLI installation detection", () => {
  let directory: string;
  const platform = process.platform;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "planweave-cli-detection-"));
    shellEnvironment.mockResolvedValue({ kind: "loaded", environment: { PATH: directory } });
  });
  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  async function executable(name: string, body: string, root = directory) {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it.skipIf(process.platform === "win32")(
    "uses the first CLI on the login PATH and reads actual versions",
    async () => {
      const second = join(directory, "second");
      await mkdir(second);
      const path = await executable("planweave", 'echo "0.4.0"');
      await executable("planweave", 'echo "0.3.0"', second);
      await executable("node", 'echo "v22.13.0"');
      await executable("npm", 'echo "10.9.0"');
      shellEnvironment.mockResolvedValue({
        kind: "loaded",
        environment: { PATH: `${directory}:${second}` }
      });
      const result = await detectCliInstallation();
      expect(result.cli).toEqual({ status: "available", path, version: "0.4.0" });
      expect(result.nodeSupported).toBe(true);
      expect(result.npm.status).toBe("available");
    }
  );

  it.skipIf(process.platform === "win32")(
    "distinguishes a missing CLI from an installed command that fails",
    async () => {
      expect((await detectCliInstallation()).cli).toEqual({ status: "missing" });
      const path = await executable("planweave", 'echo "node is missing" >&2; exit 127');
      expect((await detectCliInstallation()).cli).toMatchObject({
        status: "unavailable",
        path,
        error: expect.stringContaining("node is missing")
      });
      await executable("planweave", 'echo "unexpected command output"');
      expect((await detectCliInstallation()).cli.status).toBe("unavailable");
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not recommend npm installation with an unsupported Node version",
    async () => {
      await executable("node", 'echo "v22.12.0"');
      await executable("npm", 'echo "10.9.0"');
      expect((await detectCliInstallation()).nodeSupported).toBe(false);
    }
  );

  it.skipIf(process.platform === "win32")(
    "reports verified command versions and leaves unverified installs unknown when the login shell fails",
    async () => {
      vi.stubEnv("PATH", directory);
      const path = await executable("planweave", 'echo "0.4.0"');
      shellEnvironment.mockResolvedValue({ kind: "unavailable", reason: "login shell timed out" });
      expect(await detectCliInstallation()).toEqual({
        cli: { status: "available", path, version: "0.4.0" },
        node: { status: "unknown" },
        npm: { status: "unknown" },
        nodeSupported: false,
        shellEnvironmentError: "login shell timed out"
      });
      shellEnvironment.mockResolvedValue({ kind: "loaded", environment: { PATH: directory } });
      expect(await detectCliInstallation()).toMatchObject({
        node: { status: "missing" },
        npm: { status: "missing" },
        shellEnvironmentError: null
      });
    }
  );

  it("runs the Windows resolver's invocation and reports the shim path", async () => {
    const node = process.execPath;
    Object.defineProperty(process, "platform", { value: "win32" });
    windowsInvocation.mockImplementation(({ command }: { command: string }) => ({
      command: node,
      args: ["-e", "process.stdout.write('22.13.0')"],
      target: { executable: `C:\\Users\\test\\npm\\${command}.cmd` },
      windowsVerbatimArguments: false
    }));
    const result = await detectCliInstallation();
    expect(result.cli).toEqual({
      status: "available",
      path: "C:\\Users\\test\\npm\\planweave.cmd",
      version: "22.13.0"
    });
  });
});
