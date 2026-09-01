import { vi } from "vitest";
import { remoteAgentEndpointListSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  remoteInteractionPageSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import { createWorkspaceAuthorityBindingResolver } from "../workspaceExecution/authorityBinding.js";
import { WorkspaceExecutionCoordinator } from "../workspaceExecution/coordinator.js";
import { createRemoteWorkspaceExecutionAdapter } from "../workspaceExecution/remoteExecutionAdapter.js";
import { createPackageWorkspaceExecutionSessionRepository } from "../workspaceExecution/sessionRepository.js";
export const fingerprint = `pkg-${"a".repeat(64)}`;
export const revisions = {
  responsibilityRevision: 1,
  reviewerRevision: 2,
  executionTargetRevision: 3
};
export const endpoint = {
  schemaVersion: "agent-endpoint/v1" as const,
  endpointId: "endpoint-codex",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "Build Host",
  capabilities: ["acp.codex"],
  status: "available" as const
};

export function request(packageWorkspace: string) {
  return {
    authority: {
      kind: "workspace_canvas" as const,
      contentAuthority: {
        kind: "package_snapshot" as const,
        packageWorkspace,
        expected: { contentRevision: "snapshot:revision-1", graphFingerprint: fingerprint }
      },
      connectionProfileId: "profile-1",
      serverOrigin: "https://planweave.example",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    },
    scope: { kind: "block" as const, blockRef: "T-001#B-001" },
    trigger: "cli" as const,
    target: { policy: "remote" as const },
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    eventFormat: "execution-v1" as const
  };
}

export function authorityResolver(
  packageWorkspace: string,
  overrides: Record<string, unknown> = {}
) {
  return createWorkspaceAuthorityBindingResolver({
    local: { inspect: vi.fn() },
    remote: {
      inspect: vi.fn(async () => remoteSnapshotForWorkspace(packageWorkspace, overrides))
    }
  });
}

export function remoteSnapshotForWorkspace(
  _packageWorkspace: string,
  overrides: Record<string, unknown> = {}
) {
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

export function workAuthority() {
  const scope = {
    kind: "block" as const,
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001"
  };
  return workAuthorityProjectionSchema.parse({
    schemaVersion: "work-authority/v1",
    scope,
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope,
      principal: null,
      revision: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope,
      principal: null,
      revision: 2,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    executionTarget: {
      schemaVersion: "execution-target/v1",
      scope,
      target: { kind: "exact_host", hostId: "host-1" },
      revision: 3,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: { status: "ready", reason: "ready" }
    },
    revisions,
    selectedHost: null,
    evaluatedAt: "2030-01-01T00:00:00.000Z"
  });
}

export function observation(
  input: {
    state?: RemoteOperationObservation["state"];
    attemptId?: string;
    revision?: number;
    attemptStateVersion?: number;
    attemptStatus?: RemoteOperationObservation["attempt"]["status"];
    projectId?: string;
    locatorWorkspaceId?: string;
    authorityRevisions?: typeof revisions;
    contentRevision?: string;
    graphFingerprint?: string;
  } = {}
) {
  const attemptId = input.attemptId ?? "attempt-1";
  const state = input.state ?? "running";
  return remoteOperationObservationSchema.parse({
    operationId: "operation-1",
    projectId: input.projectId ?? "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    state,
    dispatchId: `dispatch-${attemptId}`,
    executionAttemptId: attemptId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: `2030-01-01T00:00:0${input.revision ?? 1}.000Z`,
    ...(state === "completed" ? { terminalAt: "2030-01-01T00:00:09.000Z" } : {}),
    agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" },
    attempt: {
      executionAttemptId: attemptId,
      dispatchId: `dispatch-${attemptId}`,
      status: input.attemptStatus ?? (state === "completed" ? "completed" : state),
      stateVersion: input.attemptStateVersion ?? input.revision ?? 1
    },
    diagnostics: {
      stage:
        state === "completed"
          ? "terminal"
          : state === "awaiting_writeback"
            ? "writing_back"
            : "running",
      revision: input.revision ?? 1,
      attemptId,
      locator: {
        workspaceId: input.locatorWorkspaceId ?? "workspace-1",
        projectId: input.projectId ?? "project-1",
        canvasId: "default"
      },
      endpointId: "endpoint-codex",
      authorityRevisions: {
        responsibility: input.authorityRevisions?.responsibilityRevision ?? 1,
        reviewer: input.authorityRevisions?.reviewerRevision ?? 2,
        executionTarget: input.authorityRevisions?.executionTargetRevision ?? 3
      },
      content: {
        revision: input.contentRevision ?? "snapshot:revision-1",
        fingerprint: input.graphFingerprint ?? fingerprint
      },
      startedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: `2030-01-01T00:00:0${input.revision ?? 1}.000Z`,
      ...(state === "completed" ? { terminalAt: "2030-01-01T00:00:09.000Z" } : {})
    },
    runtime: {
      ref: "T-001#B-001",
      status: state === "completed" ? "completed" : "in_progress"
    }
  });
}

export function fixture(input: {
  packageWorkspace: string;
  authority?: ReturnType<typeof authorityResolver>;
  workAuthority?: () => Promise<ReturnType<typeof workAuthority> | null>;
  dispatch?: () => Promise<RemoteOperationObservation>;
  recover?: () => Promise<RemoteOperationObservation | null>;
  observe?: () => Promise<RemoteOperationObservation>;
  replay?: (afterCursor: number) => Promise<ReturnType<typeof emptyReplay>>;
  interactions?: (cursor: number) => Promise<ReturnType<typeof emptyInteractions>>;
  sessions?: ConstructorParameters<typeof WorkspaceExecutionCoordinator>[0]["sessions"];
}) {
  const catalog = {
    list: vi.fn(async () =>
      remoteAgentEndpointListSchema.parse({
        schemaVersion: "agent-endpoint-list/v1",
        items: [endpoint]
      })
    )
  };
  const dispatch = vi.fn(input.dispatch ?? (async () => observation()));
  const recover = vi.fn(input.recover ?? (async () => null));
  const observe = vi.fn(
    input.observe ?? (async () => observation({ state: "completed", revision: 2 }))
  );
  const replay = vi.fn(
    async ({ afterCursor }: { afterCursor: number }) =>
      input.replay?.(afterCursor) ?? emptyReplay(afterCursor)
  );
  const interactions = vi.fn(
    async ({ cursor }: { cursor: number }) => input.interactions?.(cursor) ?? emptyInteractions()
  );
  const respond = vi.fn(async ({ response }: { response: unknown }) =>
    remoteInteractionViewSchema.parse({
      request: pendingInteraction().items[0]?.request,
      operationId: "operation-1",
      hostId: "host-1",
      status: "settled",
      createdAt: "2030-01-01T00:00:00.000Z",
      settlement: response,
      settledBy: "human-1",
      settledAt: "2030-01-01T00:01:00.000Z"
    })
  );
  const workAuthorityPort = {
    ensure: vi.fn(input.workAuthority ?? (async () => workAuthority()))
  };
  const remote = createRemoteWorkspaceExecutionAdapter({
    workAuthority: workAuthorityPort,
    command: { dispatch },
    query: { recover, observe, replay, interactions },
    interaction: { respond }
  });
  const coordinator = new WorkspaceExecutionCoordinator({
    authority: input.authority ?? authorityResolver(input.packageWorkspace),
    catalog,
    workAuthority: workAuthorityPort,
    local: { launch: vi.fn() },
    remote,
    sessions: input.sessions,
    clock: () => new Date("2030-01-01T00:10:00.000Z")
  });
  return {
    coordinator,
    catalog: catalog.list,
    workAuthority: workAuthorityPort.ensure,
    dispatch,
    recover,
    observe,
    replay,
    interactions,
    respond
  };
}

export function emptyReplay(afterCursor = 0) {
  return {
    eventProtocolVersion: 2 as const,
    executionAttemptId: "attempt-1",
    afterCursor,
    cursor: afterCursor,
    highWatermark: afterCursor,
    hasMore: false,
    events: []
  };
}

export function emptyInteractions() {
  return remoteInteractionPageSchema.parse({ items: [], nextCursor: null });
}

export function pendingInteraction(attemptId = "attempt-2") {
  return remoteInteractionPageSchema.parse({
    items: [
      {
        request: {
          type: "interaction.permission_requested",
          dispatchId: `dispatch-${attemptId}`,
          leaseId: "lease-1",
          executionAttemptId: attemptId,
          actionId: "action-1",
          acpSessionId: "acp-session-1",
          expiresAt: "2030-01-01T01:00:00.000Z",
          title: "Permission",
          description: "Approve tool use"
        },
        operationId: "operation-1",
        hostId: "host-1",
        status: "pending",
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    nextCursor: null
  });
}

export function sessionPorts(
  overrides: Partial<
    NonNullable<ConstructorParameters<typeof WorkspaceExecutionCoordinator>[0]["sessions"]>
  > = {}
) {
  return {
    ...createPackageWorkspaceExecutionSessionRepository(),
    ...overrides
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
