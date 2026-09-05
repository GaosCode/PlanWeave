import { describe, expect, it } from "vitest";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import {
  overlayCanvasReplicaRuntimeStatus,
  parseCanvasReplicaDocument,
  projectCanvasReplicaDocument
} from "../index.js";
import { basicManifest } from "./promptTestHelpers.js";

function document() {
  const manifest = basicManifest({ includeSecondTask: true });
  const firstImplementation = manifest.nodes[0]!.blocks.find(
    (block) => block.type === "implementation"
  );
  const secondImplementation = manifest.nodes[1]!.blocks.find(
    (block) => block.type === "implementation"
  );
  if (!firstImplementation || !secondImplementation) {
    throw new Error("test_implementation_block_missing");
  }
  firstImplementation.parallel = { sharedResources: ["packages/runtime"] };
  firstImplementation.requirements = { capabilities: ["network"] };
  manifest.nodes[0]!.blocks[1]!.depends_on = [manifest.nodes[0]!.blocks[0]!.id];
  secondImplementation.parallel = { sharedResources: ["packages/runtime"] };
  return parseCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath: Object.fromEntries(
      manifest.nodes.flatMap((task) => [
        [task.prompt, `# ${task.id} task prompt\n`],
        ...task.blocks.map((block) => [block.prompt, `# ${task.id} ${block.id} prompt\n`])
      ])
    ),
    layout: {
      version: "desktop-layout/v1",
      projectId: "project-authority",
      nodes: manifest.nodes.map((task, index) => ({
        nodeId: task.id,
        x: index * 100,
        y: index * 200
      })),
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
  });
}

