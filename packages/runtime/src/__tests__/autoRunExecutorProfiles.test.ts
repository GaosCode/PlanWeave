import { describe, expect, it } from "vitest";
import { listExecutorProfiles, testExecutorProfile } from "../index.js";
import { writeJsonFile } from "../json.js";
import { manifestSchema } from "../schema/manifest.js";
import { validatePackage } from "../validatePackage.js";
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
    expect(parsed.executors.opencode.adapter).toBe("agent");
    expect(parsed.executors.opencode).toMatchObject({
      agent: "opencode",
      runner: { transport: "cli" }
    });
    expect(parsed.executors["claude-code"].adapter).toBe("agent");
    expect(parsed.executors.pi.adapter).toBe("agent");
    expect(parsed.executors["local-review"].adapter).toBe("local-review");
    const task = parsed.nodes[0];
    expect(task.type).toBe("task");
    expect(task.executor).toBe("codex-auto");
    expect(task.blocks[0].executor).toBe("manual");
  });

  it("accepts canonical CLI and ACP profiles with exactly one runner transport", () => {
    const base = manifestTestBuilder().build();
    const parsed = manifestSchema.parse({
      ...base,
      execution: { ...base.execution, defaultExecutor: "codex-acp" },
      executors: {
        "codex-cli": {
          adapter: "agent",
          agent: "codex",
          runner: { transport: "cli", tmuxEnabled: false },
          command: "codex",
          args: ["exec", "-"]
        },
        "codex-acp": {
          adapter: "agent",
          agent: "codex",
          runner: { transport: "acp" }
        }
      }
    });

    expect(parsed.executors["codex-cli"]).toMatchObject({
      adapter: "agent",
      agent: "codex",
      runner: { transport: "cli", tmuxEnabled: false }
    });
    expect(parsed.executors["codex-acp"]).toEqual({
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    });
  });

  it.each([
    [
      "ACP plus CLI command",
      { adapter: "agent", agent: "codex", runner: { transport: "acp" }, command: "codex" },
      [{ path: ["executors", "invalid", "command"], message: 'Unrecognized key: "command"' }]
    ],
    [
      "ACP plus tmux",
      { adapter: "agent", agent: "codex", runner: { transport: "acp", tmuxEnabled: true } },
      [
        {
          path: ["executors", "invalid", "runner", "tmuxEnabled"],
          message: 'Unrecognized key: "tmuxEnabled"'
        }
      ]
    ],
    [
      "unknown runner",
      { adapter: "agent", agent: "codex", runner: { transport: "sdk" } },
      [
        {
          path: ["executors", "invalid", "runner", "transport"],
          message: 'Invalid option: expected one of "cli"|"acp"'
        }
      ]
    ],
    [
      "unknown agent",
      { adapter: "agent", agent: "unknown", runner: { transport: "acp" } },
      [
        {
          path: ["executors", "invalid", "agent"],
          message: 'Invalid option: expected one of "codex"|"opencode"|"claude-code"|"pi"'
        }
      ]
    ],
    [
      "ambiguous legacy and canonical fields",
      {
        adapter: "codex-exec",
        agent: "codex",
        runner: { transport: "cli" },
        command: "codex",
        args: ["exec", "-"],
        transport: "acp"
      },
      [
        { path: ["executors", "invalid", "agent"], message: 'Unrecognized key: "agent"' },
        { path: ["executors", "invalid", "runner"], message: 'Unrecognized key: "runner"' },
        {
          path: ["executors", "invalid", "transport"],
          message: 'Unrecognized key: "transport"'
        }
      ]
    ],
    [
      "canonical CLI without command",
      { adapter: "agent", agent: "codex", runner: { transport: "cli" } },
      [
        {
          path: ["executors", "invalid", "command"],
          message: "Invalid input: expected string, received undefined"
        }
      ]
    ],
    [
      "CLI runner with a non-boolean tmux flag",
      {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "cli", tmuxEnabled: "yes" },
        command: "codex"
      },
      [
        {
          path: ["executors", "invalid", "runner", "tmuxEnabled"],
          message: "Invalid input: expected boolean, received string"
        }
      ]
    ],
    [
      "ACP runner with an unknown field",
      { adapter: "agent", agent: "codex", runner: { transport: "acp", sdk: true } },
      [
        {
          path: ["executors", "invalid", "runner", "sdk"],
          message: 'Unrecognized key: "sdk"'
        }
      ]
    ]
  ])("reports a clear public validation issue for %s profiles", async (_label, profile, expectedIssues) => {
    const base = manifestTestBuilder().build();
    const invalidManifest = { ...base, executors: { invalid: profile } };
    const parsed = manifestSchema.safeParse(invalidManifest);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected invalid executor profile to fail manifest parsing.");
    }
    expect(parsed.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
      expectedIssues
    );

    const { root, init } = await createTestWorkspace(base);
    await writeJsonFile(init.workspace.manifestFile, invalidManifest);
    const validation = await validatePackage({ projectRoot: root });
    expect(
      validation.errors
        .filter(
          (error) => error.code === "manifest_schema" && error.path?.includes("executors.invalid")
        )
        .map(({ path, message }) => ({
          path: path?.slice(path.indexOf("executors.invalid")) ?? null,
          message
        }))
    ).toEqual(expectedIssues.map(({ path, message }) => ({ path: path.join("."), message })));
  });

  it("rejects invalid executor references with a clear boundary error", () => {
    const base = manifestTestBuilder().build();
    expect(() =>
      manifestSchema.parse({
        ...base,
        execution: { ...base.execution, defaultExecutor: "missing-profile" }
      })
    ).toThrow(/does not reference a known executor profile/);
  });

  it("requires trust before ACP initialize without falling back to CLI", async () => {
    const manifest = manifestTestBuilder().withDefaultExecutor("codex-acp").build();
    const { root } = await createTestWorkspace(manifest);

    await expect(
      testExecutorProfile({ projectRoot: root, executorName: "codex-acp" })
    ).resolves.toMatchObject({
      adapter: "agent",
      profileAdapter: "agent",
      executionIntegration: null,
      ok: false,
      message: expect.stringContaining("Executor command is not trusted")
    });
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
    expect(
      step.kind === "submitted" && step.adapterResult.kind === "block"
        ? step.adapterResult.stdout
        : ""
    ).toContain("workspace-write");
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
        expect.objectContaining({
          name: "manual",
          adapter: "manual",
          profileAdapter: "manual",
          executionIntegration: "manual",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "codex",
          adapter: "codex-exec",
          profileAdapter: "agent",
          executionIntegration: "codex-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "codex-auto",
          adapter: "codex-exec",
          profileAdapter: "agent",
          executionIntegration: "codex-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "opencode",
          adapter: "opencode-exec",
          profileAdapter: "agent",
          executionIntegration: "opencode-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "claude-code",
          adapter: "claude-code-exec",
          profileAdapter: "agent",
          executionIntegration: "claude-code-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "claude-code-auto",
          adapter: "claude-code-exec",
          profileAdapter: "agent",
          executionIntegration: "claude-code-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "pi",
          adapter: "pi-exec",
          profileAdapter: "agent",
          executionIntegration: "pi-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "pi-auto",
          adapter: "pi-exec",
          profileAdapter: "agent",
          executionIntegration: "pi-exec",
          source: "builtin"
        }),
        expect.objectContaining({
          name: "codex-acp",
          adapter: "agent",
          profileAdapter: "agent",
          agent: "codex",
          runner: { transport: "acp" },
          executionIntegration: null,
          source: "builtin"
        }),
        expect.objectContaining({
          name: "project-codex",
          adapter: "codex-exec",
          profileAdapter: "agent",
          executionIntegration: "codex-exec",
          source: "package"
        })
      ])
    );
  });
});
