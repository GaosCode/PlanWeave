import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimNext, submitBlockResult, getExecutionStatus } from "../taskManager/index.js";
import { resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { readState, createEmptyState } from "../state.js";
import { projectGraphPath } from "../projectGraph/loadProjectGraph.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

export async function customDefaultCanvasMigrationFixture(absolute = false, residue = false) {
  const { home, root, init } = await createTestWorkspace(
    basicManifest({ includeSecondTask: true })
  );
  await claimNext({ projectRoot: root });
  const report = "Registered legacy implementation history.\n";
  const reportPath = join(home, "implementation.md");
  await writeFile(reportPath, report);
  await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });
  await claimNext({ projectRoot: root });
  const expected = await getExecutionStatus({ projectRoot: root });
  const state = await readState(init.workspace.stateFile);
  const sourcePaths = {
    packageDir: join(init.workspace.workspaceRoot, "package"),
    stateFile: join(init.workspace.workspaceRoot, "legacy-state", "runtime.json"),
    resultsDir: join(init.workspace.workspaceRoot, "legacy-results")
  };
  await mkdir(join(init.workspace.workspaceRoot, "legacy-state"));
  await rename(init.workspace.packageDir, sourcePaths.packageDir);
  await rename(init.workspace.stateFile, sourcePaths.stateFile);
  await rename(init.workspace.resultsDir, sourcePaths.resultsDir);
  const registry = {
    version: "desktop-canvases/v1",
    canvases: [
      {
        canvasId: "default",
        name: "Registered default",
        packageDir: absolute ? sourcePaths.packageDir : "package",
        stateFile: absolute ? sourcePaths.stateFile : "legacy-state/runtime.json",
        resultsDir: absolute ? sourcePaths.resultsDir : "legacy-results"
      }
    ]
  };
  const registryFile = join(init.workspace.workspaceRoot, "desktop", "canvases.json");
  await writeJsonFile(registryFile, registry);
  await rm(projectGraphPath(init.workspace));
  if (residue) {
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"));
    await writeFile(join(init.workspace.workspaceRoot, "results", "unrelated.txt"), "Root residue");
  }
  const workspace = await resolveTaskCanvasWorkspace(root, "default");
  const reportRelativePath = join("T-001", "blocks", "B-001", "runs", "RUN-001", "report.md");
  return {
    home,
    root,
    init,
    sourcePaths,
    workspace,
    expected,
    state,
    report,
    reportRelativePath,
    registry,
    registryFile,
    sourceStateBytes: await readFile(sourcePaths.stateFile, "utf8")
  };
}
