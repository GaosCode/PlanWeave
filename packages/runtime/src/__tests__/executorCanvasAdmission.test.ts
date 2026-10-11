import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
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
  expect(result.error).toBeInstanceOf(Error);
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
    expect(outcome).toBeInstanceOf(Error);
  } finally {
    await lease?.release();
  }
});

it("admits a valid registered canvas whose empty results directory is absent", async () => {
  const { workspace } = await fixture();
  await rm(workspace.resultsDir, { recursive: true });
  const lease = await acquireExecutorResultsWriteLease(workspace, "empty-results");
  try {
    await mkdir(workspace.resultsDir);
  } finally {
    await lease.release();
  }
});
