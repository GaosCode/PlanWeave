import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { linkProjectSourceRoot, renameProject } from "../desktop/projectApi.js";
import { runProfileFeedback } from "../autoRun/profileExecutor.js";
import { resolveProjectWorkspace } from "../project.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { readProjectMetadataFile } from "../projectMetadata.js";

const directories: string[] = [];
afterEach(async () => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
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
