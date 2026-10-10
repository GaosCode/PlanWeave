import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedProcesses from "../process/managedProcessTree.js";
import { withExecutorResultsWriteLease } from "../autoRun/executorResultsLifecycle.js";
import { execWithStreaming } from "../autoRun/executorShared.js";
import * as leases from "../package/executorResultsWriteLease.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { runProfileBlock } from "../autoRun/profileExecutor.js";
import { ExecutorCancelledError } from "../autoRun/executorCancellation.js";
import { readState } from "../state.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalPackageFileTarget } from "../package/packageFileConsistency.js";

const directories: string[] = [];
const crashedLeasePaths: string[] = [];
const owned: Awaited<ReturnType<typeof leases.acquireExecutorResultsWriteLease>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const lease of owned.splice(0)) {
    try {
      await lease.release();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await Promise.all(crashedLeasePaths.splice(0).map((path) => rm(path)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function observeLeases() {
  const acquire = leases.acquireExecutorResultsWriteLease;
  vi.spyOn(leases, "acquireExecutorResultsWriteLease").mockImplementation(async (...args) => {
    const lease = await acquire(...args);
    owned.push(lease);
    return lease;
  });
}
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error(`Executor I/O barrier timed out: ${path}`);
}
const claim = {
  kind: "block",
  ref: "T-001#R-001",
  taskId: "T-001",
  blockId: "R-001",
  blockType: "review",
  effectiveExecutor: "lease-review"
} as const;

describe("Executor results write leases", () => {
  it.each([
    false,
    true
  ])("covers real streaming and clean cancellation without blocking a child native writer (cancel=%s)", async (cancel) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    observeLeases();
    const workspace = fixture.init.workspace;
    const ready = join(fixture.root, "child-ready"),
      finish = join(fixture.root, "child-finish");
    const stateSource = new URL("../state.ts", import.meta.url).href;
    const program = `
      const fs=require('node:fs/promises');
      (async()=>{
        const {createEmptyState,writeState}=await import(${JSON.stringify(stateSource)});
        await writeState(${JSON.stringify(workspace.stateFile)},{...createEmptyState(),currentRefs:['T-001#B-001']});
        await fs.writeFile(${JSON.stringify(ready)},'ready');
        while(true){try{await fs.readFile(${JSON.stringify(finish)});break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}
        console.log(JSON.stringify({reviewBlockRef:'T-001#R-001',taskId:'T-001',verdict:'passed',content:'completed'}));
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `;
    const cancellation = new AbortController();
    const run = runProfileBlock({
      projectRoot: workspace,
      claim,
      prompt: "review",
      executorName: "lease-review",
      profile: {
        adapter: "local-review",
        command: process.execPath,
        args: ["--import", import.meta.resolve("tsx"), "-e", program]
      },
      runtime: { tmuxEnabled: false, timeoutMs: 5000, signal: cancellation.signal }
    });
    void run.catch(() => undefined);
    await waitForFile(ready);
    expect((await readState(workspace.stateFile)).currentRefs).toEqual(["T-001#B-001"]);
    const staged = join(workspace.workspaceRoot, "staged-results");
    await mkdir(staged, { recursive: true });
    const transaction = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "live-executor"
    });
    let denial: unknown;
    try {
      denial = await transaction.replacePath(workspace.resultsDir, staged).then(
        () => null,
        (error) => error
      );
      expect(
        await readJsonFile<{ ownerPid: number; resultsRoot: string }>(owned[0]!.path)
      ).toMatchObject({
        ownerPid: process.pid,
        resultsRoot: await canonicalPackageFileTarget(workspace.resultsDir)
      });
    } finally {
      if (cancel) cancellation.abort();
      else await writeFile(finish, "finish");
    }
    const result = await run.catch((error) => error);
    expect(denial).toBeInstanceOf(Error);
    expect(String(denial)).toMatch(/executor results write conflict.*block:T-001#R-001.*owner PID/);
    if (cancel) expect(result).toBeInstanceOf(ExecutorCancelledError);
    else expect(result).toMatchObject({ kind: "review" });
    await expect(readFile(owned[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await transaction.replacePath(workspace.resultsDir, staged);
    await transaction.rollback();
    const runRoot = join(workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001");
    if (cancel)
      expect(await readJsonFile(join(runRoot, "metadata.json"))).toMatchObject({
        outcome: "cancelled"
      });
    else
      expect(await readFile(join(runRoot, "review-result.json"), "utf8")).toContain(
        '"verdict": "passed"'
      );
  });
  it("rejects a new executor reservation while any pending target overlaps the results tree", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    const staged = join(workspace.workspaceRoot, "pending-results");
    await mkdir(staged, { recursive: true });
    const transaction = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "pending-executor"
    });
    await transaction.replacePath(workspace.resultsDir, staged);
    await expect(
      leases.acquireExecutorResultsWriteLease(workspace, "block:T-001#B-001")
    ).rejects.toThrow("write conflict");
    await transaction.rollback();
  });
  it("preflights a legacy active lease across all rollback targets before changing any target", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    await mkdir(workspace.resultsDir, { recursive: true });
    const companion = join(workspace.workspaceRoot, "companion.txt"),
      stagedCompanion = join(workspace.workspaceRoot, "companion-new.txt"),
      stagedResults = join(workspace.workspaceRoot, "results-new");
    await writeFile(companion, "old");
    await writeFile(stagedCompanion, "new");
    await mkdir(stagedResults, { recursive: true });
    const transaction = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "legacy-lease"
    });
    await transaction.replacePath(companion, stagedCompanion);
    await transaction.replacePath(workspace.resultsDir, stagedResults);
    await transaction.markCommitted();
    const lease = await leases.acquireExecutorResultsWriteLease(workspace, "legacy-writer");
    owned.push(lease);
    const journal = join(
      workspace.workspaceRoot,
      "desktop",
      "recovery",
      "package-import",
      "legacy-lease",
      "recovery.json"
    );
    const record = await readJsonFile<Record<string, unknown>>(journal);
    await writeJsonFile(journal, { ...record, state: "active" });
    const before = await readFile(journal, "utf8");
    const recovered = await ImportTransaction.recover({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "legacy-lease"
    });
    await expect(recovered.rollback()).rejects.toThrow("executor results write conflict");
    expect(await readFile(companion, "utf8")).toBe("new");
    expect(await readFile(journal, "utf8")).toBe(before);
    await lease.release();
    await recovered.rollback();
    expect(await readFile(companion, "utf8")).toBe("old");
  });
  it("releases clean cancellation and spawn failure using confirmed terminal evidence", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    observeLeases();
    const workspace = fixture.init.workspace;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProfileBlock({
        projectRoot: workspace,
        claim,
        prompt: "review",
        executorName: "lease-review",
        profile: {
          adapter: "local-review",
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},100)"]
        },
        runtime: { tmuxEnabled: false, signal: controller.signal }
      })
    ).rejects.toBeInstanceOf(ExecutorCancelledError);
    await expect(readFile(owned[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      runProfileBlock({
        projectRoot: workspace,
        claim,
        prompt: "review",
        executorName: "lease-review",
        profile: { adapter: "local-review", command: "planweave-no-such-executor", args: [] },
        runtime: { tmuxEnabled: false }
      })
    ).rejects.toThrow();
    await expect(readFile(owned[1]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      runProfileBlock({
        projectRoot: workspace,
        claim,
        prompt: "review",
        executorName: "lease-review",
        profile: {
          adapter: "local-review",
          command: process.execPath,
          args: ["-e", "process.exit(1)"]
        },
        runtime: { tmuxEnabled: false }
      })
    ).rejects.toThrow("exited with code 1");
    await expect(readFile(owned[2]!.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains ownership when actual native process-tree cleanup fails with a live child", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    observeLeases();
    const workspace = fixture.init.workspace;
    const actualSpawn = managedProcesses.spawnManagedProcess;
    let actual: ReturnType<typeof actualSpawn> | undefined;
    vi.spyOn(managedProcesses, "spawnManagedProcess").mockImplementation((options) => {
      const spawned = actualSpawn(options);
      actual = spawned;
      return {
        ...spawned,
        tree: {
          ...spawned.tree,
          terminate: async () => {
            throw new Error("native_tree_cleanup_failed");
          }
        }
      };
    });
    try {
      await expect(
        withExecutorResultsWriteLease(workspace, "cleanup-failed:T-001#R-001", () =>
          execWithStreaming({
            command: process.execPath,
            args: ["-e", "process.stdout.write('started');setInterval(()=>{},100)"],
            cwd: fixture.root,
            stdin: "",
            stdoutPath: join(workspace.resultsDir, "cleanup-test", "stdout.md"),
            stderrPath: join(workspace.resultsDir, "cleanup-test", "stderr.log"),
            onStdout: () => {
              throw new Error("output_callback_failed");
            },
            timeoutMs: 2000
          })
        )
      ).rejects.toThrow("process tree termination failed: native_tree_cleanup_failed");
      if (!actual) throw new Error("Native process was not spawned.");
      expect(actual.tree.isAlive()).toBe(true);
      expect(await readJsonFile(owned[0]!.path)).toMatchObject({
        status: "uncertain",
        ownerPid: process.pid
      });
      await expect(leases.assertNoExecutorResultsWriteLease(workspace.resultsDir)).rejects.toThrow(
        "Confirm the executor and its child/session writers have stopped"
      );
    } finally {
      if (actual) await actual.tree.terminate("test-confirmed-cleanup");
    }
  });
  it("preserves a crashed owner's lease until confirmed manual reconciliation", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    await mkdir(workspace.resultsDir, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      const {acquireExecutorResultsWriteLease}=await import(process.argv[2]);
      const lease=await acquireExecutorResultsWriteLease(JSON.parse(process.argv[1]),'crashed-block:T-001#B-001');
      process.stdout.write(JSON.stringify({path:lease.path,pid:process.pid})+'\\n');
      setInterval(()=>{},1000);
    `,
        JSON.stringify(workspace),
        new URL("../package/executorResultsWriteLease.ts", import.meta.url).href
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    let output = "",
      stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const started = new Promise<{ path: string; pid: number }>((resolve, reject) => {
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.includes("\n")) resolve(JSON.parse(output.trim()));
      });
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(stderr || "Lease owner exited before registration."))
      );
    });
    let record: { path: string; pid: number };
    try {
      record = await started;
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    crashedLeasePaths.push(record.path);
    const staged = join(workspace.workspaceRoot, "after-crash-results");
    await mkdir(staged, { recursive: true });
    const tx = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "crash-lease"
    });
    await expect(tx.replacePath(workspace.resultsDir, staged)).rejects.toThrow(
      `owner PID ${record.pid} (not alive)`
    );
    expect(await readJsonFile(record.path)).toMatchObject({
      ownerPid: record.pid,
      status: "writing"
    });
    await tx.rollback();
  });
});
