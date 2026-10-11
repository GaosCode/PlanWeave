import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as json from "../json.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
import { buildPlanPackageTaskFieldEditMutation } from "../graph/fieldEditMutation.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import type { PlanGraphCommand } from "../plangraph/commands.js";
import { readState } from "../state.js";
import { updateCanvasExecutionPolicy } from "../desktop/graph/editModelUpdate.js";
import { initManagedProject, renameProject } from "../desktop/projectApi.js";
import {
  claimNext,
  submitBlockResult,
  submitReviewResult,
  retryReview
} from "../taskManager/index.js";
import { resetMaxCycleReviewsForRetryWithRollback } from "../taskManager/reviewRetry.js";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";
import { spawnReviewRetryActor } from "./helpers/reviewRetryProcessFixture.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});
vi.mock("../package/packageFileConsistency.js", async (original) => {
  const actual = await original<typeof import("../package/packageFileConsistency.js")>();
  return { ...actual, withPackageFileConsistency: vi.fn(actual.withPackageFileConsistency) };
});
afterEach(() => vi.restoreAllMocks());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function exhausted() {
  const fixture = await createTestWorkspace(
    basicManifest({ reviewMaxFeedbackCycles: 0, includeSecondTask: true })
  );
  await claimNext({ projectRoot: fixture.init.workspace });
  await submitBlockResult({
    projectRoot: fixture.init.workspace,
    ref: "T-001#B-001",
    reportPath: await writeReport(fixture.root, "implementation.md")
  });
  await claimNext({ projectRoot: fixture.init.workspace });
  await submitReviewResult({
    projectRoot: fixture.init.workspace,
    ref: "T-001#R-001",
    resultPath: await writeReviewResult(fixture.root, "needs_changes", "Exhausted.")
  });
  return fixture;
}
async function watchRequest(packageDir: string) {
  const actual = await vi.importActual<typeof import("../package/packageFileConsistency.js")>(
    "../package/packageFileConsistency.js"
  );
  const requested = deferred();
  vi.mocked(withPackageFileConsistency).mockImplementation(async (roots, action) => {
    if (roots.includes(packageDir)) requested.resolve();
    return actual.withPackageFileConsistency(roots, action);
  });
  return { promise: requested.promise };
}
async function assertRetry(workspace: Awaited<ReturnType<typeof exhausted>>["init"]["workspace"]) {
  const { manifest } = await loadPackage(workspace);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
  if (task?.type !== "task") throw new Error("Missing Task");
  const review = task.blocks.find((block) => block.id === "R-001");
  expect(review?.type === "review" && review.review.maxFeedbackCycles).toBe(3);
  expect((await readState(workspace.stateFile)).blocks["T-001#R-001"]).toMatchObject({
    status: "ready",
    completionReason: null
  });
  const index = await json.readJsonFile<{ reviewCompletionReasonByBlock?: Record<string, string> }>(
    join(workspace.resultsDir, "T-001", "index.json")
  );
  expect(index.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  return manifest;
}

it.each([
  "title",
  "add",
  "remove",
  "delete review",
  "delete task"
] as const)("reloads authority after a preceding %s edit without restoring removed nodes", async (kind) => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const { manifest } = await loadPackage(workspace);
  const template = manifest.nodes.find((node) => node.type === "task" && node.id === "T-002");
  if (template?.type !== "task") throw new Error("Missing template");
  const task = {
    ...template,
    id: "T-003",
    prompt: "nodes/T-003/prompt.md",
    blocks: template.blocks.map((block) => ({
      ...block,
      prompt: `nodes/T-003/blocks/${block.id}.prompt.md`
    }))
  };
  const command: PlanGraphCommand =
    kind === "title"
      ? { type: "updateTaskFields", taskId: "T-002", fields: { title: "Concurrent title" } }
      : kind === "add"
        ? {
            type: "addTask",
            snapshot: {
              task,
              taskPromptMarkdown: "Task",
              blockPromptMarkdown: task.blocks.map((block) => ({
                blockId: block.id,
                markdown: "Block"
              })),
              insertIndex: null,
              affectedTaskEdges: []
            }
          }
        : kind === "remove"
          ? { type: "removeTask", taskId: "T-002" }
          : kind === "delete review"
            ? { type: "removeBlock", blockRef: "T-001#R-001" }
            : { type: "removeTask", taskId: "T-001" };
  const edited = deferred(),
    release = deferred();
  const writer = withPackageFileConsistency(
    [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
    async () => {
      const result = await executePlanGraphCommand({
        projectRoot: workspace,
        command,
        recordOperation: false
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      edited.resolve();
      await release.promise;
      return result;
    }
  );
  await Promise.race([edited.promise, writer]);
  const protectedPaths = [
    workspace.manifestFile,
    workspace.stateFile,
    join(workspace.resultsDir, "T-001", "index.json")
  ];
  const editedBytes = await Promise.all(protectedPaths.map((path) => fs.readFile(path, "utf8")));
  const { promise: requested } = await watchRequest(workspace.packageDir);
  const retry = retryReview({
    projectRoot: workspace,
    ref: "T-001#R-001",
    maxFeedbackCycles: 3
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  try {
    await requested;
  } finally {
    release.resolve();
  }
  expect((await writer).ok).toBe(true);
  const outcome = await retry;
  if (kind.startsWith("delete")) {
    expect(outcome).toHaveProperty("error");
    if (!("error" in outcome)) throw new Error("Expected deleted target error");
    expect(String(outcome.error)).toContain("does not exist");
    expect(await Promise.all(protectedPaths.map((path) => fs.readFile(path, "utf8")))).toEqual(
      editedBytes
    );
    const { manifest: final } = await loadPackage(workspace);
    if (kind === "delete task") expect(final.nodes.some((node) => node.id === "T-001")).toBe(false);
    else {
      const target = final.nodes.find((node) => node.type === "task" && node.id === "T-001");
      expect(target?.type === "task" && target.blocks.some((block) => block.id === "R-001")).toBe(
        false
      );
    }
  } else {
    expect(outcome).toHaveProperty("value.reset", true);
    const final = await assertRetry(workspace);
    if (kind === "title")
      expect(final.nodes.find((node) => node.id === "T-002")?.title).toBe("Concurrent title");
    if (kind === "add") {
      expect(final.nodes.find((node) => node.id === "T-003")).toEqual(task);
      expect((await readState(workspace.stateFile)).blocks["T-003#B-001"]).toMatchObject({
        status: "ready"
      });
    }
    if (kind === "remove") expect(final.nodes.some((node) => node.id === "T-002")).toBe(false);
  }
});

it("rejects a graph mutation prepared before retry without overwriting its successful files", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const { manifest } = await loadPackage(workspace);
  const stale = buildPlanPackageTaskFieldEditMutation(manifest, {
    taskId: "T-002",
    title: "Stale title"
  });
  await retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  const paths = [
    workspace.manifestFile,
    workspace.stateFile,
    join(workspace.resultsDir, "T-001", "index.json")
  ];
  const before = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
  const result = await commitPlanPackageGraphMutation({ projectRoot: workspace, mutation: stale });
  expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "manifest_version_conflict" }] });
  expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(before);
  await assertRetry(workspace);
});

