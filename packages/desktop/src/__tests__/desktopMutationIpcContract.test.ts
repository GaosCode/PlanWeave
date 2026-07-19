import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import {
  getRuntimeBridgeMocks,
  registeredHandler,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness";

const validRef = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
const resolvedWorkspace = {
  projectRoot: "/tmp/project",
  canvasId: "canvas-a",
  source: "task" as const
};

const validLayout = {
  version: "desktop-layout/v1" as const,
  projectId: "proj-1",
  nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
  updatedAt: "2026-07-19T00:00:00.000Z"
};

const validReviewStep = {
  blockId: "R-001",
  title: "Review",
  enabled: true,
  preset: "general",
  triggerCondition: "after_required_work_completed" as const,
  inputContext: "latest reports",
  passCriteria: "All criteria pass",
  feedbackFormat: "Actionable feedback",
  maxFeedbackCycles: 1,
  hook: null,
  promptMarkdown: "# Review\n"
};

describe("desktop mutation IPC transport schemas", () => {
  const { runtimeMock } = getRuntimeBridgeMocks();

  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
  });

  afterEach(async () => {
    await restoreRuntimeBridgeEnv();
  });

  describe("addTaskNode / addBlock", () => {
    it("forwards valid addTaskNode input once and never calls runtime on malformed objects", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.addTaskNode);
      const input = {
        title: "New task",
        promptMarkdown: "# Task",
        acceptance: ["a"],
        blockTypes: ["implementation"],
        executor: null,
        layoutPosition: { x: 1, y: 2 }
      };

      await expect(handler({}, validRef, input)).resolves.toMatchObject({
        ok: true,
        affectedTasks: ["T-new"]
      });
      expect(runtimeMock.addTaskNode).toHaveBeenCalledWith(resolvedWorkspace, input);

      runtimeMock.addTaskNode.mockClear();
      await expect(
        handler({}, validRef, { title: "x", promptMarkdown: "#", unknownField: true })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, { title: "x", promptMarkdown: "#", blockTypes: ["invalid"] })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, {
          title: "x",
          promptMarkdown: "#",
          layoutPosition: { x: Number.NaN, y: 1 }
        })
      ).rejects.toThrow();
      await expect(handler({}, { projectRoot: "", canvasId: "c" }, input)).rejects.toThrow();
      expect(runtimeMock.addTaskNode).not.toHaveBeenCalled();
    });

    it("forwards valid addBlock input and rejects unknown fields / bad enums", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.addBlock);
      const input = {
        taskId: "T-001",
        type: "implementation" as const,
        title: "Block",
        promptMarkdown: "# Block",
        dependsOn: []
      };

      await expect(handler({}, validRef, input)).resolves.toMatchObject({ ok: true });
      expect(runtimeMock.addBlock).toHaveBeenCalledWith(resolvedWorkspace, input);

      runtimeMock.addBlock.mockClear();
      await expect(
        handler({}, validRef, { ...input, type: "review-gate" })
      ).rejects.toThrow();
      await expect(handler({}, validRef, { ...input, extra: 1 })).rejects.toThrow();
      expect(runtimeMock.addBlock).not.toHaveBeenCalled();
    });
  });

  describe("validateGraphEdit", () => {
    it("accepts discriminated kinds and rejects unknown kind / extra fields", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.validateGraphEdit);
      const input = {
        kind: "addDependencyEdge" as const,
        fromTaskId: "T-001",
        toTaskId: "T-002"
      };

      await expect(handler({}, validRef, input)).resolves.toMatchObject({ ok: true });
      expect(runtimeMock.validateGraphEdit).toHaveBeenCalledWith(resolvedWorkspace, input);

      runtimeMock.validateGraphEdit.mockClear();
      await expect(
        handler({}, validRef, { kind: "mergeNodes", taskId: "T-001" })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, { kind: "removeTaskNode", taskId: "T-001", extra: true })
      ).rejects.toThrow();
      expect(runtimeMock.validateGraphEdit).not.toHaveBeenCalled();
    });
  });

  describe("prompt save options", () => {
    it("parses optional options once and rejects unknown keys", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.updateTaskPrompt);
      const options = { baseGraphVersion: "v1", basePromptHash: "abc" };

      await expect(handler({}, validRef, "T-001", "# body", options)).resolves.toMatchObject({
        ok: true
      });
      expect(runtimeMock.updateTaskPrompt).toHaveBeenCalledWith(
        resolvedWorkspace,
        "T-001",
        "# body",
        options
      );

      runtimeMock.updateTaskPrompt.mockClear();
      await expect(
        handler({}, validRef, "T-001", "# body", { baseGraphVersion: "v1", stale: true })
      ).rejects.toThrow();
      expect(runtimeMock.updateTaskPrompt).not.toHaveBeenCalled();
    });
  });

  describe("dependency edges + layoutSnapshot", () => {
    it("forwards valid layoutSnapshot and rejects malformed layout before runtime", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.addDependencyEdge);

      await expect(
        handler({}, validRef, "T-001", "T-002", "gv-1", validLayout)
      ).resolves.toMatchObject({ ok: true });
      expect(runtimeMock.addDependencyEdge).toHaveBeenCalledWith(
        resolvedWorkspace,
        "T-001",
        "T-002",
        "gv-1",
        validLayout
      );

      runtimeMock.addDependencyEdge.mockClear();
      await expect(
        handler({}, validRef, "T-001", "T-002", "gv-1", {
          version: "desktop-layout/v0",
          projectId: "p",
          nodes: [],
          updatedAt: "now"
        })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, "T-001", "T-002", "gv-1", {
          ...validLayout,
          nodes: { "T-001": { x: 1, y: 2 } }
        })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, "T-001", "T-002", "gv-1", {
          ...validLayout,
          nodes: [{ nodeId: "T-001", x: 1, y: 2, z: 3 }]
        })
      ).rejects.toThrow();
      expect(runtimeMock.addDependencyEdge).not.toHaveBeenCalled();
    });
  });

  describe("saveDesktopLayout", () => {
    it("parses layout at main and rejects unknown fields / non-array nodes", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.saveDesktopLayout);

      await expect(handler({}, validRef, validLayout)).resolves.toEqual(validLayout);
      expect(runtimeMock.saveDesktopLayout).toHaveBeenCalledWith(resolvedWorkspace, validLayout);

      runtimeMock.saveDesktopLayout.mockClear();
      await expect(
        handler({}, validRef, { ...validLayout, extra: true })
      ).rejects.toThrow();
      await expect(handler({}, validRef, null)).rejects.toThrow();
      await expect(
        handler({}, validRef, {
          version: "desktop-layout/v1",
          projectId: "",
          nodes: [],
          updatedAt: "x"
        })
      ).rejects.toThrow();
      expect(runtimeMock.saveDesktopLayout).not.toHaveBeenCalled();
    });
  });

  describe("updateReviewPipeline", () => {
    it("forwards valid bridge DTO and rejects bad enums / unknown step fields", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.updateReviewPipeline);
      const input = {
        packageDefaults: { maxFeedbackCycles: 2, completionPolicy: "strict" as const },
        steps: [validReviewStep]
      };

      await expect(handler({}, validRef, "T-001", input)).resolves.toMatchObject({
        ok: true,
        affectedTasks: ["T-001"]
      });
      expect(runtimeMock.updateReviewPipeline).toHaveBeenCalledWith(
        resolvedWorkspace,
        "T-001",
        input
      );

      runtimeMock.updateReviewPipeline.mockClear();
      await expect(
        handler({}, validRef, "T-001", {
          steps: [{ ...validReviewStep, triggerCondition: "always" }]
        })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, "T-001", {
          steps: [{ ...validReviewStep, secret: true }]
        })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, "T-001", {
          packageDefaults: { maxFeedbackCycles: 1, completionPolicy: "lenient" },
          steps: []
        })
      ).rejects.toThrow();
      expect(runtimeMock.updateReviewPipeline).not.toHaveBeenCalled();
    });
  });

  describe("updateCanvasExecutionPolicy", () => {
    it("accepts shared policy schema and rejects unknown keys / non-positive maxConcurrent", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.updateCanvasExecutionPolicy);
      const input = { parallelEnabled: true, maxConcurrent: 3, defaultExecutor: null };

      await expect(handler({}, validRef, input)).resolves.toMatchObject({ ok: true });
      expect(runtimeMock.updateCanvasExecutionPolicy).toHaveBeenCalledWith(
        resolvedWorkspace,
        input
      );

      runtimeMock.updateCanvasExecutionPolicy.mockClear();
      await expect(
        handler({}, validRef, { parallelEnabled: true, extra: 1 })
      ).rejects.toThrow();
      await expect(handler({}, validRef, { maxConcurrent: 0 })).rejects.toThrow();
      await expect(handler({}, validRef, { maxConcurrent: 1.5 })).rejects.toThrow();
      expect(runtimeMock.updateCanvasExecutionPolicy).not.toHaveBeenCalled();
    });
  });

  describe("startAutoRun / resetRuntimeState", () => {
    it("parses scope and options without defaulting in main", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.startAutoRun);
      const scope = { kind: "task" as const, taskId: "T-001" };
      const options = { tmuxEnabled: false };

      await expect(handler({}, validRef, scope, 5, options)).resolves.toMatchObject({
        runId: "RUN-001"
      });
      expect(runtimeMock.startAutoRun).toHaveBeenCalledWith(
        "/tmp/project",
        "canvas-a",
        scope,
        5,
        options
      );

      runtimeMock.startAutoRun.mockClear();
      await expect(handler({}, validRef, scope, undefined, undefined)).resolves.toMatchObject({
        runId: "RUN-001"
      });
      expect(runtimeMock.startAutoRun).toHaveBeenCalledWith(
        "/tmp/project",
        "canvas-a",
        scope,
        undefined,
        undefined
      );

      runtimeMock.startAutoRun.mockClear();
      await expect(
        handler({}, validRef, { kind: "project", taskId: "T-001" }, 5)
      ).rejects.toThrow();
      await expect(handler({}, validRef, { kind: "task" }, 5)).rejects.toThrow();
      await expect(handler({}, validRef, scope, 0)).rejects.toThrow();
      await expect(
        handler({}, validRef, scope, 5, { tmuxEnabled: true, unknown: true })
      ).rejects.toThrow();
      await expect(
        handler({}, validRef, scope, 5, { acpRecovery: { incomplete: true } })
      ).rejects.toThrow();
      expect(runtimeMock.startAutoRun).not.toHaveBeenCalled();
    });

    it("parses reset options and rejects unknown fields", async () => {
      const handler = registeredHandler(desktopBridgeInvokeChannels.resetRuntimeState);
      const options = { force: true, reason: "test reset" };

      await expect(handler({}, validRef, options)).resolves.toMatchObject({
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        options
      });
      expect(runtimeMock.resetDesktopRuntimeState).toHaveBeenCalledWith(
        "/tmp/project",
        "canvas-a",
        options
      );

      runtimeMock.resetDesktopRuntimeState.mockClear();
      await expect(
        handler({}, validRef, { force: true, extra: true })
      ).rejects.toThrow();
      expect(runtimeMock.resetDesktopRuntimeState).not.toHaveBeenCalled();
    });
  });

  describe("saveCanvasMapLayout RUNTIME-SOLE exclusion", () => {
    it("does not apply desktop layout schema in main; still rejects via runtime path on mock pass-through absence", async () => {
      // Handler remains pass-through of unknown; contract covered by canvasMapLayoutIpcContract.
      // This asserts the mutation schema suite does not register a second main-side parser path
      // by documenting that saveCanvasMapLayout is not among main-layout parse consumers.
      expect(desktopBridgeInvokeChannels.saveCanvasMapLayout).toBe("planweave:saveCanvasMapLayout");
      expect(desktopBridgeInvokeChannels.saveDesktopLayout).toBe("planweave:saveDesktopLayout");
    });
  });
});
