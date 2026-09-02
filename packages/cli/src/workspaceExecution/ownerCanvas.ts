import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { dispatchIdSchema, executionAttemptIdSchema } from "@planweave-ai/agent-host-protocol";
import {
  RemoteOwnershipConflictError,
  WorkspaceExecutionCoordinator,
  captureAuthorizedCanvasContent,
  createLocalPackageAuthoritySource,
  createLocalWorkspaceExecutionAdapter,
  createRemoteBlockRuntimePort,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  isOwnerCanvasRemoteAuthorityBinding,
  loadPlanGraphPackage,
  packageSnapshotSourceRevision,
  resolveTaskCanvasWorkspace,
  type LocalWorkspaceAuthoritySourcePort,
  type OwnerCanvasRemoteAuthorityBinding,
  type PackageWorkspaceRef,
  type RemoteWorkspaceAuthorityBinding,
  type RemoteBlockRuntimePort,
  type ValidatedWorkspaceAuthorityBinding,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionScope
} from "@planweave-ai/runtime";
import { resolveCliCanvasId, type CanvasCommandOptions } from "../cliWorkspace.js";
import { WorkspaceExecutionCliError } from "./errors.js";
import { createWorkspaceJsonTransport } from "./httpTransport.js";
import {
  CliOwnerConnectionProvider,
  ProcessMemoryOwnerCredentialProvider,
  type CliOwnerConnection,
  type CliOwnerCredentials
} from "./ownerConnection.js";
import {
  createCliOwnerCanvasExecutionHttpPorts,
  ownerCanvasMaterializationIntentId,
  type OwnerTerminalResult
} from "./ownerHttpPorts.js";

export type OwnerCanvasCoordinatorContext = {
  coordinator: WorkspaceExecutionCoordinator;
  request: WorkspaceExecutionRequest;
  binding: ValidatedWorkspaceAuthorityBinding;
  ports: ReturnType<typeof createCliOwnerCanvasExecutionHttpPorts>;
  localRuntime: RemoteBlockRuntimePort;
};

function workspacePath(workspace: PackageWorkspaceRef): string {
  return typeof workspace === "string" ? workspace : workspace.packageDir;
}

function ownerTransport(connection: CliOwnerConnection, credentials: CliOwnerCredentials) {
  return createWorkspaceJsonTransport({
    serverOrigin: connection.serverOrigin,
    credential: credentials.operatorToken,
    identityCredential: credentials.humanIdentityToken
  });
}

function ownerAuthorityResolver(localAuthority: LocalWorkspaceAuthoritySourcePort) {
  return createWorkspaceAuthorityBindingResolver({
    local: localAuthority,
    remote: {
      async inspect() {
        throw new WorkspaceExecutionCliError("owner_connection_required", 3);
      }
    }
  });
}

function assembleOwnerCoordinator(input: {
  projectRoot: PackageWorkspaceRef;
  localAuthority: LocalWorkspaceAuthoritySourcePort;
  ports: ReturnType<typeof createCliOwnerCanvasExecutionHttpPorts>;
}): WorkspaceExecutionCoordinator {
  const authority = ownerAuthorityResolver(input.localAuthority);
  return new WorkspaceExecutionCoordinator({
    authority,
    catalog: input.ports.catalog,
    workAuthority: input.ports.workAuthority,
    local: createLocalWorkspaceExecutionAdapter(),
    remote: createRemoteWorkspaceExecutionAdapter({
      workAuthority: input.ports.workAuthority,
      command: input.ports.command,
      query: input.ports.query,
      interaction: input.ports.interaction
    }),
    sessionStorage: () => ({ kind: "package", packageWorkspace: input.projectRoot })
  });
}

async function ownerCanvasIds(
  projectRoot: PackageWorkspaceRef,
  options: CanvasCommandOptions
): Promise<{ canvasId: string; projectId: string; workspace: PackageWorkspaceRef }> {
  const canvasId = resolveCliCanvasId(options) ?? "default";
  const workspace =
    typeof projectRoot === "string"
      ? await resolveTaskCanvasWorkspace(projectRoot, canvasId)
      : projectRoot;
  const loaded = await loadPlanGraphPackage(workspace);
  return { canvasId, projectId: loaded.workspace.id, workspace };
}

