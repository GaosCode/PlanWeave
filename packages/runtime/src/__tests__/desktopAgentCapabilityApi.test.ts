import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopAgentCapabilityProbeResultSchema,
  probeDesktopAgentCapabilities
} from "../desktop/agentCapabilityApi.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const fixture = new URL("./support/acpMockAgent.mjs", import.meta.url);

describe("desktop agent capability API", () => {
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
