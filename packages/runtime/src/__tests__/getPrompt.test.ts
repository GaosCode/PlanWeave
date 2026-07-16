import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { renderPrompt } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

describe("renderPrompt", () => {
  it("renders global, project, task, block, graph, and submission instructions for a block ref", async () => {
    const { home, root, init } = await createTestWorkspace();
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "global-prompt.md"), "Global policy\n", "utf8");
    await writeFile(init.workspace.projectPromptFile, "Project policy\n", "utf8");

    const prompt = await renderPrompt({ projectRoot: root, ref: "T-001#B-001" });

    expect(prompt).toContain("Global policy");
    expect(prompt).toContain("Project policy");
    expect(prompt).toContain("# T-001 task prompt");
    expect(prompt).toContain("# T-001#B-001 implementation prompt");
    expect(prompt).toContain("Suggested Implementation Report Format");
    expect(prompt).toContain(
      "Verification: commands, checks, or manual validation performed, including the result."
    );
    expect(prompt).toContain("planweave submit-result --canvas default T-001#B-001 --report");
  });

  it("renders review result JSON instructions for review blocks", async () => {
    const { root } = await createTestWorkspace();

    const prompt = await renderPrompt({ projectRoot: root, ref: "T-001#R-001" });

    expect(prompt).toContain("Required Review Result JSON");
    expect(prompt).toContain('"reviewBlockRef": "T-001#R-001"');
    expect(prompt).toContain("Write `content` as concise Markdown.");
    expect(prompt).toContain("each actionable finding on its own paragraph with `[P0]`");
    expect(prompt).not.toContain("Suggested Implementation Report Format");
    expect(prompt).toContain("planweave submit-review --canvas default T-001#R-001 --result");
  });

  it("scopes submission instructions for formal project graph canvases with arbitrary package paths", async () => {
    const { root, init } = await createTestWorkspace();
    const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime" }),
        {
          id: "manual-canvas",
          type: "canvas",
          title: "Manual Canvas",
          packageDir: "manual-canvas/package",
          stateFile: "manual-canvas/state.json",
          resultsDir: "manual-canvas/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });
    const workspace = await resolveTaskCanvasWorkspace(root, "manual-canvas");

    await expect(renderPrompt({ projectRoot: workspace, ref: "T-001#B-001" })).resolves.toContain(
      "planweave submit-result --canvas manual-canvas T-001#B-001 --report"
    );
    await expect(renderPrompt({ projectRoot: workspace, ref: "T-001#R-001" })).resolves.toContain(
      "planweave submit-review --canvas manual-canvas T-001#R-001 --result"
    );
  });
});
