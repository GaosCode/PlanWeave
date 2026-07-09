import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initManagedWorkspace, initWorkspace } from "@planweave-ai/runtime";
import { ImportTransaction } from "../../../runtime/src/package/importTransaction.js";
import { createProgram } from "../index.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const previousPlanweaveHome = process.env.PLANWEAVE_HOME;
const previousInitCwd = process.env.INIT_CWD;

type CliFailure = Error & {
  code: number;
  stdout: string;
  stderr: string;
};

async function createExternalProject(): Promise<{ sourceRoot: string; workspaceRoot: string }> {
  process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-cli-source-"));
  const init = await initWorkspace({ projectRoot: sourceRoot });
  expect(init.workspace.workspaceRoot).not.toBe(init.workspace.rootPath);
  return { sourceRoot, workspaceRoot: init.workspace.workspaceRoot };
}

async function createManagedProject(): Promise<{ workspaceRoot: string }> {
  process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const init = await initManagedWorkspace({ name: `Import Recovery ${Date.now()}` });
  return { workspaceRoot: await realpath(init.workspace.workspaceRoot) };
}

function recoveryRoot(workspaceRoot: string, transactionId: string): string {
  return join(workspaceRoot, "desktop", "recovery", "package-import", transactionId);
}

async function createPendingReplaceTransaction(options: {
  workspaceRoot: string;
  transactionId: string;
}): Promise<{ target: string }> {
  const target = join(options.workspaceRoot, "canvases", "default", "state.json");
  const staged = join(options.workspaceRoot, "staged-state.json");
  await mkdir(join(options.workspaceRoot, "canvases", "default"), { recursive: true });
  await writeFile(target, "old state\n", "utf8");
  await writeFile(staged, "new state\n", "utf8");
  const transaction = await ImportTransaction.create({
    workspaceRoot: options.workspaceRoot,
    transactionId: options.transactionId
  });
  await transaction.replacePath(target, staged);
  return { target };
}

function isCliFailure(error: unknown): error is CliFailure {
  const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return (
    error instanceof Error &&
    typeof candidate.code === "number" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string"
  );
}

async function runCliExpectFailure(args: string[], env: NodeJS.ProcessEnv): Promise<CliFailure> {
  try {
    await execFileAsync(
      "pnpm",
      ["--silent", "--filter", "@planweave-ai/cli", "planweave", ...args],
      {
        cwd: repoRoot,
        env
      }
    );
  } catch (error) {
    if (isCliFailure(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected planweave ${args.join(" ")} to fail.`);
}

afterEach(() => {
  if (previousPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = previousPlanweaveHome;
  }
  if (previousInitCwd === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = previousInitCwd;
  }
  vi.restoreAllMocks();
});

describe("planweave import-recovery", () => {
  it("prints an empty pending list", async () => {
    const { workspaceRoot } = await createManagedProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(["--project-root", workspaceRoot, "import-recovery", "list"], {
      from: "user"
    });

    expect(log.mock.calls.at(-1)?.[0]).toBe("No pending package import recovery transactions.");
  });

  it("prints pending transactions as JSON", async () => {
    const { sourceRoot, workspaceRoot } = await createExternalProject();
    await createPendingReplaceTransaction({ workspaceRoot, transactionId: "tx-json" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(
      ["--project-root", sourceRoot, "import-recovery", "list", "--json"],
      { from: "user" }
    );

    expect(JSON.parse(log.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      pending: [
        {
          transactionId: "tx-json",
          recoveryRoot: recoveryRoot(workspaceRoot, "tx-json"),
          operationCount: 1,
          phases: ["installed"]
        }
      ]
    });
  });

  it("rolls back the requested transaction", async () => {
    const { sourceRoot, workspaceRoot } = await createExternalProject();
    const { target } = await createPendingReplaceTransaction({
      workspaceRoot,
      transactionId: "tx-rollback"
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(
      ["--project-root", sourceRoot, "import-recovery", "rollback", "tx-rollback", "--json"],
      {
        from: "user"
      }
    );

    expect(JSON.parse(log.mock.calls.at(-1)?.[0] ?? "{}")).toEqual({
      ok: true,
      transactionId: "tx-rollback"
    });
    await expect(readFile(target, "utf8")).resolves.toBe("old state\n");
    await expect(access(recoveryRoot(workspaceRoot, "tx-rollback"))).rejects.toThrow();
  });

  it("requires an explicit rollback transaction id", async () => {
    const { workspaceRoot } = await createManagedProject();
    const env = { ...process.env };
    delete env.INIT_CWD;

    const failure = await runCliExpectFailure(
      ["--project-root", workspaceRoot, "import-recovery", "rollback"],
      env
    );

    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("missing required argument 'transactionId'");
  });

  it("propagates rollback failures and keeps recovery", async () => {
    const { workspaceRoot } = await createManagedProject();
    await createPendingReplaceTransaction({ workspaceRoot, transactionId: "tx-failure" });
    await rm(join(recoveryRoot(workspaceRoot, "tx-failure"), "backups", "000001"), {
      recursive: true,
      force: true
    });

    await expect(
      createProgram().parseAsync(
        ["--project-root", workspaceRoot, "import-recovery", "rollback", "tx-failure"],
        { from: "user" }
      )
    ).rejects.toThrow("backup missing");
    await expect(
      access(join(recoveryRoot(workspaceRoot, "tx-failure"), "recovery.json"))
    ).resolves.toBeUndefined();
  });

  it("returns non-zero for rollback failures from the CLI entrypoint", async () => {
    const { workspaceRoot } = await createManagedProject();
    await createPendingReplaceTransaction({
      workspaceRoot,
      transactionId: "tx-entrypoint-failure"
    });
    await rm(join(recoveryRoot(workspaceRoot, "tx-entrypoint-failure"), "backups", "000001"), {
      recursive: true,
      force: true
    });
    const env = { ...process.env };
    delete env.INIT_CWD;

    const failure = await runCliExpectFailure(
      ["--project-root", workspaceRoot, "import-recovery", "rollback", "tx-entrypoint-failure"],
      env
    );

    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("backup missing");
    await expect(
      access(join(recoveryRoot(workspaceRoot, "tx-entrypoint-failure"), "recovery.json"))
    ).resolves.toBeUndefined();
  });
});
