import {
  WorkspaceExecutionCoordinator,
  createLocalPackageAuthoritySource,
  createLocalWorkspaceExecutionAdapter,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  getExecutionStatus,
  getRunSession,
  resolveExecutorRunnerEvidence,
  type PackageWorkspaceRef,
  type WorkspaceExecutionCoordinatorResult,
  type WorkspaceExecutionRequest
} from "@planweave-ai/runtime";
import type { RemoteInteractionResponse } from "@planweave-ai/collaboration-protocol/remote-run";
import { remoteWorkspaceExecutionHandleSchema } from "@planweave-ai/runtime";
import {
  CliWorkspaceConnectionProvider,
  ProcessMemoryWorkspaceCredentialProvider
} from "./connection.js";
import { WorkspaceExecutionCliError } from "./errors.js";
import { createCliWorkspaceExecutionHttpPorts } from "./httpPorts.js";
import { createWorkspaceJsonTransport } from "./httpTransport.js";

function workspacePath(workspace: PackageWorkspaceRef): string {
  return typeof workspace === "string" ? workspace : workspace.packageDir;
}

export async function createRemoteSessionContext(input: {
  projectRoot: PackageWorkspaceRef;
  sessionId: string;
  connectionProfile?: string;
}) {
  const detail = await getRunSession(input.projectRoot, input.sessionId);
  const storedBinding = detail.session.workspaceExecution?.binding;
  const parsedHandle = remoteWorkspaceExecutionHandleSchema.safeParse(
    detail.session.workspaceExecution?.handle
  );
  const dispatchIntent = detail.session.workspaceExecution?.dispatchIntent;
  if (!storedBinding || storedBinding.kind !== "remote") {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  let agentEndpointId: string;
  if (parsedHandle.success) {
    agentEndpointId = parsedHandle.data.agentEndpointId;
  } else {
    if (!dispatchIntent) {
      throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
    }
    agentEndpointId = dispatchIntent.agentEndpointId;
  }
  const connection = await new CliWorkspaceConnectionProvider().resolve(
    input.connectionProfile ?? storedBinding.connectionProfileId
  );
  if (
    connection.profileId !== storedBinding.connectionProfileId ||
    connection.serverOrigin !== storedBinding.serverOrigin ||
    connection.workspaceId !== storedBinding.workspaceId ||
    connection.projectId !== storedBinding.projectId
  ) {
    throw new WorkspaceExecutionCliError("workspace_connection_invalid", 3);
  }
  const credential = new ProcessMemoryWorkspaceCredentialProvider().get();
  const ports = createCliWorkspaceExecutionHttpPorts({
    connection,
    packageWorkspace: workspacePath(input.projectRoot),
    transport: createWorkspaceJsonTransport({
      serverOrigin: connection.serverOrigin,
      credential
    })
  });
  const authority = createWorkspaceAuthorityBindingResolver({
    local: createLocalPackageAuthoritySource(),
    remote: ports.authoritySource
  });
  const scope = { kind: "block" as const, blockRef: storedBinding.blockRef };
  const status = await getExecutionStatus({ projectRoot: input.projectRoot });
  const effectiveExecutor = status.blocks.find(
    (block) => block.ref === scope.blockRef
  )?.effectiveExecutor;
  if (!effectiveExecutor)
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  const evidence = await resolveExecutorRunnerEvidence({
    projectRoot: input.projectRoot,
    executorName: effectiveExecutor
  });
  if (!evidence.agentId)
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  const request: WorkspaceExecutionRequest = {
    authority: {
      kind: "workspace_canvas",
      packageWorkspace: storedBinding.packageWorkspace,
      connectionProfileId: storedBinding.connectionProfileId,
      serverOrigin: storedBinding.serverOrigin,
      workspaceId: storedBinding.workspaceId,
      projectId: storedBinding.projectId,
      canvasId: storedBinding.canvasId,
      expected: {
        contentRevision: storedBinding.contentRevision,
        graphFingerprint: storedBinding.graphFingerprint
      }
    },
    scope,
    trigger: "cli",
    target: {
      policy: "remote",
      agentEndpointId
    },
    effectiveExecutor: { name: effectiveExecutor, agentId: evidence.agentId },
    eventFormat: "execution-v1"
  };
  const binding = await authority.resolve(request.authority, request.scope);
  const coordinator = new WorkspaceExecutionCoordinator({
    authority,
    catalog: ports.catalog,
    workAuthority: ports.workAuthority,
    local: createLocalWorkspaceExecutionAdapter(),
    remote: createRemoteWorkspaceExecutionAdapter({
      workAuthority: ports.workAuthority,
      command: ports.command,
      query: ports.query,
      interaction: ports.interaction
    })
  });
  return {
    coordinator,
    request,
    binding,
    ports,
    handle: parsedHandle.success ? parsedHandle.data : null,
    detail
  };
}

function remoteSessionSettled(result: WorkspaceExecutionCoordinatorResult): boolean {
  return (
    ["completed", "failed", "stopped"].includes(result.session.phase) ||
    result.events.some((event) => event.type === "action_required")
  );
}

async function waitForRemoteReplay(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onTimeout = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onTimeout, 500);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function followRemoteSession(input: {
  projectRoot: PackageWorkspaceRef;
  sessionId: string;
  connectionProfile?: string;
  signal?: AbortSignal;
  onResult(result: WorkspaceExecutionCoordinatorResult): void;
}): Promise<WorkspaceExecutionCoordinatorResult> {
  const context = await createRemoteSessionContext(input);
  for (;;) {
    const result = await context.coordinator.follow(context.request, input.sessionId, input.signal);
    input.onResult(result);
    if (remoteSessionSettled(result)) return result;
    await waitForRemoteReplay(input.signal);
  }
}

export async function listRemoteSessionInteractions(input: {
  projectRoot: PackageWorkspaceRef;
  sessionId: string;
  connectionProfile?: string;
}) {
  const context = await createRemoteSessionContext(input);
  const binding = context.binding;
  if (binding.kind !== "remote") {
    throw new WorkspaceExecutionCliError("workspace_connection_invalid", 3);
  }
  if (!context.handle) {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  const items = [];
  let cursor = 0;
  for (;;) {
    const page = await context.ports.query.interactions({
      binding,
      operationId: context.handle.operationId,
      cursor
    });
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

export function interactionResponse(input: {
  request: Awaited<ReturnType<typeof listRemoteSessionInteractions>>[number]["request"];
  option?: string;
  cancel?: boolean;
}): RemoteInteractionResponse {
  const identity = {
    dispatchId: input.request.dispatchId,
    leaseId: input.request.leaseId,
    executionAttemptId: input.request.executionAttemptId,
    acpSessionId: input.request.acpSessionId,
    actionId: input.request.actionId
  };
  if (input.request.type === "interaction.permission_requested") {
    const decision = input.cancel ? "deny" : input.option;
    if (decision !== "allow_once" && decision !== "deny") {
      throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
    }
    return { ...identity, type: "interaction.permission_response", decision };
  }
  if (input.request.type === "interaction.elicitation_requested") {
    return input.cancel
      ? { ...identity, type: "interaction.elicitation_response", outcome: "cancelled" }
      : {
          ...identity,
          type: "interaction.elicitation_response",
          outcome: "accepted",
          response: input.option ?? ""
        };
  }
  return {
    ...identity,
    type: "interaction.authentication_action",
    action: input.cancel ? "cancel" : "retry_after_host_login"
  };
}