describe("canvas replica graph projection", () => {
  it("projects complete authoritative content without RuntimeState or package files", () => {
    const projected = projectCanvasReplicaDocument(document());

    expect(projected.manifest.nodes[0]?.acceptance).toEqual([
      "Implementation is complete.",
      "Review passes."
    ]);
    expect(projected.promptMarkdownByPath["nodes/T-001/blocks/B-001.prompt.md"]).toBe(
      "# T-001 B-001 prompt\n"
    );
    expect(projected.tasks[0]).toMatchObject({
      taskId: "T-001",
      promptMarkdown: "# T-001 task prompt\n",
      sharedResources: ["packages/runtime"]
    });
    expect(projected.tasks[0]?.blocks[0]).toMatchObject({
      ref: "T-001#B-001",
      requiredCapabilities: ["network"],
      dispatchable: false
    });
    expect(projected.blockPromptMarkdownByRef["T-001#B-001"]).toBe("# T-001 B-001 prompt\n");
    expect(projected.blockDependenciesByRef["T-001#R-001"]).toEqual(["T-001#B-001"]);
    expect(projected.sharedResourceGroups).toEqual([
      {
        name: "packages/runtime",
        memberTaskIds: ["T-001", "T-002"],
        memberBlockRefs: ["T-001#B-001", "T-002#B-001"],
        activeBlockRefs: []
      }
    ]);
    expect(projected.layout.nodes).toEqual([
      { nodeId: "T-001", x: 0, y: 0 },
      { nodeId: "T-002", x: 100, y: 200 }
    ]);
  });

  it("overlays only compatible owner status and derives resource activity from replica content", () => {
    const projected = projectCanvasReplicaDocument(document());
    const status = canvasRuntimeStatusProjectionSchema.parse({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      packageFingerprint: projected.packageFingerprint,
      capturedAt: "2026-08-02T00:00:00.000Z",
      tasks: [
        { taskId: "T-001", status: "in_progress", openFeedbackCount: 2 },
        { taskId: "T-002", status: "ready", openFeedbackCount: 0 }
      ],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "in_progress",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: true
        },
        {
          ref: "T-001#R-001",
          status: "blocked",
          completionReason: null,
          blockedReason: "awaiting implementation",
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-002#B-001",
          status: "ready",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-002#R-001",
          status: "planned",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        }
      ]
    });

    const overlaid = overlayCanvasReplicaRuntimeStatus({
      content: projected,
      status,
      scope: status.scope
    });

    expect(overlaid.tasks[0]).toMatchObject({
      status: "in_progress",
      exceptions: [{ ref: "T-001#R-001", source: "blocked", reason: "awaiting implementation" }]
    });
    expect(overlaid.tasks[0]?.blocks[0]).toMatchObject({
      ref: "T-001#B-001",
      status: "in_progress",
      dispatchable: true,
      requiredCapabilities: ["network"]
    });
    expect(overlaid.taskOpenFeedbackCountByTaskId).toMatchObject({ "T-001": 2, "T-002": 0 });
    expect(overlaid.sharedResourceGroups[0]?.activeBlockRefs).toEqual(["T-001#B-001"]);
  });

  it("carries a stopped task across the Workspace projection without an exception or automatic dispatch", () => {
    const content = projectCanvasReplicaDocument(document());
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const status = canvasRuntimeStatusProjectionSchema.parse({
      schemaVersion: "canvas-runtime-status/v2",
      scope,
      packageFingerprint: content.packageFingerprint,
      capturedAt: "2026-09-05T00:00:00.000Z",
      tasks: content.tasks.map((task) => ({
        taskId: task.taskId,
        status: "ready",
        openFeedbackCount: 0
      })),
      blocks: content.tasks.flatMap((task) =>
        task.blocks.map((block) => ({
          ref: block.ref,
          status: block.ref === "T-001#B-001" ? "blocked" : "planned",
          stopped: block.ref === "T-001#B-001",
          completionReason: null,
          blockedReason: block.ref === "T-001#B-001" ? "[execution_cancelled] Stopped." : null,
          divergenceReason: null,
          dispatchable: false
        }))
      )
    });
    const projected = overlayCanvasReplicaRuntimeStatus({ content, status, scope });
    expect(projected.tasks[0]?.exceptions).toEqual([]);
    expect(projected.tasks[0]?.blocks[0]).toMatchObject({
      stopped: true,
      status: "blocked",
      dispatchable: false
    });
  });

  it("fails closed when the status scope or package content identity does not match", () => {
    const projected = projectCanvasReplicaDocument(document());
    const status = canvasRuntimeStatusProjectionSchema.parse({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      packageFingerprint: projected.packageFingerprint,
      capturedAt: "2026-08-02T00:00:00.000Z",
      tasks: [
        { taskId: "T-001", status: "in_progress", openFeedbackCount: 2 },
        { taskId: "T-002", status: "ready", openFeedbackCount: 0 }
      ],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "in_progress",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: true
        },
        {
          ref: "T-001#R-001",
          status: "planned",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-002#B-001",
          status: "ready",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-002#R-001",
          status: "planned",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        }
      ]
    });
    const otherScope = canvasRuntimeStatusProjectionSchema.parse({
      ...status,
      scope: { ...status.scope, canvasId: "other" }
    }).scope;
    const overlaid = overlayCanvasReplicaRuntimeStatus({
      content: projected,
      status,
      scope: otherScope
    });

    expect(overlaid.tasks[0]?.status).toBe("planned");
    expect(overlaid.tasks[0]?.blocks.every((block) => !block.dispatchable)).toBe(true);
    expect(overlaid.sharedResourceGroups.every((group) => group.activeBlockRefs.length === 0)).toBe(
      true
    );

    const fingerprintMismatch = overlayCanvasReplicaRuntimeStatus({
      content: projected,
      status: { ...status, packageFingerprint: `pkg-${"b".repeat(64)}` },
      scope: status.scope
    });
    expect(fingerprintMismatch.tasks[0]?.status).toBe("in_progress");
    expect(fingerprintMismatch.tasks[0]?.blocks[0]?.status).toBe("in_progress");
    expect(fingerprintMismatch.tasks[0]?.blocks.every((block) => !block.dispatchable)).toBe(true);
  });
});
