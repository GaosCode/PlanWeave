import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as projectMutation from "../fs/withProjectMutationLock.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { linkProjectSourceRoot, renameProject } from "../desktop/projectApi.js";
import { runProfileFeedback } from "../autoRun/profileExecutor.js";
import { resolveProjectWorkspace } from "../project.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { readProjectMetadataFile } from "../projectMetadata.js";

const directories: string[] = [];
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

it.each([
  "path-package",
  "path-results",
  "managed-package",
  "managed-results"
] as const)("rejects a queued %s reset after a new project reuses its paths", async (mode) => {
  const { project, workspace } = await fixture();
  const held = barrier();
  const queued = barrier();
  const replace = barrier();
  let replacement = workspace;
  const lock = projectMutation.withProjectMutationLock;
  const holder = lock(workspace.workspaceRoot, async () => {
    held.release();
    await replace.promise;
    await renameProject(project.id, "Moved project");
    await delay(5);
    replacement = (await initManagedWorkspace({ name: "Captured project" })).workspace;
    await writeFile(join(replacement.packageDir, "marker"), "new package");
    await writeFile(join(replacement.resultsDir, "marker"), "new results");
  });
  await held.promise;
  vi.spyOn(projectMutation, "withProjectMutationLock").mockImplementation((root, fn, options) => {
    queued.release();
    return lock(root, fn, options);
  });
  const options = mode.endsWith("package") ? { resetPackage: true } : { resetResults: true };
  const reset = (
    mode.startsWith("path")
      ? initWorkspace({ projectRoot: workspace.rootPath, ...options })
      : initManagedWorkspace({ name: "Captured project", ...options })
  ).then(
    () => null,
    (error: unknown) => error
  );
  await queued.promise;
  replace.release();
  await holder;
  expect(String(await reset)).toContain("identity changed");
  expect((await readProjectMetadataFile(replacement.projectFile)).createdAt).toBe(
    replacement.projectCreatedAt
  );
  await expect(readFile(join(replacement.packageDir, "marker"), "utf8")).resolves.toBe(
    "new package"
  );
  await expect(readFile(join(replacement.resultsDir, "marker"), "utf8")).resolves.toBe(
    "new results"
  );
});

it.each([
  "Moved project",
  "Captured project"
])("rejects a queued rename to %s after package reset", async (name) => {
  const { project, workspace } = await fixture();
  const held = barrier();
  const queued = barrier();
  const resetAllowed = barrier();
  let replacement = workspace;
  const lock = projectMutation.withProjectMutationLock;
  const holder = lock(workspace.workspaceRoot, async () => {
    held.release();
    await resetAllowed.promise;
    await delay(5);
    replacement = (await initWorkspace({ projectRoot: workspace.rootPath, resetPackage: true }))
      .workspace;
  });
  await held.promise;
  vi.spyOn(projectMutation, "withProjectMutationLock").mockImplementation((root, fn, options) => {
    queued.release();
    return lock(root, fn, options);
  });
  const rename = renameProject(project.id, name).then(
    () => null,
    (error: unknown) => error
  );
  await queued.promise;
  resetAllowed.release();
  await holder;
  expect(String(await rename)).toContain("identity changed");
  expect((await readProjectMetadataFile(replacement.projectFile)).createdAt).toBe(
    replacement.projectCreatedAt
  );
  expect(replacement.projectCreatedAt).not.toBe(project.createdAt);
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "planweave-workspace-identity-"));
  directories.push(home);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "settings.json");
  return {
    home,
    ...(await initManagedWorkspace({ name: "Captured project", projectGraph: true }))
  };
}
const claim = {
  kind: "feedback",
  feedbackId: "FE-OLD-PROJECT",
  sourceReviewBlockRef: "T-OLD#R-001",
  taskId: "T-OLD",
  content: "Feedback belonging to the captured project instance.",
  effectiveExecutor: "manual"
} as const;
function feedback(workspace: Awaited<ReturnType<typeof resolveProjectWorkspace>>) {
  return runProfileFeedback({
    projectRoot: workspace,
    workspace,
    claim,
    executorName: "manual",
    profile: { adapter: "manual" }
  });
}

it("rejects old feedback and commands after another project reuses its name and paths", async () => {
  const { project, workspace } = await fixture();
  await renameProject(project.id, "Moved project");
  const replacement = await initManagedWorkspace({ name: "Captured project", projectGraph: true });
  expect(replacement.workspace.id).toBe(workspace.id);
  expect(replacement.project.createdAt).not.toBe(project.createdAt);
  await expect(feedback(workspace)).rejects.toThrow("identity changed");
  await expect(
    executePlanGraphCommand({
      projectRoot: workspace,
      command: { type: "updateLayout", layoutScope: "desktop", layout: null }
    })
  ).rejects.toThrow("identity changed");
  await expect(
    access(join(replacement.workspace.resultsDir, "feedback-runs"))
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(feedback(replacement.workspace)).resolves.toMatchObject({ kind: "manual" });
});

it.each([
  "managed",
  "external"
] as const)("captures actual disk identity on repeated %s init and invalidates old contexts after package reset", async (kind) => {
  const { home } = await fixture();
  const root = await mkdtemp(join(tmpdir(), "planweave-identity-source-"));
  directories.push(root);
  const initialize = (resetPackage = false) =>
    kind === "managed"
      ? initManagedWorkspace({ name: "Repeated", resetPackage })
      : initWorkspace({ projectRoot: root, resetPackage });
  const original = await initialize();
  const repeated = await initialize();
  const disk = await readProjectMetadataFile(repeated.workspace.projectFile);
  expect(repeated.project.createdAt).toBe(disk.createdAt);
  expect(repeated.project.createdAt).toBe(original.project.createdAt);
  await expect(feedback(repeated.workspace)).resolves.toMatchObject({ kind: "manual" });
  const reset = await initialize(true);
  expect(reset.project.createdAt).not.toBe(original.project.createdAt);
  await expect(feedback(original.workspace)).rejects.toThrow("identity changed");
  await expect(feedback(reset.workspace)).resolves.toMatchObject({ kind: "manual" });
  expect(reset.workspace.projectFile).toContain(home);
});

it("accepts linked managed projects, canonical symlink aliases and the same project moved back", async () => {
  const { home, project, workspace } = await fixture();
  const source = await mkdtemp(join(tmpdir(), "planweave-linked-identity-"));
  directories.push(source);
  await linkProjectSourceRoot(project.id, source);
  await expect(feedback(await resolveProjectWorkspace(workspace.rootPath))).resolves.toMatchObject({
    kind: "manual"
  });
  const alias = join(home, "alias");
  await symlink(workspace.rootPath, alias);
  await expect(feedback(await resolveProjectWorkspace(alias))).resolves.toMatchObject({
    kind: "manual"
  });
  const moved = await renameProject(project.id, "Roundtrip");
  await renameProject(moved.projectId, "Captured project");
  await expect(feedback(workspace)).resolves.toMatchObject({ kind: "manual" });
});
