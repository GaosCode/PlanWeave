import { describe, expect, it } from "vitest";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import {
  agentEndpointPreferenceKey,
  remoteAgentEndpointPreferenceKey
} from "../renderer/collaboration/agentEndpointPreferences";
import { createAgentEndpointRunPlan } from "../renderer/collaboration/agentEndpointRunPlan";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";

const project: DesktopProjectSummary = {
  projectId: "project-local",
  name: "Project",
  kind: "external",
  rootPath: "/workspace/project",
  sourceRoot: "/workspace/project",
  workspaceRoot: "/workspace/project/.planweave",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

const localCodex: AvailableAgentEndpoint = {
  id: "local:codex",
  source: "local",
  executorName: "codex",
  displayName: "Codex",
  locationName: "",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.codex"],
  localExecutorName: "codex"
};

const remoteGrok: AvailableAgentEndpoint = {
  id: "remote:endpoint-grok",
  source: "remote",
  executorName: "grok",
  displayName: "Grok",
  locationName: "LINANIML",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.grok"],
  remoteEndpointId: "endpoint-grok"
};

const remoteOffline: AvailableAgentEndpoint = {
  ...remoteGrok,
  available: false,
  unavailableReason: "host_offline"
};

function graphWithExecutor(executorLabel: string): DesktopGraphViewModel {
  return {
    projectId: "project-local",
    projectTitle: "Project",
    graphVersion: "graph-v1",
    packageFingerprint: "package-v1",
    executorOptions: [executorLabel],
    autoRunPreflightExecutorHint: executorLabel,
    tasks: [
      {
        taskId: "T-001",
        title: "Task",
        status: "ready",
        executor: executorLabel,
        executorLabel,
        promptMarkdown: "# Task",
        promptMissing: false,
        promptPreview: "Task",
        sharedResources: [],
        blocks: [
          {
            ref: "T-001#B-001",
            blockId: "B-001",
            type: "implementation",
            title: "Block",
            status: "ready",
            executor: null,
            requiredCapabilities: [],
            promptMissing: false,
            exceptionReason: null,
            dispatchable: true,
            remoteExecution: null
          }
        ],
        blockPreview: [],
        hiddenBlockRefs: [],
        overflowBlockCount: 0,
        exceptions: []
      }
    ],
    edges: [],
    sharedResourceGroups: [],
    diagnostics: [],
    dirtyPromptRefs: []
  };
}

describe("createAgentEndpointRunPlan preference routing", () => {
  const taskKey = agentEndpointPreferenceKey({
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "task", taskId: "T-001" }
  });

  it("routes a remote canvas Block without a local project path", () => {
    const remoteCanvas = {
      workspaceId: "workspace-1",
      projectId: "project-server",
      canvasId: "canvas-main"
    };
    const remoteKey = remoteAgentEndpointPreferenceKey({
      ...remoteCanvas,
      scope: { kind: "task", taskId: "T-001" }
    });

    expect(
      createAgentEndpointRunPlan({
        graph: graphWithExecutor("grok"),
        scope: { kind: "block", blockRef: "T-001#B-001" },
        endpoints: [localCodex, remoteGrok],
        preferences: {
          [remoteKey]: { kind: "remote", remoteEndpointId: "endpoint-grok" }
        },
        project: null,
        remoteCanvas,
        canvasId: "canvas-main"
      })
    ).toMatchObject({ kind: "coordinated_block" });
  });

  it("rejects mismatch with blockRef, endpoint agent, and manifest executor", () => {
    const plan = createAgentEndpointRunPlan({
      graph: graphWithExecutor("codex"),
      scope: { kind: "task", taskId: "T-001" },
      endpoints: [localCodex, remoteGrok],
      preferences: {
        [taskKey]: { kind: "remote", remoteEndpointId: "endpoint-grok" }
      },
      project,
      canvasId: "canvas-main"
    });

    expect(plan).toEqual({
      kind: "rejected",
      reason: "agent_endpoint_preference_mismatch:T-001#B-001:grok->codex"
    });
  });

  it("rejects unavailable endpoint with blockRef, display source, and reason code", () => {
    const plan = createAgentEndpointRunPlan({
      graph: graphWithExecutor("grok"),
      scope: { kind: "task", taskId: "T-001" },
      endpoints: [localCodex, remoteOffline],
      preferences: {
        [taskKey]: { kind: "remote", remoteEndpointId: "endpoint-grok" }
      },
      project,
      canvasId: "canvas-main"
    });

    expect(plan).toEqual({
      kind: "rejected",
      reason: "agent_endpoint_unavailable:T-001#B-001:Grok:host_offline"
    });
  });

  it("rejects vanished remote preference with structured unknown reason", () => {
    const plan = createAgentEndpointRunPlan({
      graph: graphWithExecutor("grok"),
      scope: { kind: "task", taskId: "T-001" },
      endpoints: [localCodex],
      preferences: {
        [taskKey]: { kind: "remote", remoteEndpointId: "endpoint-gone" }
      },
      project,
      canvasId: "canvas-main"
    });

    expect(plan).toEqual({
      kind: "rejected",
      reason: "agent_endpoint_unknown:T-001#B-001:remote:endpoint-gone:agent_endpoint_unknown"
    });
  });

  it("keeps default_local as local_scope when preference was never set", () => {
    const plan = createAgentEndpointRunPlan({
      graph: graphWithExecutor("codex"),
      scope: { kind: "task", taskId: "T-001" },
      endpoints: [localCodex, remoteGrok],
      preferences: {},
      project,
      canvasId: "canvas-main"
    });

    expect(plan).toEqual({
      kind: "local_scope",
      scope: { kind: "task", taskId: "T-001" }
    });
  });

  it("routes an aligned remote preference to coordinated_scope", () => {
    const plan = createAgentEndpointRunPlan({
      graph: graphWithExecutor("grok"),
      scope: { kind: "task", taskId: "T-001" },
      endpoints: [localCodex, remoteGrok],
      preferences: {
        [taskKey]: { kind: "remote", remoteEndpointId: "endpoint-grok" }
      },
      project,
      canvasId: "canvas-main"
    });

    expect(plan.kind).toBe("coordinated_scope");
    if (plan.kind !== "coordinated_scope") return;
    expect(plan.selectionByBlockRef.get("T-001#B-001")?.endpoint.id).toBe("remote:endpoint-grok");
  });
});