it("keeps rollback protected until a queued graph writer can commit on the restored authority", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const { manifest } = await loadPackage(workspace);
  const mutation = buildPlanPackageTaskFieldEditMutation(manifest, {
    taskId: "T-002",
    title: "After rollback"
  });
  const paths = [workspace.stateFile, join(workspace.resultsDir, "T-001", "index.json")];
  const before = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
  const originalJson = json.writeJsonFile;
  const originalFs = await vi.importActual<typeof fs>("node:fs/promises");
  const restoring = deferred(),
    release = deferred();
  const failure = new Error("State write failed");
  vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
    if (path === workspace.stateFile) throw failure;
    return originalJson(path, value, options);
  });
  vi.mocked(fs.writeFile).mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === workspace.manifestFile) {
      restoring.resolve();
      await release.promise;
    }
    return Reflect.apply(originalFs.writeFile, originalFs, args);
  });
  const retry = retryReview({
    projectRoot: workspace,
    ref: "T-001#R-001",
    maxFeedbackCycles: 3
  }).catch((error) => error);
  await restoring.promise;
  const { promise: requested } = await watchRequest(workspace.packageDir);
  const writer = commitPlanPackageGraphMutation({ projectRoot: workspace, mutation });
  try {
    await requested;
  } finally {
    release.resolve();
  }
  expect(await retry).toBe(failure);
  expect((await writer).ok).toBe(true);
  expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(before);
  const { manifest: final } = await loadPackage(workspace);
  expect(final.nodes.find((node) => node.id === "T-002")?.title).toBe("After rollback");
  const target = final.nodes.find((node) => node.type === "task" && node.id === "T-001");
  expect(
    target?.type === "task" &&
      target.blocks.find((block) => block.type === "review")?.review.maxFeedbackCycles
  ).toBe(0);
});

