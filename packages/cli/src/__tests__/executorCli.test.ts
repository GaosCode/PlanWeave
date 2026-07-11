import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliWorkflowTimeoutMs, runCli, runCliExpectFailure } from "./support/cliTestHarness.js";

describe("executor CLI preflight exit status", () => {
  it("trusts the exact launch command and args for all built-in ACP profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    await runCli(["init", "--json"], env);
    const expected = {
      "codex-acp": ["codex-acp", []],
      "claude-code-acp": ["claude-agent-acp", []],
      "opencode-acp": ["opencode", ["acp"]],
      "pi-acp": ["pi-acp", []]
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
  }, cliWorkflowTimeoutMs);

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
});
