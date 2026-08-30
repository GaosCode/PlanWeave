import { describe, expect, it, vi } from "vitest";
import { remoteAgentEndpointListSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  assertValidatedWorkspaceAuthorityBinding,
  createLocalPackageAuthoritySource,
  createWorkspaceAuthorityBindingResolver
} from "../workspaceExecution/authorityBinding.js";
import {
  workspaceAuthorityBindingSchema,
  workspaceExecutionRequestSchema
} from "../workspaceExecution/contracts.js";
import { WorkspaceExecutionError } from "../workspaceExecution/errors.js";
import { resolveWorkspaceExecutionTarget } from "../workspaceExecution/targetResolution.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const fingerprint = `pkg-${"a".repeat(64)}`;
const revisions = {
  responsibilityRevision: 2,
  reviewerRevision: 3,
  executionTargetRevision: 4
};

function remoteLocator(overrides: Record<string, unknown> = {}) {
  return {
    kind: "workspace_canvas" as const,
    contentAuthority: {
      kind: "package_snapshot" as const,
      packageWorkspace: "/workspace/project",
      expected: { contentRevision: "snapshot:revision-1", graphFingerprint: fingerprint }
    },
    connectionProfileId: "profile-1",
    serverOrigin: "https://planweave.example",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    ...overrides
  };
}

function remoteSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    connectionProfileId: "profile-1",
    serverOrigin: "https://planweave.example",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    contentRevision: "snapshot:revision-1",
    graphFingerprint: fingerprint,
    authorityRevisions: revisions,
    ...overrides
  };
}

