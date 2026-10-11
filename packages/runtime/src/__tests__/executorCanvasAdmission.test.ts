import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initManagedWorkspace } from "../initWorkspace.js";
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
  return { ...actual, rename: vi.fn(actual.rename) };
});
let actualFs: typeof import("node:fs/promises");
const directories: string[] = [];
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((source, target) => actualFs.rename(source, target));
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
