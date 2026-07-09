import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "pnpm",
    ["--silent", "--filter", "@planweave-ai/cli", "planweave", ...args],
    {
      cwd: repoRoot,
      env
    }
  );
}

async function expectCliFailure(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    await runCli(args, env);
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return {
      stdout: failed.stdout,
      stderr: failed.stderr,
      code: failed.code
    };
  }
  throw new Error(`Expected planweave ${args.join(" ")} to fail.`);
}

function withoutInitCwd(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.INIT_CWD;
  return next;
}

describe("CLI error handling", () => {
  it("reports uninitialized paths without leaking a stack trace", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const failure = await expectCliFailure(["--project-root", projectRoot, "paths"], env);

    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("PlanWeave workspace is not initialized for project:");
    expect(failure.stderr).toContain("planweave init --json");
    expect(failure.stderr).not.toContain("at ");
    expect(failure.stderr).not.toContain("node:internal");
  });

  it("reports uninitialized paths as machine-readable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const failure = await expectCliFailure(["--project-root", projectRoot, "paths", "--json"], env);
    const payload = JSON.parse(failure.stdout) as {
      initialized: boolean;
      projectRoot: string;
      workspaceDir: string;
      packageDir: string;
      nextCommands: string[];
    };

    expect(failure.code).toBe(1);
    expect(failure.stderr).toBe("");
    expect(payload.initialized).toBe(false);
    expect(payload.projectRoot).toBe(await realpath(projectRoot));
    expect(payload.workspaceDir).toBe(home);
    expect(payload.packageDir).toContain(home);
    expect(payload.nextCommands).toContain("planweave init --json");
  });

  it("formats uninitialized runtime command failures without leaking a stack trace", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const failure = await expectCliFailure(
      ["--project-root", projectRoot, "status", "--json"],
      env
    );

    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("PlanWeave workspace is not initialized for project:");
    expect(failure.stderr).not.toContain("at ");
    expect(failure.stderr).not.toContain("node:internal");
  });
});
