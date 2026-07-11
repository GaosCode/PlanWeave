import { describe, expect, it } from "vitest";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { EXCLUSIVE_LOCK, PARALLEL_SAFE_DEPRECATION_MESSAGE } from "../schema/manifest.js";
import { manifestSchema } from "../schema/manifest.js";
import { basicManifest } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

describe("plan-package/v1 manifest schema", () => {
  it("accepts task nodes with implementation/review blocks", () => {
    expect(() => manifestSchema.parse(basicManifest())).not.toThrow();
  });

  it("rejects context nodes because context belongs in task prompts and acceptance", () => {
    const manifest = basicManifest();
    manifest.nodes.unshift({
      id: "G-001",
      type: "goal",
      title: "Goal",
      summary: "Goal summary."
    } as never);

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it("rejects check blocks because review blocks own verification gates", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks.splice(1, 0, {
      id: "C-001",
      type: "check",
      title: "Check task",
      prompt: "nodes/T-001/blocks/C-001.prompt.md",
      depends_on: ["B-001"],
      parallel: { safe: true, locks: ["check"] }
    } as never);

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it("accepts executor profiles with task and block executor inheritance points", () => {
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("codex-auto")
      .withExecutor("codex-auto", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        sandbox: "workspace-write",
        timeoutMs: 120000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 2048
      })
      .withExecutor("review-agent", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        role: "reviewer"
      })
      .withExecutor("opencode", {
        adapter: "opencode-exec",
        command: "opencode",
        args: ["run", "-"]
      })
      .withExecutor("claude-code", {
        adapter: "claude-code-exec",
        command: "claude",
        args: ["-p"]
      })
      .withExecutor("pi", {
        adapter: "pi-exec",
        command: "pi",
        args: ["-p"]
      })
      .withExecutor("local-review", {
        adapter: "local-review",
        command: "node",
        args: ["review.js"]
      })
      .withTask("T-001", (task) => ({ ...task, executor: "codex-auto" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "review-agent" }))
      .build();

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
    expect(result.data?.execution.defaultExecutor).toBe("codex-auto");
    expect(result.data?.executors?.["codex-auto"]?.timeoutMs).toBe(120000);
    expect(result.data?.executors?.["codex-auto"]?.maxStdoutBytes).toBe(4096);
    expect(result.data?.executors?.["codex-auto"]?.maxStderrBytes).toBe(2048);
    expect(result.data?.executors?.["review-agent"]?.role).toBe("reviewer");
    expect(result.data?.executors?.opencode).toMatchObject({
      adapter: "agent",
      agent: "opencode",
      runner: { transport: "cli" }
    });
    expect(result.data?.executors?.["claude-code"]).toMatchObject({
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "cli" }
    });
    expect(result.data?.executors?.pi).toMatchObject({
      adapter: "agent",
      agent: "pi",
      runner: { transport: "cli" }
    });
    expect(result.data?.executors?.["local-review"]?.adapter).toBe("local-review");
  });

  it("accepts agent builtin executors without package profiles", () => {
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("opencode")
      .withTask("T-001", (task) => ({ ...task, executor: "codex" }))
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "claude-code" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "pi" }))
      .build();

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
  });

  it("rejects non-positive codex executor timeouts", () => {
    const manifest = manifestTestBuilder()
      .withExecutor("codex-auto", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        timeoutMs: 0
      })
      .build();

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it("rejects non-positive executor output limits", () => {
    const manifest = manifestTestBuilder()
      .withExecutor("codex-auto", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        maxStdoutBytes: 0
      })
      .build();

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it("rejects legacy manifest.global_prompt", () => {
    const manifest = { ...basicManifest(), global_prompt: "global-prompt.md" };

    const result = manifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "manifest.global_prompt is not supported in plan-package/v1."
    );
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

  it("defaults absent parallel to locks-only empty policy", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    delete (block as { parallel?: unknown }).parallel;

    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    const parsed = result.data?.nodes
      .find((node) => node.type === "task")
      ?.blocks.find((item) => item.id === "B-001");
    expect(parsed?.type === "implementation" ? parsed.parallel : null).toEqual({ locks: [] });
  });

  it("accepts locks including reserved exclusive", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { locks: ["exclusive"] };

    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("keeps plan-package/v1 version literal", () => {
    const result = manifestSchema.safeParse(basicManifest());
    expect(result.success).toBe(true);
    expect(result.data?.version).toBe("plan-package/v1");
  });

  it("emits deprecation warning and maps safe:false to exclusive at compile time", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { safe: false, locks: ["db"] };

    const graph = compileTaskGraph(manifestSchema.parse(manifest));
    expect(graph.locksByBlockRef.get("T-001#B-001")).toEqual(["db", EXCLUSIVE_LOCK]);
    expect(
      graph.diagnostics.warnings.some(
        (warning) =>
          warning.code === "parallel_safe_deprecated" &&
          warning.message === PARALLEL_SAFE_DEPRECATION_MESSAGE
      )
    ).toBe(true);
  });

  it("treats safe:true as no-op with deprecation warning", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { safe: true, locks: ["api"] };

    const graph = compileTaskGraph(manifestSchema.parse(manifest));
    expect(graph.locksByBlockRef.get("T-001#B-001")).toEqual(["api"]);
    expect(
      graph.diagnostics.warnings.some((warning) => warning.code === "parallel_safe_deprecated")
    ).toBe(true);
  });
});
