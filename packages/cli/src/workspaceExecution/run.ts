import {
  WorkspaceExecutionCoordinator,
  capturePackageSnapshot,
  createLocalPackageAuthoritySource,
  createLocalWorkspaceExecutionAdapter,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  getExecutionStatus,
  loadPlanGraphPackage,
  resolveExecutorRunnerEvidence,
  testExecutorProfile,
  workspaceExecutionEventSchema,
  type PackageWorkspaceRef,
  type WorkspaceExecutionCoordinatorResult,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionScope
} from "@planweave-ai/runtime";
import type { CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliCanvasId, resolveCliPackageWorkspace } from "../cliWorkspace.js";
import {
  CliWorkspaceConnectionProvider,
  ProcessMemoryWorkspaceCredentialProvider
} from "./connection.js";
import { resolveCliRemoteCanvasId } from "./canvasBinding.js";
import { WorkspaceExecutionCliError } from "./errors.js";
import { createCliWorkspaceExecutionHttpPorts } from "./httpPorts.js";
import { createWorkspaceJsonTransport } from "./httpTransport.js";
import {
  resolveCliExecutionTarget,
  type CliExecutionTargetPolicy,
  type LocalExecutionAvailabilityPort
} from "./preflight.js";

export type WorkspaceRunOptions = CanvasCommandOptions & {
  target: CliExecutionTargetPolicy;
  agentEndpoint?: string;
  connectionProfile?: string;
  executor?: string;
  scope: WorkspaceExecutionScope;
  eventFormat: "legacy" | "execution-v1";
  follow?: boolean;
  signal?: AbortSignal;
};

function workspacePath(workspace: PackageWorkspaceRef): string {
  return typeof workspace === "string" ? workspace : workspace.packageDir;
}

function localAvailability(
  projectRoot: PackageWorkspaceRef,
  executorName: string
): LocalExecutionAvailabilityPort {
  return {
    async probe() {
      const result = await testExecutorProfile({ projectRoot, executorName });
      return { status: result.ok ? "available" : "unavailable" };
    }
  };
}

async function executionIdentity(input: {
  projectRoot: PackageWorkspaceRef;
  scope: WorkspaceExecutionScope;
  executorOverride?: string;
}): Promise<{ name: string; agentId: string | null }> {
  const status = await getExecutionStatus({ projectRoot: input.projectRoot });
  const graphPackage = await loadPlanGraphPackage(input.projectRoot);
  const blockRef = input.scope.kind === "block" ? input.scope.blockRef : undefined;
  const block = blockRef
    ? status.blocks.find((candidate) => candidate.ref === blockRef)
    : undefined;
  const name =
    input.executorOverride ??
    block?.effectiveExecutor ??
    graphPackage.manifest.execution.defaultExecutor ??
    "default";
  if (!name) throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  const evidence = await resolveExecutorRunnerEvidence({
    projectRoot: input.projectRoot,
    executorName: name
  });
  return { name, agentId: evidence.agentId };
}

