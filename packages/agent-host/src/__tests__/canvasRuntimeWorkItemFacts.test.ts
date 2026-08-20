import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlanGraphPackage } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { resolveCanvasRuntimeWorkItems } from "../runtime/canvasRuntimeWorkItemFacts.js";

const directories: string[] = [];
const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function resolvedCanvas() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-work-item-facts-"));
  directories.push(directory);
  const manifest = basicManifest();
  const block = manifest.nodes[0]?.blocks[0];
  if (!block || block.type !== "implementation") throw new Error("test_block_missing");
  block.requirements = { capabilities: ["acp.codex", "linux"] };
  const workspace = await createTestWorkspace(manifest);
  directories.push(workspace.home, workspace.root);
  return {
    scope,
    project: workspace.init.workspace,
    canvas: workspace.init.workspace
  };
}

describe("Canvas Runtime work item facts", () => {
  it("loads one exact snapshot and preserves task/block/missing identity order", async () => {
    const resolved = await resolvedCanvas();
    const load = vi.fn(loadPlanGraphPackage);
    const result = await resolveCanvasRuntimeWorkItems(
      resolved,
      {
        workItems: [
          { kind: "task", canvasId: scope.canvasId, taskId: "T-001" },
          { kind: "block", canvasId: scope.canvasId, blockRef: "T-001#B-001" },
          { kind: "block", canvasId: scope.canvasId, blockRef: "T-001#B-999" }
        ]
      },
      load
    );

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(resolved.canvas);
    expect(result.sourceRevision).toBe(`pgv-${result.graphFingerprint}`);
    expect(result.facts).toEqual([
      {
        canvasId: "default",
        kind: "task",
        exists: true,
        taskId: "T-001",
        requiredCapabilities: []
      },
      {
        canvasId: "default",
        kind: "block",
        exists: true,
        taskId: "T-001",
        blockRef: "T-001#B-001",
        blockType: "implementation",
        requiredCapabilities: ["acp.codex", "linux"]
      },
      {
        canvasId: "default",
        kind: "block",
        exists: false,
        blockRef: "T-001#B-999",
        requiredCapabilities: []
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(resolved.canvas.rootPath);
    expect(JSON.stringify(result)).not.toContain("packageDir");
  });

  it("rejects a cross-canvas reference before reading package content", async () => {
    const resolved = await resolvedCanvas();
    const load = vi.fn(loadPlanGraphPackage);
    await expect(
      resolveCanvasRuntimeWorkItems(
        resolved,
        {
          workItems: [{ kind: "task", canvasId: "other-canvas", taskId: "T-001" }]
        },
        load
      )
    ).rejects.toThrow("work_item_scope_mismatch");
    expect(load).not.toHaveBeenCalled();
  });

  it("fails closed when the captured package evidence has read diagnostics", async () => {
    const resolved = await resolvedCanvas();
    const loaded = await loadPlanGraphPackage(resolved.canvas);
    loaded.promptReadFailuresByPath.set("prompts/missing.md", {
      kind: "missing",
      path: "prompts/missing.md",
      error: new Error("missing")
    });
    await expect(
      resolveCanvasRuntimeWorkItems(
        resolved,
        { workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }] },
        async () => loaded
      )
    ).rejects.toThrow("work_package_evidence_invalid");
  });
});
