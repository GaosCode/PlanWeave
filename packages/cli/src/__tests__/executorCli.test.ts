import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cliWorkflowTimeoutMs, runCli, runCliExpectFailure } from "./support/cliTestHarness.js";

describe("executor CLI preflight exit status", () => {
  it(
    "trusts the exact launch command and args for all built-in ACP profiles",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      await runCli(["init", "--json"], env);
      const expected = {
        "codex-acp": ["codex-acp", []],
        "claude-code-acp": ["claude-agent-acp", []],
        "opencode-acp": ["opencode", ["acp"]],
        "pi-acp": ["pi-acp", []],
        "grok-acp": ["grok", ["--no-auto-update", "agent", "stdio"]]
      } as const;
      for (const [profile, [command, args]] of Object.entries(expected)) {
        const result = JSON.parse(
          (await runCli(["trust", "executor", profile, "--json"], env)).stdout
        );
        expect(result).toMatchObject({
          executorName: profile,
          runnerKind: "acp",
          entry: { command, args }
        });
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "returns nonzero for failed JSON and human preflight while preserving success exit zero",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      await runCli(["init", "--json"], env);

      const jsonFailure = await runCliExpectFailure(
        ["executors", "test", "missing-profile", "--json"],
        env
      );
      expect(jsonFailure.code).toBe(1);
      expect(JSON.parse(jsonFailure.stdout)).toMatchObject({
        name: "missing-profile",
        ok: false,
        failureCode: "invalid_profile"
      });

      const humanFailure = await runCliExpectFailure(["executors", "test", "missing-profile"], env);
      expect(humanFailure.code).toBe(1);
      expect(humanFailure.stdout).toContain("Executor profile 'missing-profile' does not exist.");

      const success = await runCli(["executors", "test", "manual", "--json"], env);
      expect(JSON.parse(success.stdout)).toMatchObject({ name: "manual", ok: true });
    },
    cliWorkflowTimeoutMs
  );

  it(
    "emits authoritative ACP agentInfo in JSON without changing human output",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const bin = await mkdtemp(join(tmpdir(), "planweave-acp-bin-"));
      const mockAgent = fileURLToPath(
        new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
      );
      const command = join(bin, "codex-acp");
      await writeFile(
        command,
        `#!/usr/bin/env node\nprocess.argv[2] = "success";\nawait import(${JSON.stringify(pathToFileURL(mockAgent).href)});\n`,
        "utf8"
      );
      await chmod(command, 0o755);
      const env = {
        ...process.env,
        PLANWEAVE_HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`
      };
      await runCli(["init", "--json"], env);

      const json = JSON.parse(
        (await runCli(["executors", "test", "codex-acp", "--json"], env)).stdout
      );
      expect(json).toMatchObject({
        name: "codex-acp",
        ok: true,
        agentInfo: { name: "planweave-acp-mock", version: "1.0.0" }
      });

      const human = await runCli(["executors", "test", "codex-acp"], env);
      expect(human.stdout.trim()).toBe(
        "ok codex-acp agent=codex runner=acp: ACP runner preflight passed."
      );
    },
    cliWorkflowTimeoutMs
  );
});
