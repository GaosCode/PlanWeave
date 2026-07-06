import { describe, expect, it } from "vitest";
import { listExecutorProfiles } from "../index.js";
import { manifestSchema } from "../schema/manifest.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractCodexExecAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run executor profiles", () => {
  it("accepts executor profiles and task/block executor inheritance in Plan Package manifests", () => {
    const parsed = manifestSchema.parse({
      version: "plan-package/v1",
      project: {
        title: "Executor profile package",
        description: "Exercises Auto Run executor profile schema."
      },
      execution: {
        defaultExecutor: "codex-auto",
        parallel: {
          enabled: false,
          maxConcurrent: 1
        }
      },
      executors: {
        "codex-auto": {
          adapter: "codex-exec",
          command: "codex",
          args: ["exec", "-"],
          sandbox: "workspace-write"
        },
        manual: {
          adapter: "manual"
        },
        opencode: {
          adapter: "opencode-exec",
          command: "opencode",
          args: ["run", "-"]
        },
        "claude-code": {
          adapter: "claude-code-exec",
          command: "claude",
          args: ["-p"]
        },
        pi: {
          adapter: "pi-exec",
          command: "pi",
          args: ["-p"]
        },
        "local-review": {
          adapter: "local-review",
          command: "node",
          args: ["review.js"]
        }
      },
      review: {
        maxFeedbackCycles: 1,
        completionPolicy: "strict"
      },
      nodes: [
        {
          id: "T-001",
          type: "task",
          title: "Executor task",
          prompt: "nodes/T-001/prompt.md",
          executor: "codex-auto",
          acceptance: ["Executor profiles are selectable."],
          blocks: [
            {
              id: "B-001",
              type: "implementation",
              title: "Implementation",
              prompt: "nodes/T-001/blocks/B-001.prompt.md",
              depends_on: [],
              executor: "manual",
              parallel: {
                safe: false,
                locks: []
              }
            }
          ]
        }
      ],
      edges: []
    });

    expect(parsed.execution.defaultExecutor).toBe("codex-auto");
    expect(parsed.executors.manual.adapter).toBe("manual");
    expect(parsed.executors.opencode.adapter).toBe("opencode-exec");
    expect(parsed.executors["claude-code"].adapter).toBe("claude-code-exec");
    expect(parsed.executors.pi.adapter).toBe("pi-exec");
    expect(parsed.executors["local-review"].adapter).toBe("local-review");
    const task = parsed.nodes[0];
    expect(task.type).toBe("task");
    expect(task.executor).toBe("codex-auto");
    expect(task.blocks[0].executor).toBe("manual");
  });

  it("passes executor profile sandbox to codex-exec command arguments", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--"],
        sandbox: "workspace-write"
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: {
        kind: "block",
        stdout: expect.stringContaining("--sandbox")
      }
    });
    expect(step.kind === "submitted" && step.adapterResult.kind === "block" ? step.adapterResult.stdout : "").toContain("workspace-write");
  });

  it("lists built-in and package-defined executor profiles", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("project-codex", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"]
      })
      .build();
    const { root } = await createTestWorkspace(manifest);

    await expect(listExecutorProfiles({ projectRoot: root })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "manual", adapter: "manual", source: "builtin" }),
        expect.objectContaining({ name: "codex", adapter: "codex-exec", source: "builtin" }),
        expect.objectContaining({ name: "codex-auto", adapter: "codex-exec", source: "builtin" }),
        expect.objectContaining({ name: "opencode", adapter: "opencode-exec", source: "builtin" }),
        expect.objectContaining({ name: "claude-code", adapter: "claude-code-exec", source: "builtin" }),
        expect.objectContaining({ name: "claude-code-auto", adapter: "claude-code-exec", source: "builtin" }),
        expect.objectContaining({ name: "pi", adapter: "pi-exec", source: "builtin" }),
        expect.objectContaining({ name: "pi-auto", adapter: "pi-exec", source: "builtin" }),
        expect.objectContaining({ name: "project-codex", adapter: "codex-exec", source: "package" })
      ])
    );
  });
});
