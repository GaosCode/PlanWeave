import { describe, expect, it } from "vitest";
import {
  agentEndpointPreferenceKey,
  agentEndpointSelectionId,
  clearAgentEndpointPreference,
  remoteAgentEndpointPreferenceKey,
  selectedAgentEndpointId,
  updateAgentEndpointPreferences
} from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import {
  desktopAgentEndpointPreferenceSchema,
  normalizeDesktopSettings
} from "../shared/desktopSettings";

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

const remoteUnavailable: AvailableAgentEndpoint = {
  ...remoteGrok,
  id: "remote:endpoint-down",
  remoteEndpointId: "endpoint-down",
  available: false,
  unavailableReason: "host_offline"
};

describe("desktopAgentEndpointPreferenceSchema", () => {
  it("keys remote preferences by logical canvas identity without a filesystem path", () => {
    expect(
      remoteAgentEndpointPreferenceKey({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        scope: { kind: "task", taskId: "T-001" }
      })
    ).toBe('["remote","workspace-1","project-1","canvas-1","task","T-001"]');
  });

  it("migrates legacy {executorName, remoteEndpointId} to remote preference", () => {
    const parsed = desktopAgentEndpointPreferenceSchema.parse({
      executorName: "grok",
      remoteEndpointId: "endpoint-windows"
    });
    expect(parsed).toEqual({
      kind: "remote",
      remoteEndpointId: "endpoint-windows"
    });
  });

  it("round-trips explicit local preference", () => {
    const value = { kind: "local" as const, executorName: "codex" };
    expect(desktopAgentEndpointPreferenceSchema.parse(value)).toEqual(value);
  });

  it("round-trips remote preference without executorName snapshot", () => {
    const value = { kind: "remote" as const, remoteEndpointId: "endpoint-grok" };
    expect(desktopAgentEndpointPreferenceSchema.parse(value)).toEqual(value);
  });

  it("normalizes legacy preferences through desktop settings boundary", () => {
    const key = agentEndpointPreferenceKey({
      projectRoot: "/workspace/project",
      canvasId: "default",
      scope: { kind: "task", taskId: "T-001" }
    });
    const settings = normalizeDesktopSettings({
      execution: {
        agentEndpointPreferences: {
          [key]: { executorName: "codex", remoteEndpointId: "endpoint-windows" }
        }
      }
    });
    expect(settings.execution.agentEndpointPreferences[key]).toEqual({
      kind: "remote",
      remoteEndpointId: "endpoint-windows"
    });
  });
});

describe("selectedAgentEndpointId", () => {
  it("returns default_local when no preference was ever saved", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "codex",
        preference: undefined,
        endpoints: [localCodex, remoteGrok]
      })
    ).toEqual({ kind: "default_local", id: "local:codex" });
  });

  it("returns endpoint for a valid remote preference that matches manifest executor", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "grok",
        preference: { kind: "remote", remoteEndpointId: "endpoint-grok" },
        endpoints: [localCodex, remoteGrok]
      })
    ).toEqual({ kind: "endpoint", id: "remote:endpoint-grok" });
  });

  it("returns endpoint for an explicit local preference that matches manifest executor", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "codex",
        preference: { kind: "local", executorName: "codex" },
        endpoints: [localCodex, remoteGrok]
      })
    ).toEqual({ kind: "endpoint", id: "local:codex" });
  });

  it("returns mismatch (never local:) when remote preference disagrees with live manifest executor", () => {
    const selection = selectedAgentEndpointId({
      executorName: "codex",
      preference: { kind: "remote", remoteEndpointId: "endpoint-grok" },
      endpoints: [localCodex, remoteGrok]
    });
    expect(selection).toEqual({
      kind: "mismatch",
      detail: "grok->codex"
    });
    expect(agentEndpointSelectionId(selection).startsWith("local:")).toBe(false);
  });

  it("returns mismatch when explicit local preference disagrees with manifest executor", () => {
    const selection = selectedAgentEndpointId({
      executorName: "grok",
      preference: { kind: "local", executorName: "codex" },
      endpoints: [localCodex, remoteGrok]
    });
    expect(selection).toEqual({
      kind: "mismatch",
      detail: "codex->grok"
    });
    expect(agentEndpointSelectionId(selection).startsWith("local:")).toBe(false);
  });

  it("returns mismatch for a vanished remote endpoint (unavailable hard failure path)", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "grok",
        preference: { kind: "remote", remoteEndpointId: "endpoint-gone" },
        endpoints: [localCodex, remoteGrok]
      })
    ).toEqual({
      kind: "mismatch",
      detail: "agent_endpoint_unknown:endpoint-gone"
    });
  });

  it("keeps a matched remote endpoint id even when the endpoint is currently unavailable", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "grok",
        preference: { kind: "remote", remoteEndpointId: "endpoint-down" },
        endpoints: [localCodex, remoteUnavailable]
      })
    ).toEqual({ kind: "endpoint", id: "remote:endpoint-down" });
  });
});

describe("updateAgentEndpointPreferences", () => {
  const key = agentEndpointPreferenceKey({
    projectRoot: "/workspace/project",
    canvasId: "default",
    scope: { kind: "block", blockRef: "T-001#B-001" }
  });

  it("stores remote preference without executorName snapshot", () => {
    const preferences = updateAgentEndpointPreferences({
      current: {},
      key,
      endpoint: remoteGrok
    });
    expect(preferences[key]).toEqual({
      kind: "remote",
      remoteEndpointId: "endpoint-grok"
    });
  });

  it("stores explicit local preference instead of deleting the key", () => {
    const preferences = updateAgentEndpointPreferences({
      current: { [key]: { kind: "remote", remoteEndpointId: "endpoint-grok" } },
      key,
      endpoint: localCodex
    });
    expect(preferences[key]).toEqual({
      kind: "local",
      executorName: "codex"
    });
  });

  it("still clears a preference when inheritance is requested", () => {
    expect(
      clearAgentEndpointPreference(
        { [key]: { kind: "remote", remoteEndpointId: "endpoint-grok" } },
        key
      )
    ).toEqual({});
  });
});
