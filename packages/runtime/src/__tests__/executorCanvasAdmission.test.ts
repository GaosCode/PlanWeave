import { createEmptyState } from "../state.js";
import {
  executePlanGraphCommand,
  undoPlanGraphCommand,
  redoPlanGraphCommand
} from "../plangraph/executeCommand.js";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import {
  createTaskCanvas,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace
} from "../desktop/canvasApi.js";
import { runProfileFeedback } from "../autoRun/profileExecutor.js";
import * as projectGraph from "../projectGraph/index.js";
import * as consistency from "../package/packageFileConsistency.js";
import * as mutation from "../fs/withProjectMutationLock.js";
import { acquireExecutorResultsWriteLease } from "../package/executorResultsWriteLease.js";
import * as leases from "../package/executorResultsWriteLease.js";
import * as taskManager from "../taskManager/index.js";
import { runAutoRunStep } from "../taskManager/autoRunStep.js";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
let actualFs: typeof import("node:fs/promises");
const directories: string[] = [];
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((source, target) => actualFs.rename(source, target));
  vi.mocked(rm).mockImplementation((target, options) => actualFs.rm(target, options));
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "planweave-canvas-admission-"));
  directories.push(home);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "settings.json");
  const owner = await initManagedWorkspace({ name: "Admission", projectGraph: true });
  const canvas = await createTaskCanvas(owner.workspace.rootPath, { name: "Removable" });
  const workspace = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, canvas.canvasId);
  return { owner, canvas, workspace };
}