it("retains the Auto Run reset transaction and makes repeated rollback preserve later retry", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const paths = [workspace.stateFile, join(workspace.resultsDir, "T-001", "index.json")];
  const before = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
  const transaction = await withCanvasLock(dirname(workspace.stateFile), async () => {
    const result = await resetMaxCycleReviewsForRetryWithRollback({
      projectRoot: workspace,
      scope: { kind: "block", blockRef: "T-001#R-001" }
    });
    expect(result.refs).toEqual(["T-001#R-001"]);
    expect(
      (await readState(workspace.stateFile)).blocks["T-001#R-001"].completionReason
    ).toBeNull();
    await result.rollback();
    return result;
  });
  expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(before);
  await retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  const committed = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
  await transaction.rollback();
  expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(committed);
  await assertRetry(workspace);
});

it("waits for a real child writer holding the package lock, then retains both successful changes", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const actor = spawnReviewRetryActor(workspace, true);
  await actor.ready;
  const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  const attempted = deferred();
  vi.mocked(fs.mkdir).mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    try {
      return await Reflect.apply(actualFs.mkdir, actualFs, args);
    } catch (error) {
      if (
        String(args[0]).includes("package-locks/") &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )
        attempted.resolve();
      throw error;
    }
  });
  const retry = retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  try {
    await attempted.promise;
  } finally {
    actor.child.stdin.write("continue\n");
  }
  expect(await actor.done).toEqual({ code: 0, stderr: "" });
  expect(await retry).toMatchObject({ reset: true });
  const manifest = await assertRetry(workspace);
  expect(manifest.nodes.find((node) => node.id === "T-002")?.title).toBe("Child edit");
});

it("holds package and canvas through retry while a real child edit contends and preserves both successful changes", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const original = json.writeJsonFile;
  let actor: ReturnType<typeof spawnReviewRetryActor> | undefined;
  vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
    if (path === workspace.stateFile && !actor) {
      actor = spawnReviewRetryActor(workspace, false);
      await actor.ready;
      expect(actor.observedHeld).toBe(true);
    }
    return original(path, value, options);
  });
  await retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  if (!actor) throw new Error("Missing child writer");
  expect(await actor.done).toEqual({ code: 0, stderr: "" });
  const manifest = await assertRetry(workspace);
  expect(manifest.nodes.find((node) => node.id === "T-002")?.title).toBe("Child edit");
});

