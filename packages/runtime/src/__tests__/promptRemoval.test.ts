import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bulkRemoveGraphItems, removeTaskNode } from "../desktop/index.js";
import { commitPlanPackageGraphMutation, removeNode } from "../graph/editGraph.js";
import { buildPlanPackageGraphMutation } from "../graph/mutation.js";
import * as json from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
});

describe("prompt removal", () => {
  it("preserves surviving prompts and auxiliary files in a deleted task's parent directory", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    for (const node of manifest.nodes) {
      if (node.type === "task") node.prompt = `nodes/${node.id}.md`;
    }
    const { root, init } = await createTestWorkspace(manifest);
    const survivorPath = join(init.workspace.packageDir, "nodes/T-002.md");
    const auxiliaryPath = join(init.workspace.packageDir, "nodes/notes.txt");
    const survivor = await readFile(survivorPath);
    await writeFile(auxiliaryPath, "user notes\n");

    await expect(removeTaskNode(root, "T-001")).resolves.toMatchObject({ ok: true });

    await expect(readFile(survivorPath)).resolves.toEqual(survivor);
    await expect(readFile(auxiliaryPath, "utf8")).resolves.toBe("user notes\n");
    await expect(readFile(join(init.workspace.packageDir, "nodes/T-001.md"))).rejects.toMatchObject(
      {
        code: "ENOENT"
      }
    );
  });

  it("deletes task, implementation and review prompts at custom root paths without deleting the package", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    task.prompt = "task.md";
    for (const block of task.blocks) block.prompt = `${block.id}.md`;
    const { root, init } = await createTestWorkspace(manifest);
    const helper = join(init.workspace.packageDir, "helper.txt");
    await writeFile(helper, "keep\n");

    await expect(removeTaskNode(root, task.id)).resolves.toMatchObject({ ok: true });

    for (const path of [task.prompt, ...task.blocks.map((block) => block.prompt)]) {
      await expect(readFile(join(init.workspace.packageDir, path))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    await expect(readFile(helper, "utf8")).resolves.toBe("keep\n");
    await expect(json.readJsonFile(init.workspace.manifestFile)).resolves.toMatchObject({
      nodes: [expect.objectContaining({ id: "T-002" })]
    });
  });

  it.each([
    "task",
    "implementation",
    "review",
    "normalized",
    "symlink"
  ])("preserves a prompt still referenced by a surviving %s", async (reference) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const removed = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (removed?.type !== "task" || survivor?.type !== "task") {
      throw new Error("Fixture tasks missing.");
    }
    removed.prompt = "shared.md";
    if (reference === "task") survivor.prompt = removed.prompt;
    if (reference === "normalized") survivor.prompt = "nodes/../shared.md";
    if (reference === "symlink") survivor.prompt = "nodes/alias.md";
    if (reference === "implementation" || reference === "review") {
      const block = survivor.blocks.find((item) => item.type === reference);
      if (!block) throw new Error("Fixture block missing.");
      block.prompt = removed.prompt;
    }
    const { root, init } = await createTestWorkspace(manifest);
    const sharedPath = join(init.workspace.packageDir, removed.prompt);
    if (reference === "symlink") {
      const alias = join(init.workspace.packageDir, survivor.prompt);
      await rm(alias);
      await symlink("../shared.md", alias);
    }
    const content = await readFile(sharedPath);

    await expect(removeTaskNode(root, removed.id)).resolves.toMatchObject({ ok: true });

    await expect(readFile(sharedPath)).resolves.toEqual(content);
    if (reference === "symlink") {
      await expect(readFile(join(init.workspace.packageDir, survivor.prompt))).resolves.toEqual(
        content
      );
    }
  });

  it("removes a shared file once its last references are removed in the same batch", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    for (const node of manifest.nodes) {
      if (node.type === "task") {
        node.prompt = "shared.md";
        for (const block of node.blocks) block.prompt = "shared.md";
      }
    }
    const { root, init } = await createTestWorkspace(manifest);
    await expect(
      bulkRemoveGraphItems(root, { taskIds: ["T-001", "T-002"] })
    ).resolves.toMatchObject({
      ok: true
    });
    await expect(readFile(join(init.workspace.packageDir, "shared.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(json.readJsonFile(init.workspace.manifestFile)).resolves.toMatchObject({
      nodes: []
    });
  });

  it("retains all task prompts when removal is explicitly disabled", async () => {
    const manifest = basicManifest();
    const { root, init } = await createTestWorkspace(manifest);
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const paths = [task.prompt, ...task.blocks.map((block) => block.prompt)];
    const before = await Promise.all(
      paths.map((path) => readFile(join(init.workspace.packageDir, path)))
    );

    await expect(
      removeNode({ projectRoot: root, nodeId: task.id, removePrompt: false })
    ).resolves.toMatchObject({
      ok: true
    });

    expect(
      await Promise.all(paths.map((path) => readFile(join(init.workspace.packageDir, path))))
    ).toEqual(before);
  });

  it("restores removed prompt bytes and symlinks when manifest publication fails", async () => {
    const manifest = basicManifest();
    const { root, init } = await createTestWorkspace(manifest);
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const taskPath = join(init.workspace.packageDir, task.prompt);
    const sharedPath = join(init.workspace.packageDir, "shared.md");
    await writeFile(sharedPath, "linked task\n");
    await rm(taskPath);
    await symlink("../../shared.md", taskPath);
    const paths = [task.prompt, ...task.blocks.map((block) => block.prompt)];
    const before = await Promise.all(
      paths.map((path) => readFile(join(init.workspace.packageDir, path)))
    );
    const manifestBefore = await readFile(init.workspace.manifestFile);
    const publication = vi
      .spyOn(json, "writeJsonFile")
      .mockRejectedValueOnce(new Error("publication failed"));

    await expect(
      commitPlanPackageGraphMutation({
        projectRoot: root,
        mutation: buildPlanPackageGraphMutation(manifest, {
          kind: "removeNode",
          nodeId: task.id,
          removePrompt: true
        })
      })
    ).rejects.toThrow("publication failed");

    expect(publication).toHaveBeenCalledOnce();
    expect(
      await Promise.all(paths.map((path) => readFile(join(init.workspace.packageDir, path))))
    ).toEqual(before);
    await expect(readlink(taskPath)).resolves.toBe("../../shared.md");
    await expect(readFile(init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
  });

  it("keeps surviving cross-task references when a mixed batch removes task and review prompts", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task")
      throw new Error("Fixture tasks missing.");
    const implementation = survivor.blocks[0];
    const review = survivor.blocks[1];
    if (!implementation || !review) throw new Error("Fixture blocks missing.");
    task.prompt = "shared.md";
    implementation.prompt = "shared.md";
    review.prompt = "removed-review.md";
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(join(init.workspace.packageDir, "shared.md"), "shared survivor bytes\n");
    await expect(
      bulkRemoveGraphItems(root, { taskIds: [task.id], blockRefs: ["T-002#R-001"] })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, "shared.md"), "utf8")).resolves.toBe(
      "shared survivor bytes\n"
    );
    await expect(
      readFile(join(init.workspace.packageDir, "removed-review.md"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows raw removal of already-missing prompts but rejects a missing desktop snapshot without writes", async () => {
    const { root, init } = await createTestWorkspace();
    const missing = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    await rm(missing);
    const before = await readFile(init.workspace.manifestFile);
    await expect(removeTaskNode(root, "T-001")).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "prompt_missing" })]
    });
    await expect(readFile(init.workspace.manifestFile)).resolves.toEqual(before);
    await expect(
      removeNode({ projectRoot: root, nodeId: "T-001", removePrompt: true })
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    "escape",
    "symlink"
  ])("rejects %s prompt targets without changing outside bytes or manifest", async (kind) => {
    const manifest = basicManifest();
    const { root, init } = await createTestWorkspace(manifest);
    const outside = await mkdtemp(join(tmpdir(), "planweave-outside-prompt-"));
    const outsidePath = join(outside, "prompt.md");
    await writeFile(outsidePath, "outside authority\n");
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    if (kind === "escape") task.prompt = "../outside.md";
    else {
      const target = join(init.workspace.packageDir, task.prompt);
      await rm(target);
      await symlink(outsidePath, target);
    }
    await json.writeJsonFile(init.workspace.manifestFile, manifest);
    const before = await readFile(init.workspace.manifestFile);
    await expect(
      commitPlanPackageGraphMutation({
        projectRoot: root,
        mutation: buildPlanPackageGraphMutation(manifest, {
          kind: "removeNode",
          nodeId: task.id,
          removePrompt: true
        })
      })
    ).rejects.toMatchObject({ code: "package_path_outside" });
    await expect(readFile(init.workspace.manifestFile)).resolves.toEqual(before);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside authority\n");
  });

  it("rejects a stale deletion before applying any prompt side effect", async () => {
    const manifest = basicManifest();
    const { root, init } = await createTestWorkspace(manifest);
    const prompt = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    const before = await readFile(prompt);
    const mutation = buildPlanPackageGraphMutation(structuredClone(manifest), {
      kind: "removeNode",
      nodeId: "T-001",
      removePrompt: true
    });
    manifest.project.title = "Concurrent manifest";
    await json.writeJsonFile(init.workspace.manifestFile, manifest);
    const manifestBefore = await readFile(init.workspace.manifestFile);
    await expect(
      commitPlanPackageGraphMutation({ projectRoot: root, mutation })
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "manifest_version_conflict" })]
    });
    await expect(readFile(prompt)).resolves.toEqual(before);
    await expect(readFile(init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
  });
});
