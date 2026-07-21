import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWindowsProcessInvocation } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { detectAgentTools } from "../main/agentTools";

const isWindows = process.platform === "win32";

async function writeWindowsProbe(directory: string, name: string, version: string): Promise<void> {
  const executable = join(directory, `${name}.cmd`);
  await writeFile(
    executable,
    ["@echo off", `echo ${version}`, "exit /b 0", ""].join("\r\n"),
    "utf8"
  );
}

describe.runIf(isWindows)("desktop agent tool detection on Windows", () => {
  it("detects npm-style .cmd shims and version probes through PATHEXT-aware resolution", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "planweave-agent-tools-win-"));
    await writeWindowsProbe(binDir, "codex", "codex-cli 9.9.9");
    await writeWindowsProbe(binDir, "pi", "0.80.10");
    await writeWindowsProbe(binDir, "opencode", "1.18.4");
    await writeWindowsProbe(binDir, "claude", "2.1.216 (Claude Code)");
    await writeWindowsProbe(binDir, "grok", "grok 0.2.106");

    const previousPath = process.env.Path ?? process.env.PATH;
    const previousPathExt = process.env.PATHEXT;
    // On Windows, Path and PATH are the same case-insensitive env key — never delete one
    // after setting the other or the bin directory is wiped from PATH.
    process.env.Path = `${binDir};${previousPath ?? ""}`;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.cmd";

    try {
      const agents = await detectAgentTools("win32");

      const byCommand = Object.fromEntries(
        agents
          .filter((agent) => agent.runnerKind === "cli")
          .map((agent) => [agent.command, { installed: agent.installed, version: agent.version }])
      );

      expect(byCommand.codex).toEqual({ installed: true, version: "codex-cli 9.9.9" });
      expect(byCommand.pi).toEqual({ installed: true, version: "0.80.10" });
      expect(byCommand.opencode).toEqual({ installed: true, version: "1.18.4" });
      expect(byCommand.claude).toEqual({
        installed: true,
        version: "2.1.216 (Claude Code)"
      });
      expect(byCommand.grok).toEqual({ installed: true, version: "grok 0.2.106" });

      const opencodeAcp = agents.find(
        (agent) => agent.kind === "opencode" && agent.runnerKind === "acp"
      );
      expect(opencodeAcp).toMatchObject({ installed: true });

      const missingAcp = agents.find((agent) => agent.command === "codex-acp");
      expect(missingAcp).toMatchObject({
        installed: false,
        installCommand: "npm install -g @agentclientprotocol/codex-acp",
        unavailableReason: expect.stringContaining("npm install -g @agentclientprotocol/codex-acp")
      });
    } finally {
      if (previousPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = previousPath;
      }
      if (previousPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = previousPathExt;
      }
    }
  }, 30_000);

  it("resolves and executes a batch shim with the same invocation strategy", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "planweave-agent-tools-batch-"));
    await writeWindowsProbe(binDir, "probe-agent", "probe-ok");
    const previousPath = process.env.Path ?? process.env.PATH;
    process.env.Path = `${binDir};${previousPath ?? ""}`;

    try {
      const invocation = resolveWindowsProcessInvocation({
        command: "probe-agent",
        args: ["--version"],
        env: process.env
      });
      expect(invocation).not.toBeNull();
      expect(invocation?.target.launchMode).toBe("batch");
      expect(invocation?.command.toLowerCase()).toContain("cmd.exe");

      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          invocation!.command,
          invocation!.args,
          {
            env: process.env,
            windowsVerbatimArguments: invocation!.windowsVerbatimArguments,
            windowsHide: true,
            timeout: 5_000
          },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(String(stdout).trim());
          }
        );
      });
      expect(output).toBe("probe-ok");
    } finally {
      if (previousPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = previousPath;
      }
    }
  }, 15_000);
});
