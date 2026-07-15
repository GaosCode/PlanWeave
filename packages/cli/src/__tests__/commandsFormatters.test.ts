import { describe, expect, it } from "vitest";
import type { ProducedExecutorPreflightResult } from "@planweave-ai/runtime";
import {
  formatExecutorProfilesHuman,
  formatExecutorTestHuman,
  formatExecutorTestJson
} from "../commands/formatters/executorFormatters.js";
import {
  formatProjectGraphConflictDiagnostics,
  formatProjectGraphMaterializeHuman,
  formatProjectGraphMigrationHuman
} from "../commands/formatters/projectGraphFormatters.js";
import {
  formatClaimHint,
  formatExecutionStatusHuman
} from "../commands/formatters/statusFormatters.js";

function preflightResult(
  patch: Partial<ProducedExecutorPreflightResult>
): ProducedExecutorPreflightResult {
  return {
    name: "executor",
    adapter: null,
    profileAdapter: null,
    executionIntegration: null,
    agentId: null,
    runnerKind: null,
    failureCode: null,
    agentInfo: null,
    authentication: null,
    capabilities: null,
    sessionConfig: null,
    ok: true,
    message: "executor preflight passed",
    checks: [],
    ...patch
  };
}

describe("planweave CLI command formatters", () => {
  it("prints executor preflight facts as JSON", () => {
    const result = JSON.parse(
      formatExecutorTestJson(
        preflightResult({
          name: "node-version",
          adapter: "codex-exec",
          profileAdapter: "agent",
          executionIntegration: "codex-exec",
          agentId: "codex",
          runnerKind: "cli",
          ok: true,
          message: "v26.3.0",
          checks: [
            {
              check: "profile_exists",
              status: "passed",
              message: "Executor profile 'node-version' exists."
            },
            {
              check: "adapter_supported",
              status: "passed",
              message: "Executor adapter 'codex-exec' is supported."
            },
            {
              check: "cwd_resolved",
              status: "passed",
              message: "Project cwd resolved.",
              cwd: "/tmp/project"
            },
            {
              check: "command_started",
              status: "passed",
              message: "Command started.",
              command: process.execPath,
              cwd: "/tmp/project"
            },
            {
              check: "command_version",
              status: "passed",
              message: "v26.3.0",
              command: process.execPath,
              cwd: "/tmp/project",
              output: "v26.3.0",
              exitCode: 0,
              timedOut: false
            }
          ]
        })
      )
    );

    expect(result).toMatchObject({
      name: "node-version",
      adapter: "codex-exec",
      profileAdapter: "agent",
      executionIntegration: "codex-exec",
      ok: true,
      checks: [
        { check: "profile_exists", status: "passed" },
        { check: "adapter_supported", status: "passed" },
        { check: "cwd_resolved", status: "passed" },
        { check: "command_started", status: "passed", command: process.execPath },
        { check: "command_version", status: "passed", output: "v26.3.0" }
      ]
    });
  });

  it("prints executor preflight failure reasons in human output", () => {
    const output = formatExecutorTestHuman(
      preflightResult({
        name: "missing-profile",
        ok: false,
        failureCode: "invalid_profile",
        message: "Executor profile 'missing-profile' does not exist.",
        checks: [
          {
            check: "profile_exists",
            status: "failed",
            message: "Executor profile 'missing-profile' does not exist."
          },
          {
            check: "adapter_supported",
            status: "skipped",
            message: "Executor profile does not exist."
          },
          {
            check: "cwd_resolved",
            status: "passed",
            message: "Project cwd resolved.",
            cwd: "/tmp/project"
          },
          {
            check: "command_started",
            status: "skipped",
            message: "Executor profile does not exist."
          },
          {
            check: "command_version",
            status: "skipped",
            message: "Executor profile does not exist."
          }
        ]
      })
    );
    expect(output).toBe(
      "failed missing-profile agent=none runner=none: Executor profile 'missing-profile' does not exist."
    );
    expect(output).not.toContain("fallback");
  });

  it("explains ready authentication states in human output", () => {
    expect(
      formatExecutorTestHuman(
        preflightResult({
          name: "codex-acp",
          adapter: "agent",
          profileAdapter: "agent",
          agentId: "codex",
          runnerKind: "acp",
          authentication: { status: "not_advertised" }
        })
      )
    ).toContain("authentication: not advertised; protocol authentication was not invoked.");
    expect(
      formatExecutorTestHuman(
        preflightResult({
          name: "grok-acp",
          adapter: "agent",
          profileAdapter: "agent",
          agentId: "grok",
          runnerKind: "acp",
          authentication: { status: "authenticated", methodId: "cached_token" }
        })
      )
    ).toContain("authentication: authenticated with method 'cached_token'.");
  });

  it.each([
    {
      reason: "missing_credentials" as const,
      methods: [
        {
          id: "api-key",
          name: "API key",
          type: "env_var" as const,
          requiredVariables: ["SAFE_API_KEY"],
          missingVariables: ["SAFE_API_KEY"],
          link: "https://agent.example.com/login"
        }
      ],
      expected: [
        "action required (missing_credentials)",
        "id=api-key type=env_var",
        "missing environment variables: SAFE_API_KEY",
        "authentication link: https://agent.example.com/login",
        "configure the missing environment variables"
      ]
    },
    {
      reason: "interactive_method" as const,
      methods: [{ id: "terminal-login", name: "Terminal login", type: "terminal" as const }],
      expected: [
        "action required (interactive_method)",
        "id=terminal-login type=terminal",
        "agent's terminal or interactive login outside PlanWeave"
      ]
    },
    {
      reason: "no_safe_method" as const,
      methods: [{ id: "agent-login", name: "Agent login", type: "agent" as const }],
      expected: [
        "action required (no_safe_method)",
        "id=agent-login type=agent",
        "complete authentication with the agent outside PlanWeave"
      ]
    }
  ])("explains $reason without suggesting a runner fallback", ({ reason, methods, expected }) => {
    const output = formatExecutorTestHuman(
      preflightResult({
        name: "agent-acp",
        adapter: "agent",
        profileAdapter: "agent",
        agentId: "codex",
        runnerKind: "acp",
        failureCode: "auth_required",
        ok: false,
        message: "Authentication required.",
        authentication: { status: "action_required", reason, methods }
      })
    );
    for (const fragment of expected) {
      expect(output).toContain(fragment);
    }
    expect(output).not.toContain("fallback");
    expect(output).not.toContain("permission");
    expect(output).not.toContain("elicitation");
  });

  it("serializes the produced runtime DTO without secret or protocol metadata fields", () => {
    const output = formatExecutorTestJson(
      preflightResult({
        name: "agent-acp",
        adapter: "agent",
        profileAdapter: "agent",
        agentId: "codex",
        runnerKind: "acp",
        failureCode: "auth_required",
        ok: false,
        authentication: {
          status: "action_required",
          reason: "missing_credentials",
          methods: [
            {
              id: "api-key",
              name: "API key",
              type: "env_var",
              requiredVariables: ["SAFE_API_KEY"],
              missingVariables: ["SAFE_API_KEY"],
              link: "https://agent.example.com/login"
            }
          ]
        }
      })
    );

    expect(JSON.parse(output).authentication.methods[0]).toEqual({
      id: "api-key",
      name: "API key",
      type: "env_var",
      requiredVariables: ["SAFE_API_KEY"],
      missingVariables: ["SAFE_API_KEY"],
      link: "https://agent.example.com/login"
    });
    expect(output).not.toContain("super-secret-value");
    expect(output).not.toContain("_meta");
    expect(output).not.toContain("terminal env");
  });

  it("prints executor profile lists in human output", () => {
    expect(
      formatExecutorProfilesHuman([
        {
          name: "manual",
          adapter: "manual",
          profileAdapter: "manual",
          executionIntegration: "manual",
          source: "builtin"
        }
      ])
    ).toBe("manual\tmanual\tnone\tnone\tbuiltin");
  });

  it("prints claim hint status reasons", () => {
    expect(
      formatClaimHint({
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        status: "blocked",
        statusReason: "Waiting for external API access.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        blockedByProject: [],
        sequentialOnly: false,
        recommendedCommand: null,
        dispatchable: false,
        dispatchCommand: null,
        reviewGate: null
      })
    ).toContain("blocked: Waiting for external API access.");
  });

  it("prints optional review claimability reasons before raw ready status", () => {
    expect(
      formatClaimHint({
        ref: "T-001#R-001",
        taskId: "T-001",
        blockId: "R-001",
        blockType: "review",
        status: "ready",
        statusReason:
          "Optional review gate is not required and is not claimable; task can complete without it.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        blockedByProject: [],
        sequentialOnly: true,
        recommendedCommand: null,
        dispatchable: false,
        dispatchCommand: null,
        reviewGate: {
          isGate: true,
          required: false,
          requiredReason: "Optional review gate; not required for task completion.",
          executorRole: "reviewer",
          downstreamTasks: [],
          unlocksTasks: [],
          needsChangesReturnsTo: ["T-001#B-001"]
        }
      })
    ).toContain(
      "ready: Optional review gate is not required and is not claimable; task can complete without it."
    );
  });

  it("prints execution status in human output", () => {
    const status: Parameters<typeof formatExecutionStatusHuman>[0] = {
      projectId: "project",
      projectRoot: "/tmp/project",
      taskTotal: 1,
      blockTotal: 1,
      tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          type: "implementation",
          status: "ready",
          reason: null,
          completionReason: null,
          lastRunId: null,
          latestReviewAttemptId: null,
          activeFeedbackId: null
        }
      ],
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      openFeedback: [],
      nextClaimable: ["T-001#B-001"],
      nextParallelClaimable: ["T-001#B-001"],
      nextSequentialClaimable: [],
      nextParallelDispatchable: [],
      claimHints: [],
      warnings: [{ code: "example_warning", message: "Check this." }],
      counts: {
        tasks: { planned: 0, ready: 1, in_progress: 0, implemented: 0 },
        blocks: {
          planned: 0,
          ready: 1,
          in_progress: 0,
          completed: 0,
          needs_changes: 0,
          blocked: 0,
          diverged: 0
        },
        feedback: { open: 0, in_progress: 0, resolved: 0, dismissed: 0 }
      },
      orphanState: [],
      orphanResults: []
    };

    expect(formatExecutionStatusHuman(status)).toContain(
      "Next claimable: T-001#B-001\nNext parallel claimable: T-001#B-001"
    );
    expect(formatExecutionStatusHuman(status)).toContain(
      "Warnings:\n- example_warning: Check this."
    );
  });

  it("prints project graph migration summaries in human output", () => {
    expect(
      formatProjectGraphConflictDiagnostics([
        { code: "conflict", message: "Legacy and canonical paths both exist." }
      ])
    ).toBe("conflict: Legacy and canonical paths both exist.");
    expect(
      formatProjectGraphMigrationHuman({
        action: "migrate",
        reason: "Legacy default canvas workspace can be migrated.",
        diagnostics: [],
        canonicalPaths: {
          workspaceRoot: "/tmp/project/canvases/default",
          packageDir: "/tmp/project/canvases/default/package",
          stateFile: "/tmp/project/canvases/default/state.json",
          resultsDir: "/tmp/project/canvases/default/results"
        },
        legacyPaths: {
          workspaceRoot: "/tmp/project",
          packageDir: "/tmp/project/package",
          stateFile: "/tmp/project/state.json",
          resultsDir: "/tmp/project/results"
        },
        legacyFiles: ["package/manifest.json"],
        canonicalFiles: [],
        legacyBackupPaths: {
          workspaceRoot: "/tmp/project/.legacy-default-canvas"
        },
        projectGraphPath: "/tmp/project/project-graph.json"
      })
    ).toContain("Legacy backup: /tmp/project/.legacy-default-canvas");
    expect(
      formatProjectGraphMaterializeHuman({
        created: true,
        path: "/tmp/project/project-graph.json",
        source: "legacy_default_canvas",
        canvasCount: 1
      })
    ).toBe(
      "Project graph: /tmp/project/project-graph.json\nSource: legacy_default_canvas\nCanvases: 1"
    );
  });
});
