import { describe, expect, it } from "vitest";
import { validatePackage } from "../validatePackage.js";
import { summarizeValidationReport } from "../validation/validationSummary.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { writeJsonFile } from "../json.js";

describe("summarizeValidationReport", () => {
  it("groups validation issues by code, message, and normalized path pattern", () => {
    const summary = summarizeValidationReport(
      [
        { code: "manifest_schema", message: "Required", path: "manifest.json:nodes.0.acceptance" },
        { code: "manifest_schema", message: "Required", path: "manifest.json:nodes.1.acceptance" },
        { code: "manifest_schema", message: "Required", path: "manifest.json:nodes.0.title" },
        {
          code: "manifest_schema",
          message: "Invalid type",
          path: "manifest.json:nodes.0.acceptance"
        },
        { code: "prompt_missing", message: "Prompt missing", path: "nodes/T-001/prompt.md" }
      ],
      [{ code: "stale_prompt_reference", message: "Stale prompt", path: "nodes/T-999/prompt.md" }]
    );

    expect(summary.errorCount).toBe(5);
    expect(summary.warningCount).toBe(1);
    expect(summary.groups).toEqual([
      {
        code: "manifest_schema",
        message: "Required",
        count: 2,
        examples: ["manifest.json:nodes.0.acceptance", "manifest.json:nodes.1.acceptance"]
      },
      {
        code: "manifest_schema",
        message: "Required",
        count: 1,
        examples: ["manifest.json:nodes.0.title"]
      },
      {
        code: "manifest_schema",
        message: "Invalid type",
        count: 1,
        examples: ["manifest.json:nodes.0.acceptance"]
      },
      {
        code: "prompt_missing",
        message: "Prompt missing",
        count: 1,
        examples: ["nodes/T-001/prompt.md"]
      },
      {
        code: "stale_prompt_reference",
        message: "Stale prompt",
        count: 1,
        examples: ["nodes/T-999/prompt.md"]
      }
    ]);
  });

  it("limits examples to three and falls back to the issue message when path is absent", () => {
    const summary = summarizeValidationReport({
      errors: [
        { code: "manifest_schema", message: "Required" },
        { code: "manifest_schema", message: "Required" },
        { code: "manifest_schema", message: "Required" },
        { code: "manifest_schema", message: "Required" }
      ],
      warnings: []
    });

    expect(summary.groups).toEqual([
      {
        code: "manifest_schema",
        message: "Required",
        count: 4,
        examples: ["Required", "Required", "Required"]
      }
    ]);
  });

  it("keeps schema issues with different messages in separate groups", () => {
    const summary = summarizeValidationReport({
      errors: [
        { code: "manifest_schema", message: "Required", path: "manifest.json:nodes.0.acceptance" },
        {
          code: "manifest_schema",
          message: "Invalid type",
          path: "manifest.json:nodes.1.acceptance"
        }
      ],
      warnings: []
    });

    expect(summary.groups).toEqual([
      {
        code: "manifest_schema",
        message: "Required",
        count: 1,
        examples: ["manifest.json:nodes.0.acceptance"]
      },
      {
        code: "manifest_schema",
        message: "Invalid type",
        count: 1,
        examples: ["manifest.json:nodes.1.acceptance"]
      }
    ]);
  });

  it("keeps original validatePackage errors and warnings while adding summary", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.manifestFile, {
      ...basicManifest(),
      global_prompt: "global-prompt.md"
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("manifest_schema");
    expect(report.warnings).toEqual([]);
    expect(report.summary.errorCount).toBe(report.errors.length);
    expect(report.summary.warningCount).toBe(report.warnings.length);
    expect(report.summary.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest_schema",
          count: report.errors.filter((error) => error.code === "manifest_schema").length
        })
      ])
    );
  });
});
