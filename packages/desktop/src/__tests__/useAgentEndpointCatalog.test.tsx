/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentEndpointCatalog } from "../renderer/hooks/useAgentEndpointCatalog";
import { updateAgentEndpointPreferences } from "../renderer/collaboration/agentEndpointPreferences";
import { resolveDesktopHumanPrincipalId } from "../renderer/collaboration/desktopHumanPrincipal";

const online: RemoteAgentEndpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "endpoint-windows",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "LINANIML",
  status: "available",
  capabilities: ["acp.codex"]
};

const offline: RemoteAgentEndpoint = {
  ...online,
  status: "unavailable",
  unavailableReason: "host_offline"
};

const localCodex = {
  executorName: "codex",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  capabilities: ["acp.codex"],
  available: true,
  unavailableReason: null,
  custom: false
};

describe("resolveDesktopHumanPrincipalId", () => {
  it("uses the active collaboration profile and never operatorId", () => {
    expect(
      resolveDesktopHumanPrincipalId({
        collaborationStatus: {
          activeProfileId: "profile-1",
          profiles: [{ profileId: "profile-1", humanPrincipalId: "human-owner-1" }]
        } as Parameters<typeof resolveDesktopHumanPrincipalId>[0]["collaborationStatus"],
        membershipHumanPrincipalId: "human-member-2"
      })
    ).toBe("human-owner-1");
    expect(
      resolveDesktopHumanPrincipalId({
        collaborationStatus: null,
        membershipHumanPrincipalId: "human-member-2"
      })
    ).toBe("human-member-2");
    expect(resolveDesktopHumanPrincipalId({ collaborationStatus: null })).toBeNull();
  });
});

const catalogLocator = {
  projectId: "project-local",
  canvasId: "canvas-main"
};

const workspaceLocator = {
  projectId: "project-server",
  canvasId: "canvas-main",
  workspaceId: "workspace-1"
};

describe("useAgentEndpointCatalog owner fleet", () => {
  it("C1: loads remote endpoints when operator control plane is enabled without collaboration session", async () => {
    const listOperatorAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [online]
    }));
    const api = { listOperatorAgentEndpoints };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: api,
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).toHaveBeenCalledWith({
      profileId: "operator-profile-1",
      humanPrincipalId: "human-owner-1",
      projectId: "project-local",
      canvasId: "canvas-main"
    });
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ available: true, source: "remote" });
    expect(result.current.errorCode).toBeNull();
  });

  it("C2: returns empty remotes and operator credential message without People CTA when credential is missing", async () => {
    const listOperatorAgentEndpoints = vi.fn();
    const listCollaborationAgentEndpoints = vi.fn();
    const fleetApi = { listOperatorAgentEndpoints };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi,
        collaborationApi: { listCollaborationAgentEndpoints },
        enabled: false,
        sessionConnected: true,
        fleetCatalogBlockedCode: "operator_credential_missing",
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).not.toHaveBeenCalled();
    expect(listCollaborationAgentEndpoints).not.toHaveBeenCalled();
    expect(result.current.endpoints.some((endpoint) => endpoint.source === "remote")).toBe(false);
    expect(result.current.errorCode).toBe("operator_credential_missing");
    expect(result.current.error).toBe("operator_credential_missing");
  });

  it("C3: preference write still persists selected remote endpoint locally", async () => {
    const remoteCatalogEntry = {
      id: "remote:endpoint-windows",
      source: "remote" as const,
      executorName: "codex",
      displayName: "Codex",
      locationName: "LINANIML",
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: "endpoint-windows"
    };
    const next = updateAgentEndpointPreferences({
      current: {},
      key: "project-local:default:task-1",
      endpoint: remoteCatalogEntry
    });
    expect(next["project-local:default:task-1"]).toMatchObject({
      kind: "remote",
      remoteEndpointId: "endpoint-windows"
    });
  });

  it("C4: keeps local logical executors in the merged catalog", async () => {
    const listOperatorAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [online]
    }));
    const fleetApi = { listOperatorAgentEndpoints };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi,
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(result.current.endpoints.find((endpoint) => endpoint.id === "local:codex")).toEqual(
      expect.objectContaining({ source: "local", executorName: "codex" })
    );
  });
});

