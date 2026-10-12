import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as content from "../package/importTransactionContent.js";
import * as consistency from "../package/packageFileConsistency.js";
import { setTimeout as delay } from "node:timers/promises";
import { listPendingImportTransactions } from "../package/importRecovery.js";
import {
  loadProjectGraphForWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/loadProjectGraph.js";
import {
  canvasStorageIdentityFile,
  writeNewCanvasStorageIdentity,
  writeNewResultsStorageIdentity
} from "../package/packageStorageIdentity.js";
import { withCanvasStorageReplacement } from "../package/withCanvasStorageMutation.js";
import { withCanvasStorageMutation } from "../package/withCanvasStorageMutation.js";
import { spawnImportStorageWriter } from "./helpers/importTransactionStorageWriterProcessFixture.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { createEmptyState, readState, writeState } from "../state.js";
import { createRunSession } from "../runSessions/repository.js";
import { writeFeedbackArtifact } from "../taskManager/feedbackArtifacts.js";
import { updateTaskIndex } from "../taskManager/resultIndex.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  tempWorkspace,
  writeText,
  recoveryRoot,
  realFs,
  readRecovery,
  recoverClean,
  writeJsonFile,
  type RecoveryJson
} from "./support/importTransactionTestHarness.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
describe("Import transaction write reservations", () => {
  it("recovers admission after a real storage writer exits before publication", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.root, fixture.home);
    const workspace = fixture.init.workspace;
    const original = await readFile(workspace.stateFile, "utf8");
    const writer = spawnImportStorageWriter(workspace, "state", true);
    try {
      await writer.ready;
    } finally {
      writer.child.kill("SIGTERM");
      await writer.done;
    }
    expect(await readFile(workspace.stateFile, "utf8")).toBe(original);
    const transaction = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: "after-writer-exit"
    });
    await transaction.commit();
    expect(await listPendingImportTransactions(workspace.workspaceRoot)).toEqual([]);
  });
  it.each([
    "graph",
    "canvas",
    "results"
  ] as const)("preserves a pending %s replacement across ordinary writes", async (kind) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.root, fixture.home);
    const workspace = fixture.init.workspace;
    const project = (await loadProjectGraphForWorkspace(workspace)).workspace;
    const graph = (await loadProjectGraphForWorkspace(workspace)).manifest;
    const target =
      kind === "graph"
        ? projectGraphPath(project)
        : kind === "canvas"
          ? canvasStorageIdentityFile(workspace)
          : join(dirname(workspace.resultsDir), "results.results-instance.json");
    if (kind === "graph") await writeProjectGraph(project, graph);
    else if (kind === "canvas") await writeNewCanvasStorageIdentity(workspace);
    else await writeNewResultsStorageIdentity(workspace);
    const original = await readFile(target, "utf8");
    const staged = join(workspace.workspaceRoot, `staged-${kind}.json`);
    await writeText(staged, original);
    const transaction = await ImportTransaction.create({
      workspaceRoot: project.workspaceRoot,
      transactionId: `reserved-${kind}`
    });
    await transaction.replacePath(target, staged);
    const installed = await readFile(target, "utf8");
    let entered = false;
    try {
      const write =
        kind === "graph"
          ? writeProjectGraph(project, {
              ...graph,
              canvases: graph.canvases.map((canvas) => ({ ...canvas, title: "Changed" }))
            })
          : withCanvasStorageReplacement(workspace, async () => {
              entered = true;
              if (kind === "canvas") await writeNewCanvasStorageIdentity(workspace);
              else await writeNewResultsStorageIdentity(workspace);
            });
      await expect(write).rejects.toThrow("write conflict");
      expect(entered).toBe(false);
      expect(await readFile(target, "utf8")).toBe(installed);
    } finally {
      await transaction.rollback();
    }
    expect(await readFile(target, "utf8")).toBe(original);
  });
  it.each(
    ["write", "list", "process"].flatMap((kind) =>
      ["publish", "cleanup"].map((phase) => ({ kind, phase }))
    )
  )("waits for $phase admission before $kind, while another workspace remains writable", async ({
    kind,
    phase
  }) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.root, fixture.home);
    const workspace = fixture.init.workspace;
    const workspaceRoot = workspace.workspaceRoot;
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creation = ImportTransaction.create({
      workspaceRoot,
      transactionId: "journal-admission",
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          if (phase === "publish") {
            entered();
            await proceed;
          }
          return writeJsonFile(path, value);
        },
        rm: async (path, options) => {
          await realFs.rm(path, options);
          if (phase === "cleanup") {
            entered();
            await proceed;
          }
        }
      }
    });
    const lifecycle =
      phase === "publish"
        ? creation
        : creation.then(async (transaction) => {
            await transaction.commit();
            return transaction;
          });
    await paused;
    let completed = false;
    const actor = kind === "process" ? spawnImportStorageWriter(workspace, "state") : null;
    const reader = (
      actor
        ? actor.done.then(({ code, stderr }) => {
            if (code !== 0) throw new Error(stderr);
          })
        : kind === "write"
          ? writeState(workspace.stateFile, createEmptyState())
          : listPendingImportTransactions(workspaceRoot)
    )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      .finally(() => {
        completed = true;
      });
    try {
      if (actor) await actor.ready;
      else await delay(40);
      expect(completed).toBe(false);
      const unrelated = await tempWorkspace();
      directories.push(unrelated);
      await writeState(join(unrelated, "state.json"), createEmptyState());
      release();
      const transaction = await lifecycle;
      expect(await reader).not.toHaveProperty("error");
      if (kind === "write")
        expect(await readState(workspace.stateFile)).toEqual(createEmptyState());
      else if (kind === "process")
        expect((await readState(workspace.stateFile)).currentRefs).toEqual(["T-001#B-001"]);
      else
        expect(await reader).toMatchObject({
          result: phase === "publish" ? [{ transactionId: "journal-admission" }] : []
        });
      if (phase === "publish") await transaction.rollback();
    } finally {
      release();
      await lifecycle;
      await reader;
    }
  });

  it.each([
    { later: false, legacy: false },
    { later: true, legacy: false },
    { later: false, legacy: true }
  ])("resumes repeated-target rollback after restore journal failure without admitting later writes (later=$later, legacy=$legacy)", async ({
    later,
    legacy
  }) => {
    const workspaceRoot = await tempWorkspace(),
      transactionId = "repeated-restore-journal";
    directories.push(workspaceRoot);
    const target = join(workspaceRoot, "desktop", "layout.json"),
      first = join(workspaceRoot, "first.json"),
      second = join(workspaceRoot, "second.json");
    await writeText(target, "old\n");
    await writeText(first, "first\n");
    await writeText(second, "second\n");
    let failed = false;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      writeIsolationTargets: [target],
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          const operations = (value as RecoveryJson).operations;
          if (
            !failed &&
            operations.length === 2 &&
            operations[0]?.phase === "installed" &&
            operations[1]?.phase === "rolledBack"
          ) {
            failed = true;
            throw new Error("restore_progress_write_failed");
          }
          await writeJsonFile(path, value);
        }
      }
    });
    await transaction.replacePath(target, first);
    await transaction.replacePath(target, second);
    await expect(transaction.rollback()).rejects.toThrow("restore_progress_write_failed");
    expect(
      (await readRecovery(workspaceRoot, transactionId)).operations.map((op) => op.phase)
    ).toEqual(["installed", "rollingBackFromInstalled"]);
    expect(await readFile(target, "utf8")).toBe("first\n");
    if (later) {
      const staged = join(workspaceRoot, "later.json");
      await writeText(staged, "newer-successful-write\n");
      const writer = await ImportTransaction.create({
        workspaceRoot,
        transactionId: "later-writer"
      });
      const recoveryFile = join(recoveryRoot(workspaceRoot, transactionId), "recovery.json");
      const before = await readFile(recoveryFile, "utf8");
      await expect(writer.replacePath(target, staged)).rejects.toThrow("write conflict");
      expect(await readFile(target, "utf8")).toBe("first\n");
      expect(await readFile(staged, "utf8")).toBe("newer-successful-write\n");
      expect(await readFile(recoveryFile, "utf8")).toBe(before);
      await writer.rollback();
    }
    if (legacy) {
      const recoveryFile = join(recoveryRoot(workspaceRoot, transactionId), "recovery.json");
      const record = await readRecovery(workspaceRoot, transactionId);
      await writeJsonFile(recoveryFile, { ...record, writeIsolationTargets: undefined });
      await writeText(target, "legacy later successful write\n");
      const before = await readFile(recoveryFile, "utf8");
      const backup = record.operations[0]?.backupPath;
      if (!backup) throw new Error("Missing original backup");
      const original = await readFile(backup, "utf8");
      const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
      await expect(recovered.rollback()).rejects.toThrow("durable write reservation");
      expect(await readFile(target, "utf8")).toBe("legacy later successful write\n");
      expect(await readFile(backup, "utf8")).toBe(original);
      expect(await readFile(recoveryFile, "utf8")).toBe(before);
      return;
    }
    await recoverClean(workspaceRoot, transactionId);
    expect(await readFile(target, "utf8")).toBe("old\n");
  });
  it.each([
    { kind: "state", later: false },
    { kind: "state", later: true },
    { kind: "results", later: false },
    { kind: "results", later: true }
  ])("preserves every target when interrupted $kind restore has no guarded ownership (later=$later)", async ({
    kind,
    later
  }) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    const workspaceRoot = workspace.workspaceRoot;
    const target = kind === "state" ? workspace.stateFile : workspace.resultsDir;
    const companion = join(workspaceRoot, "companion.txt");
    await writeText(companion, "original companion\n");
    await mkdir(workspace.resultsDir, { recursive: true });
    const stagedCompanion = join(workspaceRoot, "staged-companion.txt");
    await writeText(stagedCompanion, "installed companion\n");
    const first = join(workspaceRoot, "staged-first");
    const second = join(workspaceRoot, "staged-second");
    for (const path of [first, second]) {
      if (kind === "state") await writeJsonFile(path, createEmptyState());
      else {
        await mkdir(join(path, "T-001"), { recursive: true });
        await writeJsonFile(join(path, "T-001", "index.json"), { counts: { runs: 1 } });
      }
    }
    let failed = false;
    const transactionId = `unreserved-${kind}`;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        writeJsonFile: async (path, value) => {
          const operations = (value as RecoveryJson).operations;
          if (!failed && operations.length === 3 && operations[2]?.phase === "rolledBack") {
            failed = true;
            throw new Error("restore_progress_write_failed");
          }
          await writeJsonFile(path, value);
        }
      }
    });
    await transaction.replacePath(companion, stagedCompanion);
    await transaction.replacePath(target, first);
    await transaction.replacePath(target, second);
    await expect(transaction.rollback()).rejects.toThrow("restore_progress_write_failed");
    expect(
      (await readRecovery(workspaceRoot, transactionId)).operations.map((op) => op.phase)
    ).toEqual(["installed", "installed", "rollingBackFromInstalled"]);
    if (later) {
      await expect(
        kind === "state"
          ? writeState(target, createEmptyState())
          : updateTaskIndex(workspace, "T-001", (index) => index)
      ).rejects.toThrow("write conflict");
      if (kind === "results") {
        await expect(createRunSession({ projectRoot: workspace, kind: "run" })).rejects.toThrow(
          "write conflict"
        );
        await expect(
          writeFeedbackArtifact(workspace, "T-001", {
            feedbackId: "FE-001",
            sourceReviewBlockRef: "T-001#R-001",
            sourceReviewAttemptId: "REV-001",
            content: "feedback",
            status: "open",
            createdAt: "2026-10-10T00:00:00.000Z"
          })
        ).rejects.toThrow("write conflict");
      }
    }
    const currentPath = kind === "state" ? target : join(target, "T-001", "index.json");
    const current = await readFile(currentPath, "utf8");
    const journalPath = join(recoveryRoot(workspaceRoot, transactionId), "recovery.json");
    const journal = await readFile(journalPath, "utf8");
    const record = await readRecovery(workspaceRoot, transactionId);
    const backup = record.operations[0]?.backupPath;
    if (!backup) throw new Error("Missing companion backup");
    const oldCompanion = await readFile(backup, "utf8");
    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    await expect(recovered.rollback()).rejects.toThrow("durable write reservation");
    expect(await readFile(currentPath, "utf8")).toBe(current);
    expect(await readFile(companion, "utf8")).toBe("installed companion\n");
    expect(await readFile(backup, "utf8")).toBe(oldCompanion);
    expect(await readFile(journalPath, "utf8")).toBe(journal);
  });
  it.each([
    { kind: "state", later: false },
    { kind: "state", later: true },
    { kind: "results", later: false },
    { kind: "results", later: true }
  ])("uses durable restored $kind identity for partial recovery (later=$later)", async ({
    kind,
    later
  }) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    const workspaceRoot = workspace.workspaceRoot;
    const target = kind === "state" ? workspace.stateFile : workspace.resultsDir;
    await mkdir(join(workspace.resultsDir, "T-001"), { recursive: true });
    await writeJsonFile(join(workspace.resultsDir, "T-001", "index.json"), { counts: { runs: 1 } });
    const companion = join(workspaceRoot, "companion.txt");
    await writeText(companion, "original companion\n");
    const stagedCompanion = join(workspaceRoot, "staged-companion.txt");
    await writeText(stagedCompanion, "installed companion\n");
    const staged = join(workspaceRoot, "staged-runtime");
    if (kind === "state") await writeJsonFile(staged, createEmptyState());
    else await mkdir(staged, { recursive: true });
    let failRemoval = true;
    const transactionId = `restored-${kind}`;
    const transaction = await ImportTransaction.create({
      workspaceRoot,
      transactionId,
      fs: {
        ...realFs,
        rm: async (path, options) => {
          if (path === companion && failRemoval) {
            failRemoval = false;
            throw new Error("companion removal failed");
          }
          await realFs.rm(path, options);
        }
      }
    });
    await transaction.replacePath(companion, stagedCompanion);
    await transaction.replacePath(target, staged);
    await expect(transaction.rollback()).rejects.toThrow("companion removal failed");
    const record = await readRecovery(workspaceRoot, transactionId);
    expect(record.operations.map((op) => op.phase)).toEqual([
      "rollingBackFromInstalled",
      "rolledBack"
    ]);
    const raw = await realFs.readJsonFile<{
      operations: Array<{ restoredIdentityDigest?: string }>;
    }>(join(recoveryRoot(workspaceRoot, transactionId), "recovery.json"));
    expect(raw.operations[1]?.restoredIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    if (later) {
      await expect(
        kind === "state"
          ? writeState(target, await readState(target))
          : updateTaskIndex(workspace, "T-001", (index) => index)
      ).rejects.toThrow("write conflict");
    }
    const currentPath = kind === "state" ? target : join(target, "T-001", "index.json");
    const current = await readFile(currentPath, "utf8");
    const journalPath = join(recoveryRoot(workspaceRoot, transactionId), "recovery.json");
    const journal = await readFile(journalPath, "utf8");
    const recovered = await ImportTransaction.recover({ workspaceRoot, transactionId });
    if (later) expect(await readFile(journalPath, "utf8")).toBe(journal);
    await recovered.rollback();
    expect(await readFile(companion, "utf8")).toBe("original companion\n");
    expect(await readFile(currentPath, "utf8")).toBe(current);
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("Import recovery and native storage writers", () => {
  it.each([
    { kind: "state", process: false },
    { kind: "results", process: false },
    { kind: "state", process: true },
    { kind: "results", process: true }
  ] as const)("serializes $kind writer after full preflight (child=$process)", async ({
    kind,
    process: childProcess
  }) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    await mkdir(workspace.resultsDir, { recursive: true });
    const staged = join(workspace.workspaceRoot, "staged-storage");
    if (kind === "state") await writeJsonFile(staged, createEmptyState());
    else {
      await mkdir(join(staged, "T-001"), { recursive: true });
      await writeJsonFile(join(staged, "T-001", "index.json"), { counts: { runs: 1 } });
    }
    const target = kind === "state" ? workspace.stateFile : workspace.resultsDir;
    const tx = await ImportTransaction.create({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: `preflight-${kind}`
    });
    await tx.replacePath(target, staged);
    const inspected = barrier(),
      resume = barrier();
    const digest = content.importTransactionIdentityDigest;
    let held = false;
    vi.spyOn(content, "importTransactionIdentityDigest").mockImplementation(async (path) => {
      const value = await digest(path);
      if (path === target && !held) {
        held = true;
        inspected.release();
        await resume.promise;
      }
      return value;
    });
    const rollback = tx.rollback();
    await inspected.promise;
    if (childProcess) {
      const actor = spawnImportStorageWriter(workspace, kind);
      let contended = false;
      try {
        await actor.ready;
        contended = actor.observedContention;
      } finally {
        resume.release();
      }
      await rollback;
      expect(await actor.done).toEqual({ code: 0, stderr: "" });
      expect(contended).toBe(true);
    } else {
      const entered = barrier();
      const acquire = consistency.withPackageFileConsistency;
      vi.spyOn(consistency, "withPackageFileConsistency").mockImplementation(
        async (roots, action) => {
          entered.release();
          return acquire(roots, action);
        }
      );
      const writer =
        kind === "state"
          ? writeState(target, { ...createEmptyState(), currentRefs: ["T-001#B-001"] })
          : updateTaskIndex(workspace, "T-001", (index) => ({
              ...index,
              counts: { ...index.counts, runs: 2 }
            }));
      let observed = "";
      try {
        observed = await Promise.race([
          entered.promise.then(() => "requested"),
          writer.then(() => "finished")
        ]);
      } finally {
        resume.release();
      }
      await rollback;
      await writer;
      expect(observed).toBe("requested");
    }
    if (kind === "state")
      expect((await readState(workspace.stateFile)).currentRefs).toEqual(["T-001#B-001"]);
    else
      expect(
        JSON.parse(await readFile(join(workspace.resultsDir, "T-001", "index.json"), "utf8")).counts
          .runs
      ).toBe(2);
  });
  it("reenters storage locks using the actual custom workspace roots", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const initial = fixture.init.workspace;
    const workspace = {
      ...initial,
      stateFile: join(initial.workspaceRoot, "custom-state", "runtime.json"),
      resultsDir: join(initial.workspaceRoot, "custom-results")
    };
    const original = await readFile(initial.stateFile, "utf8");
    await writeState(workspace.stateFile, createEmptyState());
    await withCanvasStorageMutation(workspace, async () => {
      await writeState(workspace.stateFile, {
        ...createEmptyState(),
        currentRefs: ["T-001#B-001"]
      });
      await updateTaskIndex(workspace, "T-001", () => ({ counts: { runs: 2 } }));
    });
    expect((await readState(workspace.stateFile)).currentRefs).toEqual(["T-001#B-001"]);
    expect(
      JSON.parse(await readFile(join(workspace.resultsDir, "T-001", "index.json"), "utf8")).counts
        .runs
    ).toBe(2);
    expect(await readFile(initial.stateFile, "utf8")).toBe(original);
  });
});
