import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { initWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import {
  createExecutionGraphSession,
  enqueueGraphEditOperations,
  enqueuePackageFileChanges
} from "../graph/session.js";
import * as fileChanges from "../package/fileChanges.js";
import * as packageLoader from "../package/loadPackage.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { packageExecutionSnapshot } from "../package/packageExecutionSnapshot.js";
import { writeNewCanvasStorageIdentity } from "../package/packageStorageIdentity.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { readProjectMetadataFile } from "../projectMetadata.js";
import { getExecutionStatus } from "../taskManager/executionStatus.js";
import { loadRuntime, loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import { readState, writeState } from "../state.js";
import type { PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { basicManifest, writePromptFiles } from "./promptTestHelpers.js";

const ownedRoots: string[] = [];
const previousHome = process.env.PLANWEAVE_HOME;
const previousSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

async function fixture(manifest = basicManifest({ includeSecondTask: true })) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-context-snapshot-"));
  ownedRoots.push(directory);
  const home = join(directory, "home");
  const root = join(directory, "source");
  await mkdir(root);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");
  const { workspace } = await initWorkspace({ projectRoot: root });
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  await writeProjectGraph(workspace, {
    version: "plan-project/v1",
    canvases: [canonicalProjectCanvasNode({ id: "default", title: manifest.project.title })],
    edges: [],
    crossTaskEdges: []
  });
  return { home, root, workspace };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = previousHome;
  if (previousSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = previousSettings;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("runtime context barrier timed out")), 10000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function publish(workspace: ProjectWorkspace, nextManifest: PlanPackageManifest) {
  const { manifest } = await packageLoader.loadPackage(workspace);
  const result = await commitPlanPackageGraphMutation({
    projectRoot: workspace,
    mutation: {
      baseManifest: manifest,
      nextManifest,
      affectedTasks: ["T-001", "T-002", "T-003"],
      sideEffects: nextManifest.nodes.flatMap((task) =>
        task.type !== "task"
          ? []
          : [
              {
                kind: "writePrompt" as const,
                packagePath: task.prompt,
                markdown: `# ${task.id}\n`
              },
              ...task.blocks.map((block) => ({
                kind: "writePrompt" as const,
                packagePath: block.prompt,
                markdown: `# ${block.id}\n`
              }))
            ]
      )
    }
  });
  expect(result.ok).toBe(true);
}

describe("runtime context package generation", () => {
  it.each([
    "root",
    "workspace"
  ] as const)("keeps the captured generation when real edits interleave a %s status read", async (reference) => {
    const manifest = basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] });
    const { root, workspace } = await fixture(manifest);
    const entered = deferred();
    const release = deferred();
    const actualSnapshot = fileChanges.createPackageFileSnapshotFromLoadedPackage;
    let armed = true;
    vi.spyOn(fileChanges, "createPackageFileSnapshotFromLoadedPackage").mockImplementation(
      async (input) => {
        const snapshot = await actualSnapshot(input);
        if (armed) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return snapshot;
      }
    );
    const reading = getExecutionStatus({ projectRoot: reference === "root" ? root : workspace });
    // Observe rejection immediately while the writer runs, then propagate it below.
    const outcome = reading.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    try {
      await bounded(entered.promise);
      const next = basicManifest({ includeSecondTask: true });
      next.nodes = next.nodes.filter((node) => node.id !== "T-001");
      const task = next.nodes[0];
      if (task.type !== "task") throw new Error("missing task fixture");
      task.executor = "manual";
      task.blocks = [
        {
          id: "B-002",
          type: "implementation",
          title: "Replacement block",
          prompt: "nodes/T-002/blocks/B-002.prompt.md",
          depends_on: []
        }
      ];
      next.nodes.push({
        ...structuredClone(task),
        id: "T-003",
        title: "Added task",
        prompt: "nodes/T-003/prompt.md",
        blocks: [{ ...task.blocks[0], prompt: "nodes/T-003/blocks/B-002.prompt.md" }]
      });
      next.edges = [{ from: "T-003", to: "T-002", type: "depends_on" }];
      await publish(workspace, next);
    } finally {
      release.resolve();
      await bounded(outcome);
    }
    const result = await bounded(outcome);
    if ("error" in result) throw result.error;
    const status = result.value;
    expect(status.tasks.map((task) => task.taskId)).toEqual(["T-001", "T-002"]);
    expect(status.blocks.map((block) => block.ref)).toEqual([
      "T-001#B-001",
      "T-001#R-001",
      "T-002#B-001",
      "T-002#R-001"
    ]);
    expect(status).toMatchObject({
      taskTotal: 2,
      blockTotal: 4,
      counts: { tasks: { planned: 1, ready: 1 }, blocks: { planned: 3, ready: 1 } }
    });
    expect(status.nextClaimable).toEqual(["T-002#B-001"]);
    expect(status.blocks.map((block) => block.effectiveExecutor)).toEqual([
      "default",
      "default",
      "default",
      "default"
    ]);
    const current = await getExecutionStatus({ projectRoot: workspace });
    expect(current.tasks.map((task) => task.taskId)).toEqual(["T-002", "T-003"]);
    expect(current.blocks.map((block) => block.ref)).toEqual(["T-002#B-002", "T-003#B-002"]);
    expect(current.nextClaimable).toEqual(["T-002#B-002"]);
    expect(current.blocks.map((block) => block.effectiveExecutor)).toEqual(["manual", "manual"]);
  });

  it("loads the package once for an ordinary runtime context read", async () => {
    const { root } = await fixture();
    const loads = vi.spyOn(packageLoader, "loadPackage");
    const context = await loadRuntimeReadonly({ projectRoot: root });
    expect(context.graph.taskNodesInManifestOrder).toEqual(["T-001", "T-002"]);
    expect(Object.keys(context.state.tasks)).toEqual(["T-001", "T-002"]);
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit empty, manifest and graph-operation queues paired", async () => {
    const { root, workspace } = await fixture();
    const session = await createExecutionGraphSession(root);
    expect((await getExecutionStatus({ projectRoot: root, session })).taskTotal).toBe(2);
    const result = await executePlanGraphCommand({
      projectRoot: workspace,
      recordOperation: false,
      command: { type: "addTaskDependency", fromTaskId: "T-002", toTaskId: "T-001" }
    });
    expect(result.ok).toBe(true);
    enqueuePackageFileChanges(session, [{ path: "manifest.json", type: "changed" }]);
    const changed = await getExecutionStatus({ projectRoot: workspace, session });
    expect(changed.nextClaimable).toEqual(["T-001#B-001"]);
    expect(session.fileSnapshot.graph).toBe(session.graph);
    enqueueGraphEditOperations(session, [
      { type: "remove_node", nodeId: "T-001" },
      { type: "update_prompt", ref: "T-002#B-001" }
    ]);
    const edited = await getExecutionStatus({ projectRoot: workspace, session });
    expect(edited.tasks.map((task) => task.taskId)).toEqual(["T-002"]);
    expect(edited).toMatchObject({ taskTotal: 1, blockTotal: 2 });
    expect(edited.nextClaimable).toEqual(["T-002#B-001"]);
    expect(session.fileSnapshot.manifest.nodes.map((node) => node.id)).toEqual(["T-002"]);
    expect(session.fileSnapshot.graph).toBe(session.graph);
    expect(session.dirtyPromptRefs.has("T-002#B-001")).toBe(true);
  });

  it("pairs prompt-triggered full snapshots even when a manifest notification has not arrived", async () => {
    const { workspace } = await fixture();
    const session = await createExecutionGraphSession(workspace);
    const result = await executePlanGraphCommand({
      projectRoot: workspace,
      recordOperation: false,
      command: { type: "removeTask", taskId: "T-001" }
    });
    expect(result.ok).toBe(true);
    const prompt = "nodes/T-002/blocks/B-001.prompt.md";
    await writeFile(join(workspace.packageDir, prompt), "# Changed prompt\n");
    enqueuePackageFileChanges(session, [{ path: prompt, type: "changed" }]);
    const status = await getExecutionStatus({ projectRoot: workspace, session });
    expect(status.tasks.map((task) => task.taskId)).toEqual(["T-002"]);
    expect(status).toMatchObject({ taskTotal: 1, blockTotal: 2 });
    expect(status.nextClaimable).toEqual(["T-002#B-001"]);
    expect(session.fileSnapshot.graph).toBe(session.graph);
    expect(session.dirtyPromptRefs.has("T-002#B-001")).toBe(true);
  });

  it("rejects another project root and canvas without consuming the saved session queue", async () => {
    const first = await fixture();
    const session = await createExecutionGraphSession(first.workspace);
    const second = await fixture();
    enqueueGraphEditOperations(session, [{ type: "remove_node", nodeId: "T-001" }]);
    await expect(getExecutionStatus({ projectRoot: second.root, session })).rejects.toThrow(
      "session workspace"
    );
    await expect(getExecutionStatus({ projectRoot: second.workspace, session })).rejects.toThrow(
      "session workspace"
    );
    expect(session.readQueue.graphOps).toHaveLength(1);
    process.env.PLANWEAVE_HOME = first.home;
    const canvas = await createTaskCanvas(first.root, { name: "Other canvas" });
    const otherCanvas = await resolveTaskCanvasWorkspace(first.root, canvas.canvasId);
    await expect(getExecutionStatus({ projectRoot: otherCanvas, session })).rejects.toThrow(
      "session workspace"
    );
    await selectTaskCanvas(first.root, canvas.canvasId);
    await expect(getExecutionStatus({ projectRoot: first.root, session })).rejects.toThrow(
      "session workspace"
    );
    expect(
      (await getExecutionStatus({ projectRoot: first.workspace, session })).tasks.map(
        (task) => task.taskId
      )
    ).toEqual(["T-002"]);
  });

  it.each([
    "root",
    "workspace"
  ] as const)("rejects a retired canvas instance through %s", async (reference) => {
    const { root, workspace } = await fixture();
    const session = await createExecutionGraphSession(reference === "root" ? root : workspace);
    await writeNewCanvasStorageIdentity(workspace);
    await expect(
      getExecutionStatus({ projectRoot: reference === "root" ? root : workspace, session })
    ).rejects.toThrow(/identity changed|session workspace/);
  });

  it("refreshes prompt notifications against the session canvas after active canvas selection changes", async () => {
    const { root, workspace } = await fixture();
    const session = await createExecutionGraphSession(root);
    const other = await createTaskCanvas(root, { name: "Other canvas" });
    await selectTaskCanvas(root, other.canvasId);
    const prompt = "nodes/T-002/blocks/B-001.prompt.md";
    await writeFile(join(workspace.packageDir, prompt), "# Edited original canvas\n");
    enqueuePackageFileChanges(session, [{ path: prompt, type: "changed" }]);
    const status = await getExecutionStatus({ projectRoot: workspace, session });
    expect(status.tasks.map((task) => task.taskId)).toEqual(["T-001", "T-002"]);
    expect(status.blockTotal).toBe(4);
    expect(status.nextClaimable).toEqual(["T-001#B-001", "T-002#B-001"]);
    expect(session.fileSnapshot.graph).toBe(session.graph);
    expect(session.dirtyPromptRefs.has("T-002#B-001")).toBe(true);
  });

  it("rejects a retired project identity even with the saved workspace object", async () => {
    const { workspace } = await fixture();
    const session = await createExecutionGraphSession(workspace);
    const project = await readProjectMetadataFile(workspace.projectFile);
    await writeJsonFile(workspace.projectFile, {
      ...project,
      createdAt: "2000-01-01T00:00:00.000Z"
    });
    await expect(getExecutionStatus({ projectRoot: workspace, session })).rejects.toThrow(
      "identity changed"
    );
  });

  it("preserves execution snapshot compatibility checks for canonical structure and state", async () => {
    const { workspace } = await fixture();
    const captured = await capturePackageSnapshot({ projectRoot: workspace });
    const executionSnapshot = packageExecutionSnapshot(workspace, captured.snapshot);
    const session = await createExecutionGraphSession(workspace);
    enqueueGraphEditOperations(session, [{ type: "remove_node", nodeId: "T-001" }]);
    const options = { projectRoot: workspace, executionSnapshot, session };
    expect((await getExecutionStatus(options)).taskTotal).toBe(2);
    expect(session.readQueue.graphOps).toHaveLength(1);
    const state = await readState(workspace.stateFile);
    state.currentRefs = ["T-999#B-001"];
    await writeState(workspace.stateFile, state);
    await expect(getExecutionStatus(options)).rejects.toMatchObject({
      code: "package_execution_state_conflict"
    });
    state.currentRefs = [];
    await writeState(workspace.stateFile, state);
    const result = await executePlanGraphCommand({
      projectRoot: workspace,
      recordOperation: false,
      command: { type: "removeTask", taskId: "T-001" }
    });
    expect(result.ok).toBe(true);
    await expect(getExecutionStatus(options)).rejects.toMatchObject({
      code: "package_execution_state_conflict"
    });
  });

  it.each([
    "ordinary",
    "session",
    "executionSnapshot"
  ] as const)("keeps %s readonly state untouched and only persists changed derived state when mutating", async (mode) => {
    const { workspace } = await fixture();
    const options = {
      projectRoot: workspace,
      ...(mode === "session" ? { session: await createExecutionGraphSession(workspace) } : {}),
      ...(mode === "executionSnapshot"
        ? {
            executionSnapshot: packageExecutionSnapshot(
              workspace,
              (await capturePackageSnapshot({ projectRoot: workspace })).snapshot
            )
          }
        : {})
    };
    const before = await readFile(workspace.stateFile, "utf8");
    const metadata = await stat(workspace.stateFile);
    const readonly = await loadRuntimeReadonly(options);
    expect(Object.keys(readonly.state.tasks)).toEqual(["T-001", "T-002"]);
    await getExecutionStatus(options);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(before);
    const afterRead = await stat(workspace.stateFile);
    expect([afterRead.ino, afterRead.size, afterRead.mtimeMs, afterRead.ctimeMs]).toEqual([
      metadata.ino,
      metadata.size,
      metadata.mtimeMs,
      metadata.ctimeMs
    ]);
    const loaded = await loadRuntime(options);
    expect(Object.keys(loaded.state.tasks)).toEqual(["T-001", "T-002"]);
    const persisted = await readState(workspace.stateFile);
    expect(Object.keys(persisted.tasks)).toEqual(["T-001", "T-002"]);
    expect(Object.keys(persisted.blocks)).toEqual([
      "T-001#B-001",
      "T-001#R-001",
      "T-002#B-001",
      "T-002#R-001"
    ]);
    const written = await readFile(workspace.stateFile, "utf8");
    expect(written).not.toBe(before);
    const afterWrite = await stat(workspace.stateFile);
    await loadRuntime(options);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(written);
    const afterNoChange = await stat(workspace.stateFile);
    expect([afterNoChange.ino, afterNoChange.mtimeMs, afterNoChange.ctimeMs]).toEqual([
      afterWrite.ino,
      afterWrite.mtimeMs,
      afterWrite.ctimeMs
    ]);
  });
});
