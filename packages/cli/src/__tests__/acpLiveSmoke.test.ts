import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const smokeScript = join(process.cwd(), "scripts/acp-live-smoke.mjs");

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
}

describe("ACP live smoke evidence program", () => {
  it("uses the run session identity, proves every gate check, and tightens evidence permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-live-smoke-"));
    const agent = join(root, "codex-acp");
    const planweave = join(root, "planweave-test");
    const evidencePath = join(root, "evidence.json");
    await executable(agent, 'console.log("codex-acp test-version");\n');
    await executable(planweave, `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("planweave test-version");
else if (args[0] === "trust") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "executors" && args[1] === "test") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "run") console.log(JSON.stringify({
  session: { sessionId: "SESSION-001" },
  steps: [{ kind: "submitted" }]
}));
else if (args[0] === "run-session" && args[1] === "SESSION-001") console.log(JSON.stringify({
  runnerReadModel: {
    events: [
      { body: { kind: "message" } },
      process.env.SMOKE_INTERACTION === "elicitation"
        ? { body: { kind: "interaction", interaction: { kind: "elicitation", requestId: "elicitation:1" } } }
        : { body: { kind: "interaction", interaction: { kind: "permission", requestId: "permission:1" } } },
      ...(process.env.SMOKE_INTERACTION === "no-result" ? [] : [{ body: {
        kind: "interaction_result",
        interactionKind: process.env.SMOKE_INTERACTION === "elicitation" ? "elicitation" : "permission",
        requestId: process.env.SMOKE_INTERACTION === "elicitation" ? "elicitation:1" : "permission:1",
        outcome: process.env.SMOKE_INTERACTION === "elicitation" ? "submitted" : "cancelled"
      } }])
    ],
    interaction: { persisted: true },
    terminal: true,
    cursor: { terminal: true }
  }
}));
else process.exit(2);
`);
    await writeFile(evidencePath, "stale\n", { encoding: "utf8", mode: 0o644 });

    const result = await execFileAsync(process.execPath, [
      smokeScript,
      "--profile", "codex-acp",
      "--evidence", evidencePath
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        PLANWEAVE_BIN: planweave
      }
    });

    expect(result.stdout).toContain("ACP-GATE codex-acp: passed");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      result: string;
      diagnostic: string | null;
      checks: Record<string, boolean>;
    };
    expect(evidence).toMatchObject({ result: "passed", diagnostic: null });
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
    expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);

    for (const scenario of ["elicitation", "no-result"]) {
      const failedEvidencePath = join(root, `${scenario}.json`);
      await expect(execFileAsync(process.execPath, [
        smokeScript,
        "--profile", "codex-acp",
        "--evidence", failedEvidencePath
      ], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          PLANWEAVE_BIN: planweave,
          SMOKE_INTERACTION: scenario
        }
      })).rejects.toMatchObject({ code: 1 });
      expect(JSON.parse(await readFile(failedEvidencePath, "utf8"))).toMatchObject({
        result: "failed",
        checks: { intervention: false }
      });
    }
  });
});