describe("useAgentEndpointCatalog freshness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes liveness at a low frequency and preserves an unavailable Endpoint id", async () => {
    let current = online;
    const listOperatorAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [current]
    }));
    const api = { listOperatorAgentEndpoints };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: api,
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ available: true, unavailableReason: null });

    current = offline;
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(listOperatorAgentEndpoints).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "host_offline"
    });

    current = online;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ available: true, unavailableReason: null });
  });

  it("keeps last successful remotes when a later refresh fails", async () => {
    const listOperatorAgentEndpoints = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: "agent-endpoint-list/v1" as const,
        items: [online]
      })
      .mockRejectedValueOnce(Object.assign(new Error("http_502"), { code: "http_502" }));
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ source: "remote", available: true });

    await act(async () => {
      await result.current.refresh();
    });
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({
      source: "remote",
      available: false,
      unavailableReason: "agent_endpoint_request_failed"
    });
    expect(result.current.errorCode).toBe("http_502");
  });

  it("retries quickly after an initial empty-fleet load failure", async () => {
    const listOperatorAgentEndpoints = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("http_502"), { code: "http_502" }))
      .mockResolvedValueOnce({
        schemaVersion: "agent-endpoint-list/v1" as const,
        items: [online]
      });
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(result.current.errorCode).toBe("http_502");
    expect(result.current.endpoints.some((endpoint) => endpoint.source === "remote")).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ source: "remote", available: true });
    expect(result.current.errorCode).toBeNull();
  });

  it("does not loop quick retries while the empty fleet remains unavailable", async () => {
    const listOperatorAgentEndpoints = vi.fn().mockRejectedValue(
      Object.assign(new Error("operator_local_server_not_ready"), {
        code: "operator_local_server_not_ready"
      })
    );
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(result.current.errorCode).toBe("operator_local_server_not_ready");

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(listOperatorAgentEndpoints).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(listOperatorAgentEndpoints).toHaveBeenCalledTimes(2);
    expect(result.current.errorCode).toBe("operator_local_server_not_ready");
  });
});

describe("useAgentEndpointCatalog principal and locator", () => {
  it("fails closed with empty remotes when humanPrincipalId is missing", async () => {
    const listOperatorAgentEndpoints = vi.fn();
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: null,
        locator: catalogLocator
      })
    );

    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).not.toHaveBeenCalled();
    expect(result.current.endpoints.some((endpoint) => endpoint.source === "remote")).toBe(false);
    expect(result.current.errorCode).toBe("human_principal_unavailable");
  });

  it("passes workspace locator on the operator catalog request", async () => {
    const listOperatorAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [online]
    }));
    renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        enabled: true,
        logicalExecutors: [localCodex],
        operatorProfileId: "operator-profile-1",
        humanPrincipalId: "human-owner-1",
        locator: workspaceLocator
      })
    );
    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).toHaveBeenCalledWith({
      profileId: "operator-profile-1",
      humanPrincipalId: "human-owner-1",
      projectId: "project-server",
      canvasId: "canvas-main",
      workspaceId: "workspace-1"
    });
  });

  it("uses the collaboration catalog when operator is unavailable but the session is connected", async () => {
    const listOperatorAgentEndpoints = vi.fn();
    const listCollaborationAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [online]
    }));
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        fleetApi: { listOperatorAgentEndpoints },
        collaborationApi: { listCollaborationAgentEndpoints },
        enabled: false,
        sessionConnected: true,
        logicalExecutors: [localCodex],
        operatorProfileId: null,
        humanPrincipalId: "human-member-1",
        locator: workspaceLocator
      })
    );
    await act(async () => undefined);
    expect(listOperatorAgentEndpoints).not.toHaveBeenCalled();
    expect(listCollaborationAgentEndpoints).toHaveBeenCalledWith({
      projectId: "project-server",
      canvasId: "canvas-main",
      workspaceId: "workspace-1",
      humanPrincipalId: "human-member-1"
    });
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ source: "remote", available: true });
  });
});
