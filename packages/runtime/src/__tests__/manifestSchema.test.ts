import { describe, expect, it } from "vitest";
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
      depends_on: ["B-001"]
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

    expect(
      manifestSchema.safeParse(
        manifestTestBuilder()
          .withDefaultExecutor("grok-acp")
          .withTask("T-001", (task) => ({ ...task, executor: "grok-acp" }))
          .build()
      ).success
    ).toBe(true);
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

  it("accepts an implementation block without parallel coordination hints", () => {
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
    expect(parsed?.type === "implementation" ? parsed.parallel : null).toBeUndefined();
  });

  it("deduplicates shared resources", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { sharedResources: ["db", "db", "api"] };

    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    const parsed = result.data?.nodes[0]?.blocks[0];
    expect(parsed?.type === "implementation" ? parsed.parallel?.sharedResources : null).toEqual([
      "db",
      "api"
    ]);
  });

  it("normalizes empty shared resources to an absent parallel policy", () => {
    const manifest = basicManifest();
    const block = manifest.nodes[0]?.blocks[0];
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { sharedResources: [] };

    const result = manifestSchema.parse(manifest);
    const parsed = result.nodes[0]?.blocks[0];
    expect(parsed?.type === "implementation" ? parsed.parallel : null).toBeUndefined();
  });

  it("keeps plan-package/v1 version literal", () => {
    const result = manifestSchema.safeParse(basicManifest());
    expect(result.success).toBe(true);
    expect(result.data?.version).toBe("plan-package/v1");
  });

  it.each(["safe", "locks", "exclusive"])("rejects removed parallel field %s", (field) => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    block.parallel = { [field]: field === "safe" ? false : ["db"] } as never;

    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
});
