import { access, chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  desktopAgentCapabilityProbeResultSchema,
  probeDesktopAgentCapabilities
} from "../desktop/agentCapabilityApi.js";
import { initManagedProject, linkProjectSourceRoot } from "../desktop/projectApi.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const fixture = new URL("./support/acpMockAgent.mjs", import.meta.url);
const wslFixture = vi.hoisted(() => ({ executable: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      actual.spawn(
        command === "wsl.exe" && wslFixture.executable ? wslFixture.executable : command,
        args,
        options
      )
  };
});

describe("desktop agent capability API", () => {
  it.skipIf(process.platform === "win32")(
    "launches the persisted WSL distribution's ACP executable in the linked source root",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "planweave-acp-wsl-probe-"));
      const settingsFile = join(temporary, "desktop-settings.json");
      const source = await realpath(await mkdtemp(join(tmpdir(), "planweave-linked-acp-")));
      const launchEvidence = join(temporary, "launch.json");
      const ubuntuExecutable = "/ubuntu/bin/codex-acp";
      const launcher = join(temporary, "wsl.exe");
      await writeFile(
        launcher,
        [
          `#!${process.execPath}`,
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          'if (args.includes("planweave-wsl-resolve")) {',
          `  console.log(${JSON.stringify(ubuntuExecutable)});`,
          '} else if (args.includes("-lc")) {',
          '  console.log("__PLANWEAVE_PATH_BEGIN__/ubuntu/bin:/usr/bin__PLANWEAVE_PATH_END__");',
          '} else if (args.includes("--cd")) {',
          `  fs.writeFileSync(${JSON.stringify(launchEvidence)}, JSON.stringify(args));`,
          '  process.argv[2] = "probe-session-config-current-second";',
          `  import(${JSON.stringify(fixture.href)});`,
          "} else {",
          '  console.log("exited");',
          "}"
        ].join("\n"),
        { mode: 0o755 }
      );
      vi.stubEnv("PLANWEAVE_HOME", join(temporary, "home"));
      vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", settingsFile);
      wslFixture.executable = launcher;
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        const project = await initManagedProject("ACP linked source");
        await linkProjectSourceRoot(project.projectId, source);
        await writeFile(
          settingsFile,
          JSON.stringify({ execution: { agentHost: { kind: "wsl", distribution: "Ubuntu" } } })
        );
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

        const result = await probeDesktopAgentCapabilities({
          agentKind: "codex",
          projectRoot: project.rootPath
        });
        expect(result.ok, result.message).toBe(true);
        expect(result).toMatchObject({
          executionHost: { kind: "wsl", distribution: "Ubuntu" },
          sessionConfig: {
            modes: { currentModeId: "agent-full-access" },
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: "model", currentValue: "gpt-5.2-codex" })
            ])
          }
        });
        const args = JSON.parse(await readFile(launchEvidence, "utf8"));
        expect(args.slice(0, 5)).toEqual(["--distribution", "Ubuntu", "--cd", source, "--exec"]);
        expect(args.at(-1)).toBe(ubuntuExecutable);
      } finally {
        if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
        wslFixture.executable = "";
        vi.unstubAllEnvs();
      }
    }
  );

  it("probes the canonical ACP definition when the manifest overrides the same executor name", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "planweave-agent-capability-bin-"));
    const marker = join(binDir, "manifest-executor-ran");
    const launcher = join(binDir, "codex-acp");
    await writeFile(
      launcher,
      [
        "#!/usr/bin/env node",
        'process.argv[2] = "probe-session-config-current-second";',
        `await import(${JSON.stringify(fixture.href)});`
      ].join("\n"),
      "utf8"
    );
    await chmod(launcher, 0o755);
    const manifest = manifestTestBuilder()
      .withExecutor("codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
      })
      .build();
    const { root } = await createTestWorkspace(manifest);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");

    try {
      const result = await probeDesktopAgentCapabilities({ agentKind: "codex", projectRoot: root });
      expect(desktopAgentCapabilityProbeResultSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        agentKind: "codex",
        ok: true,
        agentInfo: { name: "planweave-acp-mock", version: "1.0.0" },
        sessionConfig: {
          modes: {
            currentModeId: "agent-full-access"
          },
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: "model", currentValue: "gpt-5.2-codex" }),
            expect.objectContaining({ id: "fast-mode", currentValue: false })
          ])
        },
        checks: expect.arrayContaining([
          expect.objectContaining({ check: "acp_initialized", status: "passed" }),
          expect.objectContaining({ check: "acp_authenticated", status: "passed" })
        ])
      });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("projects actionable authentication and advertised capability without secret values", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "planweave-agent-auth-capability-bin-"));
    const launcher = join(binDir, "codex-acp");
    await writeFile(
      launcher,
      [
        "#!/usr/bin/env node",
        'process.argv[2] = "action-required";',
        `await import(${JSON.stringify(fixture.href)});`
      ].join("\n"),
      "utf8"
    );
    await chmod(launcher, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");

    try {
      const result = await probeDesktopAgentCapabilities({
        agentKind: "codex",
        projectRoot: null
      });
      expect(result).toMatchObject({
        ok: false,
        failureCode: "auth_required",
        authentication: {
          status: "action_required",
          reason: "no_safe_method",
          methods: [{ id: "mock-login", name: "Mock login", type: "agent" }]
        },
        capabilities: expect.arrayContaining(["authentication"]),
        checks: [
          expect.objectContaining({ check: "acp_initialized", status: "passed" }),
          expect.objectContaining({ check: "acp_capabilities", status: "passed" }),
          expect.objectContaining({
            check: "acp_authenticated",
            status: "failed",
            failureCode: "auth_required"
          })
        ]
      });
      expect(JSON.stringify(result)).not.toContain("Test-only authentication");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