describe("workspace execution authority binding", () => {
  it("binds a Server Canvas without accepting a package path or renderer revision", async () => {
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: { inspect: vi.fn() },
      remote: { inspect: vi.fn(async () => remoteSnapshot()) }
    });
    const locator = {
      ...remoteLocator(),
      contentAuthority: { kind: "server_canvas" as const }
    };
    const binding = await resolver.resolve(locator, {
      kind: "block",
      blockRef: "T-001#B-001"
    });

    expect(binding).toMatchObject({
      kind: "remote",
      contentAuthority: { kind: "server_canvas" },
      contentRevision: "snapshot:revision-1",
      graphFingerprint: fingerprint
    });
    expect(binding).not.toHaveProperty("packageWorkspace");
    expect(() =>
      workspaceExecutionRequestSchema.parse({
        authority: {
          ...locator,
          contentAuthority: { kind: "server_canvas", packageWorkspace: "/forged" }
        },
        scope: { kind: "block", blockRef: "T-001#B-001" },
        trigger: "desktop",
        target: { policy: "remote" },
        effectiveExecutor: { name: "codex-acp", agentId: "codex" },
        eventFormat: "execution-v1"
      })
    ).toThrow();
  });

  it("includes the content authority kind in the stable binding identity", async () => {
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: { inspect: vi.fn() },
      remote: { inspect: vi.fn(async () => remoteSnapshot()) }
    });
    const scope = { kind: "block" as const, blockRef: "T-001#B-001" };
    const packageBinding = await resolver.resolve(remoteLocator(), scope);
    const serverBinding = await resolver.resolve(
      { ...remoteLocator(), contentAuthority: { kind: "server_canvas" } },
      scope
    );

    expect(packageBinding.bindingId).not.toBe(serverBinding.bindingId);
  });

  it("creates a stable canonical binding and prevents unvalidated DTOs from entering adapters", async () => {
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: { inspect: vi.fn() },
      remote: { inspect: vi.fn(async () => remoteSnapshot()) }
    });
    const first = await resolver.resolve(remoteLocator(), {
      kind: "block",
      blockRef: "T-001#B-001"
    });
    const second = await resolver.resolve(remoteLocator(), {
      kind: "block",
      blockRef: "T-001#B-001"
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "remote",
      bindingId: "wxb:sha256:828553e4dc55538a607d6b7b7325cb7c44e377916e90857f879828da7339905c",
      connectionProfileId: "profile-1",
      serverOrigin: "https://planweave.example",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-001#B-001",
      authorityRevisions: revisions,
      contentRevision: "snapshot:revision-1",
      graphFingerprint: fingerprint
    });
    expect(() => assertValidatedWorkspaceAuthorityBinding(first)).not.toThrow();

    const forged = workspaceAuthorityBindingSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(() => assertValidatedWorkspaceAuthorityBinding(forged)).toThrowError(
      expect.objectContaining<Partial<WorkspaceExecutionError>>({
        code: "workspace_execution_binding_unvalidated"
      })
    );
  });

  it.each([
    ["connectionProfileId", "profile-2", "workspace_execution_authority_mismatch"],
    ["serverOrigin", "https://other.example", "workspace_execution_authority_mismatch"],
    ["workspaceId", "workspace-2", "workspace_execution_authority_mismatch"],
    ["projectId", "project-2", "workspace_execution_authority_mismatch"],
    ["canvasId", "canvas-2", "workspace_execution_authority_mismatch"],
    ["blockRef", "T-001#B-002", "workspace_execution_authority_mismatch"],
    ["contentRevision", "snapshot:revision-2", "workspace_content_revision_mismatch"],
    ["graphFingerprint", `pkg-${"b".repeat(64)}`, "workspace_graph_fingerprint_mismatch"]
  ])("rejects %s mismatch with a stable code", async (field, value, code) => {
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: { inspect: vi.fn() },
      remote: { inspect: vi.fn(async () => remoteSnapshot({ [field]: value })) }
    });

    await expect(
      resolver.resolve(remoteLocator(), { kind: "block", blockRef: "T-001#B-001" })
    ).rejects.toMatchObject({ code });
  });

  it("derives local content authority from the real Package without changing it", async () => {
    const { root } = await createTestWorkspace();
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const graph = await loadPlanGraphPackage(root);
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: { inspect: vi.fn() }
    });

    const binding = await resolver.resolve(
      {
        kind: "local_package",
        packageWorkspace: root,
        expected: {
          contentRevision: captured.snapshot.sourceRevision,
          graphFingerprint: graph.graph.packageFingerprint
        }
      },
      { kind: "block", blockRef: "T-001#B-001" }
    );

    expect(binding).toMatchObject({
      kind: "local",
      packageWorkspace: root,
      canvasId: "default",
      contentRevision: captured.snapshot.sourceRevision,
      graphFingerprint: graph.graph.packageFingerprint
    });
  });

  it("rejects loose identities, credentials, and non-canonical origins at the request boundary", () => {
    const request = {
      authority: remoteLocator(),
      scope: { kind: "block", blockRef: "T-001#B-001" },
      trigger: "cli",
      target: { policy: "remote" },
      effectiveExecutor: { name: "codex-acp", agentId: "codex" },
      eventFormat: "execution-v1"
    };
    expect(() => workspaceExecutionRequestSchema.parse({ ...request, token: "secret" })).toThrow();
    expect(() =>
      workspaceExecutionRequestSchema.parse({
        ...request,
        authority: { ...remoteLocator(), serverOrigin: "https://planweave.example/path" }
      })
    ).toThrow();
    expect(() =>
      workspaceExecutionRequestSchema.parse({
        ...request,
        workspaceId: "loose-workspace-id"
      })
    ).toThrow();
  });

  it("requires explicit selection when multiple compatible remote endpoints are available", () => {
    const request = workspaceExecutionRequestSchema.parse({
      authority: remoteLocator(),
      scope: { kind: "block", blockRef: "T-001#B-001" },
      trigger: "cli",
      target: { policy: "remote" },
      effectiveExecutor: { name: "codex-acp", agentId: "codex" },
      eventFormat: "execution-v1"
    });
    const catalog = remoteAgentEndpointListSchema.parse({
      schemaVersion: "agent-endpoint-list/v1",
      items: ["endpoint-1", "endpoint-2"].map((endpointId) => ({
        schemaVersion: "agent-endpoint/v1",
        endpointId,
        profileId: "codex-acp",
        agentId: "codex",
        displayName: endpointId,
        hostDisplayName: "Build Host",
        capabilities: ["acp.codex"],
        status: "available"
      }))
    });

    expect(() => resolveWorkspaceExecutionTarget(request, catalog)).toThrowError(
      expect.objectContaining<Partial<WorkspaceExecutionError>>({
        code: "agent_endpoint_selection_required"
      })
    );
    expect(
      resolveWorkspaceExecutionTarget(
        { ...request, target: { policy: "remote", agentEndpointId: "endpoint-2" } },
        catalog
      )
    ).toMatchObject({ target: "remote", agentEndpointId: "endpoint-2" });
  });
});
