import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as runtime from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeGateway } from "../toolRuntime.js";
import { handlePlanweaveTool } from "../tools.js";
import { readJson } from "./toolTestHelpers.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.PLANWEAVE_HOME;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-mcp-selection-home-")));
  const draftRoot = await mkdtemp(join(tmpdir(), "planweave-mcp-draft-"));
  roots.push(home, draftRoot);
  process.env.PLANWEAVE_HOME = home;
  const project = await runtimeGateway.initProject("Import selection");
  const selected = await runtimeGateway.createCanvas(project.projectId, "Selected target");
  await runtime.selectTaskCanvas(project.rootPath, selected.canvasId);
  const defaultWorkspace = await runtime.resolveTaskCanvasWorkspace(project.rootPath, "default");
  const selectedWorkspace = await runtime.resolveTaskCanvasWorkspace(
    project.rootPath,
    selected.canvasId
  );
  await writeFile(join(defaultWorkspace.resultsDir, "keep.txt"), "default result");
  await cp(
    fileURLToPath(new URL("../../../../examples/basic-plan-package/package", import.meta.url)),
    draftRoot,
    { recursive: true }
  );
  await writeFile(join(draftRoot, "imported.txt"), "imported through MCP");
  return { project, selected, defaultWorkspace, selectedWorkspace, draftRoot };
}

describe("MCP package import selection through the production gateway", () => {
  it.each([
    "omitted",
    "null",
    "explicit"
  ] as const)("applies %s target and returns the same persisted canvas", async (mode) => {
    const f = await fixture();
    const canvas = mode === "explicit" ? "default" : f.selected.canvasId;
    const args = {
      projectId: f.project.projectId,
      draftRoot: f.draftRoot,
      ...(mode === "omitted" ? {} : { canvasId: mode === "null" ? null : "default" })
    };
    const preview = readJson(
      await handlePlanweaveTool("preview_package_import", args, runtimeGateway)
    );
    expect(preview).toMatchObject({ preview: { ok: true, target: { canvasId: canvas } } });
    const result = readJson(
      await handlePlanweaveTool("import_package_draft", { ...args, apply: true }, runtimeGateway)
    );
    expect(result).toMatchObject({
      import: { ok: true, applied: true, target: { canvasId: canvas } }
    });
    const target = mode === "explicit" ? f.defaultWorkspace : f.selectedWorkspace;
    expect(await readFile(join(target.packageDir, "imported.txt"), "utf8")).toBe(
      "imported through MCP"
    );
    if (mode !== "explicit")
      expect(await readFile(join(f.defaultWorkspace.resultsDir, "keep.txt"), "utf8")).toBe(
        "default result"
      );
  });

  it("returns an error for an unknown target and preserves existing results", async () => {
    const f = await fixture();
    await expect(
      handlePlanweaveTool(
        "import_package_draft",
        {
          projectId: f.project.projectId,
          canvasId: "missing",
          draftRoot: f.draftRoot,
          apply: true
        },
        runtimeGateway
      )
    ).rejects.toThrow("Project has no task canvas");
    expect(await readFile(join(f.defaultWorkspace.resultsDir, "keep.txt"), "utf8")).toBe(
      "default result"
    );
  });

  it("returns a manifest field diagnostic for an invalid draft without replacing the target", async () => {
    const f = await fixture();
    const draftManifestFile = join(f.draftRoot, "manifest.json");
    const draft = JSON.parse(
      await readFile(draftManifestFile, "utf8")
    ) as runtime.PlanPackageManifest;
    const reviewIndex = draft.nodes[0].blocks.findIndex((block) => block.type === "review");
    draft.nodes[0].blocks[reviewIndex].id += "#old";
    await writeFile(draftManifestFile, JSON.stringify(draft));
    const files = [
      draftManifestFile,
      f.defaultWorkspace.manifestFile,
      f.defaultWorkspace.stateFile,
      join(f.defaultWorkspace.resultsDir, "keep.txt")
    ];
    const bytes = await Promise.all(files.map((file) => readFile(file)));
    const invalidDraft = {
      ok: false,
      validation: {
        ok: false,
        errors: [
          expect.objectContaining({
            code: "manifest_schema",
            path: `manifest.json:nodes.0.blocks.${reviewIndex}.id`
          })
        ]
      }
    };

    const validation = readJson(
      await handlePlanweaveTool(
        "validate_package_draft",
        { draftRoot: f.draftRoot },
        runtimeGateway
      )
    );
    expect(validation).toMatchObject({ draft: invalidDraft });
    const result = readJson(
      await handlePlanweaveTool(
        "import_package_draft",
        {
          projectId: f.project.projectId,
          canvasId: "default",
          draftRoot: f.draftRoot,
          apply: true
        },
        runtimeGateway
      )
    );
    expect(result).toMatchObject({ import: { ...invalidDraft, applied: false } });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(bytes);
  });
});