it("rejects a stale execution-policy producer without changing retry files", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const actual = await vi.importActual<typeof import("../package/packageFileConsistency.js")>(
    "../package/packageFileConsistency.js"
  );
  const queued = deferred(),
    release = deferred();
  let intercept = true;
  vi.mocked(withPackageFileConsistency).mockImplementation(async (roots, action) => {
    if (intercept && roots.includes(workspace.packageDir)) {
      intercept = false;
      queued.resolve();
      await release.promise;
    }
    return actual.withPackageFileConsistency(roots, action);
  });
  const policy = updateCanvasExecutionPolicy(workspace, { parallelEnabled: true });
  await queued.promise;
  const paths = [
    workspace.manifestFile,
    workspace.stateFile,
    join(workspace.resultsDir, "T-001", "index.json")
  ];
  let bytes: string[];
  try {
    await retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
    bytes = await Promise.all(paths.map((path) => fs.readFile(path, "utf8")));
  } finally {
    release.resolve();
  }
  const result = await policy;
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toContain("manifest_version_conflict");
  expect(await Promise.all(paths.map((path) => fs.readFile(path, "utf8")))).toEqual(bytes);
  expect((await assertRetry(workspace)).execution.parallel.enabled).toBe(false);
});

it("preserves a successful policy edit when retry waits behind its package lock", async () => {
  const { init } = await exhausted();
  const workspace = init.workspace;
  const edited = deferred(),
    release = deferred();
  const writer = withPackageFileConsistency(
    [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
    async () => {
      const result = await updateCanvasExecutionPolicy(workspace, { parallelEnabled: true });
      edited.resolve();
      await release.promise;
      return result;
    }
  );
  await Promise.race([edited.promise, writer]);
  const requested = await watchRequest(workspace.packageDir);
  const retry = retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  try {
    await requested.promise;
  } finally {
    release.resolve();
  }
  expect((await writer).ok).toBe(true);
  await retry;
  expect((await assertRetry(workspace)).execution.parallel.enabled).toBe(true);
});

it("holds the manifest lock throughout same-ID project rename before retry succeeds", async () => {
  const fixture = await createTestWorkspace();
  const name = "Concurrent same ID";
  const project = await initManagedProject(name);
  const { workspace } = await loadPackage(project.workspaceRoot);
  const manifest = basicManifest({ reviewMaxFeedbackCycles: 0 });
  await json.writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  await claimNext({ projectRoot: workspace });
  await submitBlockResult({
    projectRoot: workspace,
    ref: "T-001#B-001",
    reportPath: await writeReport(fixture.root, "rename-implementation.md")
  });
  await claimNext({ projectRoot: workspace });
  await submitReviewResult({
    projectRoot: workspace,
    ref: "T-001#R-001",
    resultPath: await writeReviewResult(fixture.root, "needs_changes", "Exhausted.")
  });
  const read = deferred(),
    release = deferred();
  const lockPath = join(
    userInfo().homedir,
    ".cache",
    "planweave",
    "package-locks",
    createHash("sha256")
      .update(await fs.realpath(workspace.packageDir))
      .digest("hex")
  );
  const originalRead = json.readJsonFile;
  let paused = false;
  let titleWriteStarted = false;
  const originalWrite = json.writeJsonFile;
  vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value) => {
    await originalWrite(path, value);
    if (path === join(project.workspaceRoot, "project-graph.json")) titleWriteStarted = true;
  });
  vi.spyOn(json, "readJsonFile").mockImplementation(async (path) => {
    const value = await originalRead(path);
    if (!paused && path === workspace.manifestFile && titleWriteStarted) {
      paused = true;
      await expect(fs.stat(lockPath)).resolves.toBeDefined();
      read.resolve();
      await release.promise;
    }
    return value;
  });
  const rename = renameProject(project.projectId, name);
  await Promise.race([
    read.promise,
    rename.then(() => {
      throw new Error("Rename finished without reaching the protected manifest read");
    })
  ]);
  const requested = await watchRequest(workspace.packageDir);
  const retry = retryReview({ projectRoot: workspace, ref: "T-001#R-001", maxFeedbackCycles: 3 });
  try {
    await requested.promise;
  } finally {
    release.resolve();
  }
  expect((await rename).projectId).toBe(project.projectId);
  await retry;
  expect((await assertRetry(workspace)).project.title).toBe(name);
});
