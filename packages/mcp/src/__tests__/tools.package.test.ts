import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, readJson, validValidationSummary } from "./toolTestHelpers.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

describe("package MCP tools", () => {
  it("reads package files and prompt content through bounded content tools", async () => {
    const gateway = createGateway();

    const files = readJson(
      await handlePlanweaveTool(
        "list_package_files",
        { projectId: "project-1", canvasId: "default", limit: 25 },
        gateway
      )
    );
    const file = readJson(
      await handlePlanweaveTool(
        "read_package_file",
        { projectId: "project-1", canvasId: "default", path: "manifest.json", maxBytes: 100 },
        gateway
      )
    );
    const promptSource = readJson(
      await handlePlanweaveTool(
        "read_prompt_source",
        {
          projectId: "project-1",
          canvasId: "default",
          target: "block",
          blockRef: "T-001#I-001",
          maxBytes: 100
        },
        gateway
      )
    );
    const rendered = readJson(
      await handlePlanweaveTool(
        "get_rendered_prompt",
        { projectId: "project-1", canvasId: "default", ref: "T-001#I-001", maxBytes: 100 },
        gateway
      )
    );
    const sources = readJson(
      await handlePlanweaveTool(
        "get_prompt_sources",
        { projectId: "project-1", canvasId: "default", ref: "T-001#I-001" },
        gateway
      )
    );

    expect(gateway.listPackageFiles).toHaveBeenCalledWith("project-1", "default", 25, undefined);
    expect(gateway.readPackageFile).toHaveBeenCalledWith(
      "project-1",
      "default",
      "manifest.json",
      100
    );
    expect(gateway.readPromptSource).toHaveBeenCalledWith("project-1", "default", {
      target: "block",
      taskId: undefined,
      blockRef: "T-001#I-001",
      maxBytes: 100
    });
    expect(gateway.readRenderedPrompt).toHaveBeenCalledWith(
      "project-1",
      "default",
      "T-001#I-001",
      100
    );
    expect(gateway.getPromptSources).toHaveBeenCalledWith("project-1", "default", "T-001#I-001");
    expect(files).toMatchObject({ files: [{ path: "manifest.json" }], pagination: { total: 1 } });
    expect(file).toMatchObject({ file: { content: "{}", truncated: false } });
    expect(promptSource).toMatchObject({ prompt: { contentRef: { kind: "prompt_source" } } });
    expect(rendered).toMatchObject({
      prompt: { content: "# Rendered prompt", contentRef: { kind: "rendered_prompt" } }
    });
    expect(sources).toMatchObject({
      promptSources: { ref: "T-001#I-001", sources: [{ kind: "block" }] }
    });
  });

  it("refreshes prompts with bounded default output and explicit markdown debug output", async () => {
    const gateway = createGateway();
    const refresh = readJson(
      await handlePlanweaveTool(
        "refresh_prompts",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );
    const refreshSummary = readJson(
      await handlePlanweaveTool(
        "refresh_prompts_summary",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );
    const refreshFullDebug = readJson(
      await handlePlanweaveTool(
        "refresh_prompts_full_debug",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );
    const outputSchema = z.object(planweaveToolOutputSchemas.refresh_prompts);

    expect(gateway.refreshPrompts).toHaveBeenCalledWith("project-1", "default");
    expect(outputSchema.safeParse(refresh).success).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.refresh_prompts_summary).safeParse(refreshSummary).success
    ).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.refresh_prompts_full_debug).safeParse(refreshFullDebug)
        .success
    ).toBe(true);
    expect(refresh).toMatchObject({
      refresh: {
        promptCount: 1,
        contentIncluded: false,
        prompts: [{ ref: "T-001#I-001", path: "", markdownBytes: 9 }]
      }
    });
    expect(refreshSummary).toEqual(refresh);
    expect(JSON.stringify(refresh)).not.toContain("# Surface");
    expect(refreshFullDebug).toMatchObject({
      refresh: {
        promptCount: 1,
        contentIncluded: true,
        prompts: [{ ref: "T-001#I-001", path: "", markdown: "# Surface", markdownBytes: 9 }]
      }
    });
  });

  it("exports and imports package file sets as structured content", async () => {
    const gateway = createGateway();
    const exported = readJson(
      await handlePlanweaveTool(
        "export_plan_package",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );
    const exportedSummary = readJson(
      await handlePlanweaveTool(
        "export_plan_package_summary",
        { projectId: "project-1", canvasId: "default", includeFiles: true },
        gateway
      )
    );
    const exportedFiles = readJson(
      await handlePlanweaveTool(
        "export_plan_package_files",
        { projectId: "project-1", canvasId: "default", paths: ["manifest.json"] },
        gateway
      )
    );
    const exportedContent = readJson(
      await handlePlanweaveTool(
        "export_plan_package",
        { projectId: "project-1", canvasId: "default", includeFiles: true },
        gateway
      )
    );
    const exportedFull = readJson(
      await handlePlanweaveTool(
        "export_plan_package_full",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );
    const outputSchema = z.object(planweaveToolOutputSchemas.export_plan_package);
    const imported = readJson(
      await handlePlanweaveTool(
        "import_plan_package",
        { name: "Imported", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] },
        gateway
      )
    );

    expect(outputSchema.safeParse(exported).success).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.export_plan_package_summary).safeParse(exportedSummary)
        .success
    ).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.export_plan_package_files).safeParse(exportedFiles)
        .success
    ).toBe(true);
    expect(outputSchema.safeParse(exportedContent).success).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.export_plan_package_full).safeParse(exportedFull).success
    ).toBe(true);
    expect(exported).toMatchObject({
      planPackage: {
        canvasId: "default",
        fileCount: 1,
        contentIncluded: false,
        files: [{ path: "manifest.json", contentBytes: 2, encoding: "utf8" }]
      }
    });
    expect(JSON.stringify(exported)).not.toContain('"content"');
    expect(exportedSummary).toMatchObject({ planPackage: { contentIncluded: false } });
    expect(JSON.stringify(exportedSummary)).not.toContain('"content"');
    expect(exportedFiles).toMatchObject({
      planPackage: { files: [{ path: "manifest.json", content: "{}" }] }
    });
    expect(exportedContent).toMatchObject({
      planPackage: {
        canvasId: "default",
        fileCount: 1,
        contentIncluded: true,
        files: [{ path: "manifest.json", content: "{}", contentBytes: 2, encoding: "utf8" }]
      }
    });
    expect(exportedFull).toMatchObject({
      planPackage: { files: [{ path: "manifest.json", content: "{}" }] },
      heavy: true
    });
    await expect(
      handlePlanweaveTool(
        "export_plan_package_files",
        { projectId: "project-1", canvasId: "default", paths: ["missing.md"] },
        gateway
      )
    ).rejects.toThrow("Requested package export file(s) not found: missing.md");
    expect(gateway.importPlanPackage).toHaveBeenCalledWith({
      name: "Imported",
      files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }],
      overwrite: false
    });
    expect(imported).toMatchObject({
      importedFiles: 1,
      validation: { ok: true, summary: validValidationSummary }
    });
  });

  it("exports projects through summary, selected files, and explicit full debug tools", async () => {
    const gateway = createGateway();
    const exported = readJson(
      await handlePlanweaveTool("export_project", { projectId: "project-1" }, gateway)
    );
    const summary = readJson(
      await handlePlanweaveTool("export_project_summary", { projectId: "project-1" }, gateway)
    );
    const files = readJson(
      await handlePlanweaveTool(
        "export_project_files",
        {
          projectId: "project-1",
          includeProjectPrompt: true,
          packageFiles: [{ canvasId: "default", path: "manifest.json" }]
        },
        gateway
      )
    );
    const full = readJson(
      await handlePlanweaveTool("export_project_full_debug", { projectId: "project-1" }, gateway)
    );

    expect(z.object(planweaveToolOutputSchemas.export_project).safeParse(exported).success).toBe(
      true
    );
    expect(
      z.object(planweaveToolOutputSchemas.export_project_summary).safeParse(summary).success
    ).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.export_project_files).safeParse(files).success).toBe(
      true
    );
    expect(
      z.object(planweaveToolOutputSchemas.export_project_full_debug).safeParse(full).success
    ).toBe(true);
    expect(exported).toMatchObject({
      projectExport: {
        project: { projectId: "project-1" },
        projectPrompt: { contentIncluded: false },
        planPackages: [
          {
            canvasId: "default",
            contentIncluded: false,
            files: [{ path: "manifest.json", contentBytes: 2 }]
          }
        ]
      }
    });
    expect(summary).toEqual(exported);
    expect(JSON.stringify(exported)).not.toContain("projectPromptMarkdown");
    expect(JSON.stringify(exported)).not.toContain('"content"');
    expect(files).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project",
        planPackages: [{ canvasId: "default", files: [{ path: "manifest.json", content: "{}" }] }]
      }
    });
    expect(full).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project",
        planPackages: [{ canvasId: "default", files: [{ path: "manifest.json", content: "{}" }] }]
      },
      heavy: true
    });
    await expect(
      handlePlanweaveTool(
        "export_project_files",
        { projectId: "project-1", packageFiles: [{ canvasId: "default", path: "missing.md" }] },
        gateway
      )
    ).rejects.toThrow("Requested project export file not found: default:missing.md");
  });

  it("validates, previews, and applies package draft imports through dedicated tools", async () => {
    const gateway = createGateway();

    const validation = readJson(
      await handlePlanweaveTool("validate_package_draft", { draftRoot: "/draft" }, gateway)
    );
    const preview = readJson(
      await handlePlanweaveTool(
        "preview_package_import",
        { projectId: "project-1", canvasId: "default", draftRoot: "/draft" },
        gateway
      )
    );
    const applied = readJson(
      await handlePlanweaveTool(
        "import_package_draft",
        { projectId: "project-1", canvasId: "default", draftRoot: "/draft", apply: true },
        gateway
      )
    );

    expect(gateway.validatePackageDraft).toHaveBeenCalledWith("/draft");
    expect(gateway.previewPackageDraftImport).toHaveBeenCalledWith({
      projectId: "project-1",
      canvasId: "default",
      draftRoot: "/draft"
    });
    expect(gateway.importPackageDraft).toHaveBeenCalledWith({
      projectId: "project-1",
      canvasId: "default",
      draftRoot: "/draft"
    });
    expect(
      z.object(planweaveToolOutputSchemas.validate_package_draft).safeParse(validation).success
    ).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.preview_package_import).safeParse(preview).success
    ).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.import_package_draft).safeParse(applied).success
    ).toBe(true);
    expect(validation).toMatchObject({
      draft: { ok: true, validation: { summary: validValidationSummary } }
    });
    expect(preview).toMatchObject({
      preview: {
        ok: true,
        summary: { changed: 1 },
        effects: expect.arrayContaining([{ type: "replace_package", path: "package" }])
      }
    });
    expect(applied).toMatchObject({
      import: {
        ok: true,
        applied: true,
        effects: expect.arrayContaining([{ type: "replace_package", path: "package" }])
      }
    });
    await expect(
      handlePlanweaveTool(
        "import_package_draft",
        { projectId: "project-1", canvasId: "default", draftRoot: "/draft" },
        gateway
      )
    ).rejects.toThrow("import_package_draft requires apply: true");
  });
});
