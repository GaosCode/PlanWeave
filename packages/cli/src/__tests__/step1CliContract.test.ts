import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");

async function planweave(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("pnpm", ["--silent", "--filter", "@planweave/cli", "planweave", ...args], {
    cwd: repoRoot,
    env
  });
}

describe("STEP-1 CLI contract", () => {
  it("runs the documented block-level review feedback loop", async () => {
    const readme = await readFile(join(repoRoot, "examples/basic-plan-package/README.md"), "utf8");
    expect(readme).toContain("planweave prompt T-001#B-001");
    expect(readme).toContain("planweave submit-feedback --report");

    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await planweave(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const validation = JSON.parse((await planweave(["validate", "--json"], env)).stdout);
    expect(validation.ok).toBe(true);

    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    expect((await planweave(["prompt", "T-001#B-001"], env)).stdout).toContain("Create a small implementation report");
    const implementation = join(home, "implementation.md");
    await writeFile(implementation, "Implemented.\n", "utf8");
    await planweave(["submit-result", "T-001#B-001", "--report", implementation], env);

    expect(JSON.parse((await planweave(["claim", "--type", "review"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
    const review = join(home, "review.json");
    await writeFile(
      review,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "Adjust the implementation report."
      }),
      "utf8"
    );
    await planweave(["submit-review", "T-001#R-001", "--result", review], env);
    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toEqual({
      kind: "feedback",
      content: "Adjust the implementation report."
    });
    const feedback = join(home, "feedback.md");
    await writeFile(feedback, "Adjusted.\n", "utf8");
    await planweave(["submit-feedback", "--report", feedback], env);

    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      reason: "feedback_resolved"
    });
    await writeFile(
      review,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "passed",
        content: "Passed."
      }),
      "utf8"
    );
    await planweave(["submit-review", "T-001#R-001", "--result", review], env);
    const status = JSON.parse((await planweave(["status", "--json"], env)).stdout);
    expect(status.counts.tasks.implemented).toBe(1);
    expect(status.counts.blocks.completed).toBe(2);
  });
});
