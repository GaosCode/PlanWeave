import { describe, expect, it } from "vitest";
import { manifestSchema } from "../schema/manifest.js";
import { basicManifest } from "./promptTestHelpers.js";

describe("plan-package/v1 manifest schema", () => {
  it("accepts task nodes with implementation/check/review blocks", () => {
    expect(() => manifestSchema.parse(basicManifest())).not.toThrow();
  });

  it("accepts executor profiles with task and block executor inheritance points", () => {
    const manifest = basicManifest() as any;
    manifest.execution.defaultExecutor = "codex-auto";
    manifest.executors = {
      "codex-auto": {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        sandbox: "workspace-write",
        timeoutMs: 120000
      },
      "codex-reviewer": {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        role: "reviewer"
      },
      opencode: {
        adapter: "opencode-exec",
        command: "opencode",
        args: ["run", "-"]
      },
      "local-review": {
        adapter: "local-review",
        command: "node",
        args: ["review.js"]
      }
    };
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.executor = "codex-auto";
    const review = task.blocks.find((block) => block.id === "R-001");
    if (review?.type !== "review") {
      throw new Error("missing review block");
    }
    review.executor = "codex-reviewer";

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
    expect(result.data?.execution.defaultExecutor).toBe("codex-auto");
    expect(result.data?.executors?.["codex-auto"]?.timeoutMs).toBe(120000);
    expect(result.data?.executors?.["codex-reviewer"]?.role).toBe("reviewer");
    expect(result.data?.executors?.opencode?.adapter).toBe("opencode-exec");
    expect(result.data?.executors?.["local-review"]?.adapter).toBe("local-review");
  });

  it("rejects non-positive codex executor timeouts", () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "codex-auto": {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        timeoutMs: 0
      }
    };

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it("rejects legacy manifest.global_prompt", () => {
    const manifest = { ...basicManifest(), global_prompt: "global-prompt.md" };

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain("manifest.global_prompt is not supported in plan-package/v1.");
  });

  it("rejects feedback as a block type", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks.push({
      id: "F-001",
      type: "feedback",
      title: "Feedback",
      prompt: "nodes/T-001/blocks/F-001.prompt.md",
      depends_on: []
    } as never);

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });
});