async function materializeOwnerExpected(input: {
  workspace: PackageWorkspaceRef;
  projectId: string;
  canvasId: string;
  ports: ReturnType<typeof createCliOwnerCanvasExecutionHttpPorts>;
  credentials: CliOwnerCredentials;
  signal?: AbortSignal;
}): Promise<{ contentRevision: string; graphFingerprint: string }> {
  const [captured, loaded] = await Promise.all([
    captureAuthorizedCanvasContent({
      projectRoot: input.workspace,
      authorityProjectId: input.projectId
    }),
    loadPlanGraphPackage(input.workspace)
  ]);
  const localExpected = {
    contentRevision: packageSnapshotSourceRevision(captured.digestManifest),
    graphFingerprint: loaded.graph.packageFingerprint
  };
  const materializationScope = {
    ownerHumanPrincipalId: humanPrincipalIdSchema.parse(input.credentials.humanPrincipalId),
    projectId: input.projectId,
    canvasId: input.canvasId
  } as const;
  const current = await input.ports.inspectMaterializationHead(materializationScope, input.signal);
  const currentContentMatches =
    current.head.kind === "present" &&
    current.head.content.canonicalDigest === captured.content.canonicalDigest;
  const expected = currentContentMatches
    ? localExpected
    : await input.ports
        .materialize(
          {
            schemaVersion: "owner-canvas-materialization/v1",
            materializationId: ownerCanvasMaterializationIntentId(
              captured.content.canonicalDigest,
              current.head
            ),
            scope: materializationScope,
            expectedHead: current.head,
            content: captured.content
          },
          input.signal
        )
        .then((materialized) => ({
          contentRevision: materialized.contentRevision,
          graphFingerprint: materialized.graphFingerprint
        }));
  if (
    expected.contentRevision !== localExpected.contentRevision ||
    expected.graphFingerprint !== localExpected.graphFingerprint
  ) {
    throw new WorkspaceExecutionCliError("owner_canvas_materialization_authority_mismatch", 5);
  }
  return expected;
}