export async function executeWorkspaceRun(
  options: WorkspaceRunOptions
): Promise<WorkspaceExecutionCoordinatorResult> {
  const projectRoot = await resolveCliPackageWorkspace(options);
  const packageWorkspace = workspacePath(projectRoot);
  const identity = await executionIdentity({
    projectRoot,
    scope: options.scope,
    executorOverride: options.executor
  });
  const target = await resolveCliExecutionTarget({
    policy: options.target,
    agentEndpointId: options.agentEndpoint,
    local: localAvailability(projectRoot, identity.name),
    signal: options.signal
  });
  const captured = await capturePackageSnapshot({ projectRoot });
  const graph = await loadPlanGraphPackage(projectRoot);
  const expected = {
    contentRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint
  };
  let request: WorkspaceExecutionRequest;
  let coordinator: WorkspaceExecutionCoordinator;
  if (target.policy === "local") {
    const authority = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: {
        async inspect() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        }
      }
    });
    const unavailable = {
      async list() {
        throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
      }
    };
    coordinator = new WorkspaceExecutionCoordinator({
      authority,
      catalog: unavailable,
      workAuthority: {
        async ensure() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        }
      },
      local: createLocalWorkspaceExecutionAdapter(),
      remote: {
        async inspectExisting() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async attachExisting() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async launch() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async recover() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async follow() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async collectEvidence() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        },
        async respond() {
          throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
        }
      }
    });
    request = {
      authority: { kind: "local_package", packageWorkspace, expected },
      scope: options.scope,
      trigger: "cli",
      target,
      ...(options.executor ? { executorOverride: options.executor } : {}),
      eventFormat: options.eventFormat
    };
  } else {
    if (options.scope.kind !== "block" || !identity.agentId) {
      throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
    }
    const connection = await new CliWorkspaceConnectionProvider().resolve(
      options.connectionProfile
    );
    const credential = new ProcessMemoryWorkspaceCredentialProvider().get();
    const transport = createWorkspaceJsonTransport({
      serverOrigin: connection.serverOrigin,
      credential
    });
    const canvasId = await resolveCliRemoteCanvasId({
      packageWorkspace: projectRoot,
      localCanvasId: resolveCliCanvasId(options) ?? "default",
      connection,
      transport,
      signal: options.signal
    });
    const ports = createCliWorkspaceExecutionHttpPorts({ connection, transport });
    const authority = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: ports.authoritySource
    });
    coordinator = new WorkspaceExecutionCoordinator({
      authority,
      catalog: ports.catalog,
      workAuthority: ports.workAuthority,
      local: createLocalWorkspaceExecutionAdapter(),
      remote: createRemoteWorkspaceExecutionAdapter({
        workAuthority: ports.workAuthority,
        command: ports.command,
        query: ports.query,
        interaction: ports.interaction
      }),
      sessionStorage: () => ({ kind: "package", packageWorkspace: projectRoot })
    });
    request = {
      authority: {
        kind: "workspace_canvas",
        contentAuthority: { kind: "package_snapshot", packageWorkspace, expected },
        connectionProfileId: connection.profileId,
        serverOrigin: connection.serverOrigin,
        workspaceId: connection.workspaceId,
        projectId: connection.projectId,
        canvasId
      },
      scope: options.scope,
      trigger: "cli",
      target,
      ...(options.executor ? { executorOverride: options.executor } : {}),
      effectiveExecutor: { name: identity.name, agentId: identity.agentId },
      eventFormat: options.eventFormat
    };
  }
  let result = await coordinator.execute(request, options.signal);
  const emitted = new Set<string>();
  printWorkspaceExecutionResult(result, options.eventFormat, emitted);
  while (options.follow && !["completed", "failed", "stopped"].includes(result.session.phase)) {
    if (result.events.some((event) => event.type === "action_required")) break;
    await new Promise<void>((resolve, reject) => {
      const onTimeout = () => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(onTimeout, 500);
      const onAbort = () => {
        clearTimeout(timer);
        reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    result = await coordinator.follow(request, result.session.sessionId, options.signal);
    printWorkspaceExecutionResult(result, options.eventFormat, emitted);
  }
  return result;
}

function printWorkspaceExecutionResult(
  result: WorkspaceExecutionCoordinatorResult,
  format: "legacy" | "execution-v1",
  emitted: Set<string>
): void {
  if (format === "execution-v1") {
    for (const event of result.events) {
      const parsed = workspaceExecutionEventSchema.parse(event);
      if (emitted.has(parsed.eventId)) continue;
      emitted.add(parsed.eventId);
      process.stdout.write(`${JSON.stringify(parsed)}\n`);
    }
    return;
  }
  console.log(
    `workspace execution ${result.handle.target} session=${result.session.sessionId} phase=${result.session.phase}`
  );
}