it.each([
  "after-claim",
  "after-lease"
] as const)("binds a real default-string execution to its canvas when selection changes %s", async (phase) => {
  const { owner, canvas, workspace: a } = await fixture();
  const b = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, "default");
  const ready = join(owner.workspace.workspaceRoot, "child-ready");
  const finish = join(owner.workspace.workspaceRoot, "child-finish");
  const profile = {
    adapter: "local-review" as const,
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs/promises'); (async()=>{await fs.writeFile(${JSON.stringify(ready)},'ready');for(let i=0;i<300;i++){try{await fs.readFile(${JSON.stringify(finish)});break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}console.log(JSON.stringify({reviewBlockRef:'T-001#R-001',taskId:'T-001',verdict:'passed',content:'actual child review'}));})().catch(e=>{console.error(e);process.exitCode=1;});`
    ],
    timeoutMs: 10000
  };
  const manifest = basicManifest();
  manifest.executors = { "local-review": profile };
  manifest.execution.defaultExecutor = "local-review";
  manifest.nodes[0]!.blocks = manifest.nodes[0]!.blocks.filter((block) => block.type === "review");
  manifest.nodes[0]!.blocks[0]!.depends_on = [];
  for (const workspace of [a, b]) {
    await writeJsonFile(workspace.manifestFile, manifest);
    await writePromptFiles(workspace.packageDir, manifest);
  }
  await trustCommand(a, profile.command, profile.args);
  await selectTaskCanvas(owner.workspace.rootPath, canvas.canvasId);
  const admitted = barrier(),
    proceed = barrier();
  if (phase === "after-claim") {
    const claim = taskManager.claimNext;
    vi.spyOn(taskManager, "claimNext").mockImplementation(async (options) => {
      const result = await claim(options);
      admitted.release();
      await proceed.promise;
      return result;
    });
  } else {
    const acquire = leases.acquireExecutorResultsWriteLease;
    vi.spyOn(leases, "acquireExecutorResultsWriteLease").mockImplementation(
      async (workspace, identity) => {
        const lease = await acquire(workspace, identity);
        admitted.release();
        await proceed.promise;
        return lease;
      }
    );
  }
  const execution = runAutoRunStep({
    projectRoot: owner.workspace.rootPath,
    executorName: "local-review",
    tmuxEnabled: false
  });
  const outcome = execution.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  try {
    await admitted.promise;
    await selectTaskCanvas(owner.workspace.rootPath, "default");
    proceed.release();
    for (let i = 0; i < 300; i++) {
      if (
        await actualFs.stat(ready).then(
          () => true,
          () => false
        )
      )
        break;
      await delay(10);
    }
    await expect(access(ready)).resolves.toBeUndefined();
    await expect(leases.assertNoExecutorResultsWriteLease(a.resultsDir)).rejects.toThrow("lease");
    await expect(removeTaskCanvas(owner.workspace.rootPath, canvas.canvasId)).rejects.toThrow(
      "lease"
    );
    await expect(
      access(join(a.resultsDir, "T-001/blocks/R-001/runs/RUN-001/metadata.json"))
    ).resolves.toBeUndefined();
    await expect(access(join(b.resultsDir, "T-001/blocks/R-001/runs"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await writeFile(finish, "finish");
    expect(await outcome).toMatchObject({ value: { kind: "submitted" }, error: null });
    const state: unknown = JSON.parse(await readFile(a.stateFile, "utf8"));
    expect(state).toMatchObject({ blocks: { "T-001#R-001": { status: "completed" } } });
    await leases.assertNoExecutorResultsWriteLease(a.resultsDir);
    await removeTaskCanvas(owner.workspace.rootPath, canvas.canvasId);
    await expect(access(a.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    proceed.release();
    await writeFile(finish, "finish");
    await outcome;
  }
});
it.each([
  "before-quarantine",
  "before-unregister"
] as const)("rejects real manual feedback queued behind canvas deletion at %s", async (phase) => {
  const { owner, canvas, workspace } = await fixture();
  const deleting = barrier(),
    allowDelete = barrier(),
    attempted = barrier();
  let watchAdmission = false;
  if (phase === "before-quarantine") {
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (
        String(source) === workspace.workspaceRoot &&
        String(target).includes("canvas-quarantine")
      ) {
        deleting.release();
        await allowDelete.promise;
      }
      return actualFs.rename(source, target);
    });
  } else {
    const write = projectGraph.writeProjectGraph;
    vi.spyOn(projectGraph, "writeProjectGraph").mockImplementation(async (project, manifest) => {
      if (!manifest.canvases.some((item) => item.id === canvas.canvasId)) {
        deleting.release();
        await allowDelete.promise;
      }
      return write(project, manifest);
    });
  }
  const projectLock = mutation.withProjectMutationLock;
  vi.spyOn(mutation, "withProjectMutationLock").mockImplementation((root, apply, options) => {
    if (watchAdmission) attempted.release();
    return projectLock(root, apply, options);
  });
  const storageLock = consistency.withPackageFileConsistency;
  vi.spyOn(consistency, "withPackageFileConsistency").mockImplementation((targets, apply) => {
    if (watchAdmission && targets.includes(workspace.resultsDir)) attempted.release();
    return storageLock(targets, apply);
  });
  const removal = removeTaskCanvas(owner.workspace.rootPath, canvas.canvasId);
  await deleting.promise;
  watchAdmission = true;
  const feedback = runProfileFeedback({
    projectRoot: workspace,
    workspace,
    executorName: "manual",
    profile: { adapter: "manual" },
    claim: {
      kind: "feedback",
      feedbackId: "FE-QUEUED-BEHIND-REMOVE",
      sourceReviewBlockRef: "T-OLD#R-001",
      taskId: "T-OLD",
      content: "Feedback for deleted canvas",
      effectiveExecutor: "manual"
    }
  }).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  try {
    await attempted.promise;
  } finally {
    allowDelete.release();
  }
  const remaining = await removal;
  const result = await feedback;
  expect(remaining.some((item) => item.canvasId === canvas.canvasId)).toBe(false);
  expect(String(result.error)).toContain("canvas storage identity changed");
  expect(result.value).toBeNull();
  await expect(access(workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a captured storage mapping after registration redirects the results tree", async () => {
  const { owner, canvas, workspace } = await fixture();
  const loaded = await projectGraph.loadProjectGraph(owner.workspace.rootPath);
  await projectGraph.writeProjectGraph(loaded.workspace, {
    ...loaded.manifest,
    canvases: loaded.manifest.canvases.map((item) =>
      item.id === canvas.canvasId
        ? { ...item, resultsDir: `canvases/${canvas.canvasId}/replacement-results` }
        : item
    )
  });
  let lease: Awaited<ReturnType<typeof acquireExecutorResultsWriteLease>> | undefined;
  try {
    const outcome = await acquireExecutorResultsWriteLease(workspace, "redirected-results").then(
      (value) => {
        lease = value;
        return null;
      },
      (error: unknown) => error
    );
    expect(String(outcome)).toContain("canvas storage identity changed");
  } finally {
    await lease?.release();
  }
});

it.each([
  "resultsDir",
  "stateFile"
] as const)("admits real manual feedback when optional %s is absent", async (target) => {
  const { workspace } = await fixture();
  await rm(workspace[target], { recursive: true });
  await expect(
    runProfileFeedback({
      projectRoot: workspace,
      workspace,
      executorName: "manual",
      profile: { adapter: "manual" },
      claim: {
        kind: "feedback",
        feedbackId: "FE-EMPTY-STORAGE",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Valid feedback",
        effectiveExecutor: "manual"
      }
    })
  ).resolves.toMatchObject({ kind: "manual" });
});

it.each([
  "reset",
  "recreate"
] as const)("rejects old manual feedback after canvas storage %s", async (mode) => {
  const { owner, canvas, workspace: extra } = await fixture();
  const canvasId = mode === "reset" ? "default" : canvas.canvasId;
  const captured =
    mode === "reset" ? await resolveTaskCanvasWorkspace(owner.workspace.rootPath, canvasId) : extra;
  await removeTaskCanvas(owner.workspace.rootPath, canvasId);
  if (mode === "recreate") {
    const replacement = await projectGraph.createProjectCanvas({
      projectRoot: owner.workspace.rootPath,
      requestedId: canvasId,
      title: "Replacement"
    });
    expect(replacement.canvas.id).toBe(canvasId);
  }
  const feedback = (workspace: typeof captured) =>
    runProfileFeedback({
      projectRoot: workspace,
      workspace,
      executorName: "manual",
      profile: { adapter: "manual" },
      claim: {
        kind: "feedback",
        feedbackId: "FE-REPLACED-STORAGE",
        sourceReviewBlockRef: "T-OLD#R-001",
        taskId: "T-OLD",
        content: "Old feedback",
        effectiveExecutor: "manual"
      }
    });
  await expect(feedback(captured)).rejects.toThrow("canvas storage identity changed");
  await expect(access(join(captured.resultsDir, "feedback-runs"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  const current = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, canvasId);
  await expect(feedback(current)).resolves.toMatchObject({ kind: "manual" });
});

it("does not bind an identity-free saved request to current storage during admission", async () => {
  const { workspace } = await fixture();
  await expect(
    runProfileFeedback({
      projectRoot: workspace,
      workspace: { ...workspace, packageStorageIdentity: null },
      executorName: "manual",
      profile: { adapter: "manual" },
      claim: {
        kind: "feedback",
        feedbackId: "FE-NO-IDENTITY",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Invalid captured identity",
        effectiveExecutor: "manual"
      }
    })
  ).rejects.toThrow("canvas storage identity changed");
  await expect(access(join(workspace.resultsDir, "feedback-runs"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

it("keeps an unchanged peer request and history valid when canvases share a parent directory", async () => {
  const { owner } = await fixture();
  const canvases = ["default", "peer"].map((id, i) => ({
    id,
    type: "canvas" as const,
    title: id,
    packageDir: `canvases/shared/package-${i}`,
    stateFile: `canvases/shared/state-${i}.json`,
    resultsDir: `canvases/shared/results-${i}`
  }));
  for (const canvas of canvases) {
    const packageDir = join(owner.workspace.workspaceRoot, canvas.packageDir);
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeJsonFile(join(owner.workspace.workspaceRoot, canvas.stateFile), createEmptyState());
    await actualFs.mkdir(join(owner.workspace.workspaceRoot, canvas.resultsDir), {
      recursive: true
    });
  }
  await projectGraph.writeProjectGraph(owner.workspace, {
    version: "plan-project/v1",
    canvases,
    edges: [],
    crossTaskEdges: []
  });
  const graph = await projectGraph.compileProjectGraph(
    await projectGraph.loadProjectGraph(owner.workspace.rootPath)
  );
  expect(graph.diagnostics.errors).toEqual([]);
  const peer = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, "peer");
  expect(
    await executePlanGraphCommand({
      projectRoot: peer,
      command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Peer history" } }
    })
  ).toMatchObject({ ok: true });
  const before = await readFile(peer.manifestFile, "utf8");
  await removeTaskCanvas(owner.workspace.rootPath, "default");
  expect(await readFile(peer.manifestFile, "utf8")).toBe(before);
  await expect(
    runProfileFeedback({
      projectRoot: peer,
      workspace: peer,
      executorName: "manual",
      profile: { adapter: "manual" },
      claim: {
        kind: "feedback",
        feedbackId: "FE-PEER",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Unchanged peer",
        effectiveExecutor: "manual"
      }
    })
  ).resolves.toMatchObject({ kind: "manual" });
  expect(await undoPlanGraphCommand({ projectRoot: peer })).toMatchObject({ ok: true });
  expect(await redoPlanGraphCommand({ projectRoot: peer })).toMatchObject({ ok: true });
  expect(await readFile(peer.manifestFile, "utf8")).toBe(before);
});

it("rejects old feedback queued behind a real results-only reset", async () => {
  const { owner } = await fixture();
  const captured = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, "default");
  await writeJsonFile(captured.manifestFile, basicManifest());
  expect(
    await executePlanGraphCommand({
      projectRoot: captured,
      command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Preserved edit" } }
    })
  ).toMatchObject({ ok: true });
  const canonicalResults = await actualFs.realpath(captured.resultsDir);
  const resetting = barrier(),
    proceed = barrier(),
    attempted = barrier();
  vi.mocked(rm).mockImplementation(async (target, options) => {
    if (target === captured.resultsDir || target === canonicalResults) {
      resetting.release();
      await proceed.promise;
    }
    return actualFs.rm(target, options);
  });
  const reset = initWorkspace({ projectRoot: owner.workspace.rootPath, resetResults: true });
  await Promise.race([
    resetting.promise,
    reset.then(() => {
      throw new Error("Reset completed without reaching the results barrier.");
    })
  ]);
  const lock = mutation.withProjectMutationLock;
  vi.spyOn(mutation, "withProjectMutationLock").mockImplementation((root, apply, options) => {
    attempted.release();
    return lock(root, apply, options);
  });
  const feedback = (workspace: typeof captured) =>
    runProfileFeedback({
      projectRoot: workspace,
      workspace,
      executorName: "manual",
      profile: { adapter: "manual" },
      claim: {
        kind: "feedback",
        feedbackId: "FE-OLD-RESULTS",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Pre-reset feedback",
        effectiveExecutor: "manual"
      }
    });
  const outcome = feedback(captured).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  try {
    await attempted.promise;
    proceed.release();
    await reset;
    const result = await outcome;
    expect(String(result.error)).toContain("results storage identity changed");
    expect(result.value).toBeNull();
    await expect(access(join(captured.resultsDir, "feedback-runs"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    const current = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, "default");
    await expect(feedback(current)).resolves.toMatchObject({ kind: "manual" });
    expect(await undoPlanGraphCommand({ projectRoot: current })).toMatchObject({ ok: true });
    expect(await redoPlanGraphCommand({ projectRoot: current })).toMatchObject({ ok: true });
    expect(await readFile(current.manifestFile, "utf8")).toContain("Preserved edit");
  } finally {
    proceed.release();
    await reset;
    await outcome;
  }
});

it.each([
  "initialization",
  "identity-write"
] as const)("safely retires results on a real reset failure at %s", async (failure) => {
  const { owner } = await fixture();
  const captured = await resolveTaskCanvasWorkspace(owner.workspace.rootPath, "default");
  const sentinel = join(captured.resultsDir, "preserved-result.txt");
  await writeFile(sentinel, "durable result");
  const config = join(captured.planweaveHome, "config");
  const savedConfig = `${config}-saved`;
  if (failure === "initialization") {
    await actualFs.rename(config, savedConfig);
    await writeFile(config, "configuration collision");
  } else {
    const marker = join(
      await actualFs.realpath(dirname(captured.resultsDir)),
      `${basename(captured.resultsDir)}.results-instance.json`
    );
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (target === marker)
        throw Object.assign(new Error("Results identity write failed"), { code: "EIO" });
      return actualFs.rename(source, target);
    });
  }
  try {
    await expect(
      initWorkspace({ projectRoot: owner.workspace.rootPath, resetResults: true })
    ).rejects.toThrow(failure === "initialization" ? "EEXIST" : "Results identity write failed");
    if (failure === "identity-write") {
      expect(await readFile(sentinel, "utf8")).toBe("durable result");
    } else {
      await expect(access(captured.resultsDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        runProfileFeedback({
          projectRoot: captured,
          workspace: captured,
          executorName: "manual",
          profile: { adapter: "manual" },
          claim: {
            kind: "feedback",
            feedbackId: "FE-FAILED-RESET",
            sourceReviewBlockRef: "T-001#R-001",
            taskId: "T-001",
            content: "Old feedback after failed reset",
            effectiveExecutor: "manual"
          }
        })
      ).rejects.toThrow("results storage identity changed");
      await expect(access(captured.resultsDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    if (failure === "initialization") {
      await actualFs.rename(config, `${config}-collision`);
      await actualFs.rename(savedConfig, config);
    }
  }
});