export async function createOwnerCanvasRunContext(input: {
  projectRoot: PackageWorkspaceRef;
  options: CanvasCommandOptions & { connectionProfile?: string };
  scope: WorkspaceExecutionScope;
  target: WorkspaceExecutionRequest["target"];
  identity: { name: string; agentId: string };
  executorOverride?: string;
  eventFormat: "legacy" | "execution-v1";
  signal?: AbortSignal;
}): Promise<OwnerCanvasCoordinatorContext> {
  if (input.scope.kind !== "block" || !input.identity.agentId) {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  const credentials = new ProcessMemoryOwnerCredentialProvider().get();
  const connection = await new CliOwnerConnectionProvider().resolve(
    input.options.connectionProfile
  );
  const { canvasId, projectId, workspace } = await ownerCanvasIds(input.projectRoot, input.options);
  const packageWorkspace = workspacePath(input.projectRoot);
  const ports = createCliOwnerCanvasExecutionHttpPorts({
    transport: ownerTransport(connection, credentials),
    credentials
  });
  const expected = await materializeOwnerExpected({
    workspace,
    projectId,
    canvasId,
    ports,
    credentials,
    signal: input.signal
  });
  const request = {
    authority: {
      kind: "owner_canvas",
      packageWorkspace,
      expected,
      connectionProfileId: connection.profileId,
      serverOrigin: connection.serverOrigin,
      humanPrincipalId: credentials.humanPrincipalId,
      projectId,
      canvasId
    },
    scope: input.scope,
    trigger: "cli",
    target: input.target,
    ...(input.executorOverride ? { executorOverride: input.executorOverride } : {}),
    effectiveExecutor: { name: input.identity.name, agentId: input.identity.agentId },
    eventFormat: input.eventFormat
  } satisfies WorkspaceExecutionRequest;
  const localAuthority = createLocalPackageAuthoritySource();
  return {
    coordinator: assembleOwnerCoordinator({
      projectRoot: input.projectRoot,
      localAuthority,
      ports
    }),
    request,
    binding: await ownerAuthorityResolver(localAuthority).resolve(request.authority, request.scope),
    ports,
    localRuntime: createRemoteBlockRuntimePort({ projectRoot: workspace })
  };
}

export async function createOwnerCanvasResumeContext(input: {
  projectRoot: PackageWorkspaceRef;
  binding: OwnerCanvasRemoteAuthorityBinding;
  agentEndpointId: string;
  effectiveExecutor: { name: string; agentId: string };
  connectionProfile?: string;
}): Promise<OwnerCanvasCoordinatorContext> {
  const credentials = new ProcessMemoryOwnerCredentialProvider().get();
  const connection = await new CliOwnerConnectionProvider().resolve(
    input.connectionProfile ?? input.binding.connectionProfileId
  );
  if (
    connection.profileId !== input.binding.connectionProfileId ||
    connection.serverOrigin !== input.binding.serverOrigin ||
    credentials.humanPrincipalId !== input.binding.humanPrincipalId
  ) {
    throw new WorkspaceExecutionCliError("owner_connection_invalid", 3);
  }
  if (input.binding.contentAuthority.kind !== "package_snapshot") {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  const ports = createCliOwnerCanvasExecutionHttpPorts({
    transport: ownerTransport(connection, credentials),
    credentials
  });
  const localAuthority = {
    async inspect() {
      return {
        packageWorkspace: input.binding.contentAuthority.packageWorkspace,
        projectId: input.binding.projectId,
        canvasId: input.binding.canvasId,
        contentRevision: input.binding.contentRevision,
        graphFingerprint: input.binding.graphFingerprint
      };
    }
  };
  const request = {
    authority: {
      kind: "owner_canvas",
      packageWorkspace: input.binding.contentAuthority.packageWorkspace,
      expected: input.binding.contentAuthority.expected,
      connectionProfileId: input.binding.connectionProfileId,
      serverOrigin: input.binding.serverOrigin,
      humanPrincipalId: input.binding.humanPrincipalId,
      projectId: input.binding.projectId,
      canvasId: input.binding.canvasId
    },
    scope: { kind: "block" as const, blockRef: input.binding.blockRef },
    trigger: "cli",
    target: { policy: "remote" as const, agentEndpointId: input.agentEndpointId },
    effectiveExecutor: input.effectiveExecutor,
    eventFormat: "execution-v1" as const
  } satisfies WorkspaceExecutionRequest;
  const workspace =
    typeof input.projectRoot === "string"
      ? await resolveTaskCanvasWorkspace(input.projectRoot, input.binding.canvasId)
      : input.projectRoot;
  return {
    coordinator: assembleOwnerCoordinator({
      projectRoot: input.projectRoot,
      localAuthority,
      ports
    }),
    request,
    binding: await ownerAuthorityResolver(localAuthority).resolve(request.authority, request.scope),
    ports,
    localRuntime: createRemoteBlockRuntimePort({ projectRoot: workspace })
  };
}

export async function writeBackOwnerCanvasCliExecution(input: {
  request: WorkspaceExecutionRequest;
  sessionPhase: string;
  sessionError: string | null;
  handle: {
    target: string;
    operationId?: string;
    dispatchId?: string | null;
    executionAttemptId?: string | null;
  };
  runtime: RemoteBlockRuntimePort;
  readTerminalResult(operationId: string): Promise<OwnerTerminalResult>;
}): Promise<void> {
  if (
    input.request.authority.kind !== "owner_canvas" ||
    input.request.scope.kind !== "block" ||
    input.handle.target !== "remote" ||
    !input.handle.operationId
  ) {
    return;
  }
  if (!input.handle.executionAttemptId) return;
  const ref = input.request.scope.blockRef;
  const source = input.request.authority.expected;
  try {
    const existing = await input.runtime.query({ ref, operationId: input.handle.operationId });
    if (existing.terminalReceipt) return;
  } catch (error) {
    if (
      !(error instanceof RemoteOwnershipConflictError) ||
      error.code !== "remote_ownership_not_active"
    ) {
      throw error;
    }
    await input.runtime.claim({
      ref,
      operationId: input.handle.operationId,
      controlPlane: "owner",
      sourceRevision: source.contentRevision,
      graphFingerprint: source.graphFingerprint
    });
  }
  const identity = {
    ref,
    operationId: input.handle.operationId,
    controlPlane: "owner" as const,
    sourceRevision: source.contentRevision,
    graphFingerprint: source.graphFingerprint,
    dispatchId: dispatchIdSchema.parse(input.handle.dispatchId),
    executionAttemptId: executionAttemptIdSchema.parse(input.handle.executionAttemptId)
  };
  await input.runtime.activate(identity);
  if (input.sessionPhase === "completed") {
    const result = await input.readTerminalResult(input.handle.operationId);
    const metadata = result.metadata;
    if (
      metadata.operationId !== input.handle.operationId ||
      metadata.projectId !== input.request.authority.projectId ||
      metadata.canvasId !== input.request.authority.canvasId ||
      metadata.blockRef !== ref ||
      metadata.sourceRevision !== source.contentRevision ||
      metadata.graphFingerprint !== source.graphFingerprint ||
      metadata.dispatchId !== input.handle.dispatchId ||
      metadata.executionAttemptId !== input.handle.executionAttemptId
    ) {
      throw new WorkspaceExecutionCliError(
        "owner_canvas_terminal_result_identity_mismatch",
        5,
        false,
        undefined,
        "conflict"
      );
    }
    await input.runtime.complete({
      ...identity,
      reportArtifactRef: metadata.reportArtifactRef,
      reportBytes: new Uint8Array(result.reportBytes)
    });
    return;
  }
  if (input.sessionPhase === "failed" || input.sessionPhase === "stopped") {
    await input.runtime.fail({
      ...identity,
      failure: {
        code: input.sessionPhase === "stopped" ? "execution_cancelled" : "remote_execution_failed",
        message:
          input.sessionError ??
          (input.sessionPhase === "stopped"
            ? "Remote operation was cancelled."
            : "Remote operation failed."),
        retryable: input.sessionPhase === "stopped"
      },
      ...(input.request.effectiveExecutor?.agentId
        ? { agentId: input.request.effectiveExecutor.agentId }
        : {})
    });
  }
}

export function isOwnerCanvasBinding(
  binding: unknown
): binding is OwnerCanvasRemoteAuthorityBinding {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "kind" in binding &&
    (binding as { kind?: unknown }).kind === "remote" &&
    isOwnerCanvasRemoteAuthorityBinding(binding as RemoteWorkspaceAuthorityBinding)
  );
}
