import { createHash, randomUUID } from "node:crypto";
import type { RemoteHumanExecutionActionCommand } from "@planweave-ai/collaboration-protocol/remote-run";
import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  WorkspaceExecutionCoordinator,
  captureAuthorizedCanvasContent,
  createLocalPackageAuthoritySource,
  createRemoteBlockRuntimePort,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  isOwnerCanvasRemoteAuthorityBinding,
  loadPlanGraphPackage,
  packageSnapshotSourceRevision,
  resolveTaskCanvasWorkspace,
  type RemoteBlockRuntimePort,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionSessionStorage
} from "@planweave-ai/runtime";
import type { DesktopWorkspaceExecutionStartInput } from "../shared/workspaceExecution.js";
import type { OperatorControlClient } from "./operatorControl/OperatorControlClient.js";
import type { OperatorControlService } from "./operatorControl/operatorControlService.js";
import type { DesktopWorkspaceExecutionSessionRepository } from "./workspaceExecutionDesktopSessionRepository.js";

export type OwnerCanvasExecutionInput = Extract<
  DesktopWorkspaceExecutionStartInput,
  { locator: { kind: "owner_canvas" } }
>;

export type OwnerCanvasRemoteOperations = {
  observeRemoteOperation(
    operationId: string
  ): ReturnType<OperatorControlClient["observeRemoteOperation"]>;
  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand
  ): ReturnType<OperatorControlClient["executeRemoteOperationAction"]>;
  readOwnerRemoteOperationTerminalResult(
    operationId: string
  ): ReturnType<OperatorControlClient["readOwnerRemoteOperationTerminalResult"]>;
};

export type OwnerCanvasExecutionContext = {
  coordinator: WorkspaceExecutionCoordinator;
  request: WorkspaceExecutionRequest;
  remoteOperations: OwnerCanvasRemoteOperations;
  localRuntime: RemoteBlockRuntimePort;
};

type OwnerCanvasLocator = OwnerCanvasExecutionInput["locator"];

function createOwnerCanvasCoordinator(input: {
  blockRef: string;
  client: OperatorControlClient;
  localAuthority: ReturnType<typeof createLocalPackageAuthoritySource>;
  locator: OwnerCanvasLocator;
  sessions: DesktopWorkspaceExecutionSessionRepository;
}): WorkspaceExecutionCoordinator {
  const workAuthority = { ensure: async () => null };
  const authority = createWorkspaceAuthorityBindingResolver({
    local: input.localAuthority,
    remote: {
      async inspect() {
        throw new Error("workspace_authority_unavailable");
      }
    }
  });
  return new WorkspaceExecutionCoordinator({
    authority,
    catalog: {
      list: () =>
        input.client.listAgentEndpoints({
          humanPrincipalId: input.locator.humanPrincipalId,
          projectId: input.locator.projectId,
          canvasId: input.locator.canvasId
        })
    },
    workAuthority,
    local: {
      async launch() {
        throw new Error("local_execution_unavailable");
      }
    },
    remote: createRemoteWorkspaceExecutionAdapter({
      workAuthority,
      command: {
        dispatch: ({ intent }) =>
          input.client.dispatchRemoteOperation(intent, input.locator.humanPrincipalId)
      },
      query: {
        async recover() {
          return null;
        },
        observe: ({ operationId }) =>
          input.client.observeRemoteOperation(operationId, input.locator.humanPrincipalId),
        replay: ({ operationId, afterCursor }) =>
          input.client.replayRemoteOperationEvents(
            operationId,
            afterCursor,
            input.locator.humanPrincipalId
          ),
        interactions: ({ operationId, cursor }) =>
          input.client.listRemoteOperationInteractions(
            operationId,
            cursor,
            input.locator.humanPrincipalId
          )
      },
      interaction: {
        respond: ({ operationId, response }) =>
          input.client.settleRemoteOperationInteraction(
            operationId,
            response,
            input.locator.humanPrincipalId
          )
      }
    }),
    sessions: input.sessions,
    sessionStorage: () => ownerSessionStorage(input.locator),
    sessionStorageForRequest: () => ownerSessionStorage(input.locator),
    idempotencyKey: randomUUID
  });
}

export async function withOwnerCanvasExistingExecutionCoordinator<T>(input: {
  blockRef: string;
  locator: OwnerCanvasLocator;
  operationId: string;
  operatorControl: Pick<OperatorControlService, "withExecutionProfile">;
  sessions: DesktopWorkspaceExecutionSessionRepository;
  operation(context: {
    coordinator: WorkspaceExecutionCoordinator;
    expected: { contentRevision: string; graphFingerprint: string };
    serverOrigin: string;
  }): Promise<T>;
}): Promise<T> {
  return input.operatorControl.withExecutionProfile(
    input.locator.operatorProfileId,
    async (client) => {
      const serverOrigin = new URL(client.connectionProfile.serverBaseUrl).origin;
      const observed = await client.observeRemoteOperation(
        input.operationId,
        input.locator.humanPrincipalId
      );
      const diagnostics = observed.diagnostics;
      if (
        observed.operationId !== input.operationId ||
        observed.projectId !== input.locator.projectId ||
        observed.canvasId !== input.locator.canvasId ||
        observed.blockRef !== input.blockRef ||
        !diagnostics ||
        diagnostics.locator.projectId !== input.locator.projectId ||
        diagnostics.locator.canvasId !== input.locator.canvasId
      ) {
        throw new Error("workspace_execution_resume_mismatch");
      }
      const localAuthority = {
        async inspect() {
          return {
            packageWorkspace: input.locator.projectRoot,
            projectId: input.locator.projectId,
            canvasId: input.locator.canvasId,
            contentRevision: diagnostics.content.revision,
            graphFingerprint: diagnostics.content.fingerprint
          };
        }
      };
      const expected = {
        contentRevision: diagnostics.content.revision,
        graphFingerprint: diagnostics.content.fingerprint
      };
      return input.operation({
        coordinator: createOwnerCanvasCoordinator({
          blockRef: input.blockRef,
          client,
          localAuthority,
          locator: input.locator,
          sessions: input.sessions
        }),
        expected,
        serverOrigin
      });
    }
  );
}

export function ownerCanvasMaterializationIntentId(
  canonicalDigest: string,
  expectedHead: Awaited<
    ReturnType<OperatorControlClient["inspectOwnerCanvasMaterializationHead"]>
  >["head"]
): string {
  const headDigest = createHash("sha256").update(JSON.stringify(expectedHead)).digest("hex");
  return `content:${canonicalDigest}:head:${headDigest}`;
}

function ownerSessionStorage(
  input: OwnerCanvasExecutionInput["locator"]
): WorkspaceExecutionSessionStorage {
  const canonical = JSON.stringify([
    "owner_canvas",
    input.operatorProfileId,
    input.humanPrincipalId,
    input.projectId,
    input.canvasId,
    input.projectRoot
  ]);
  return {
    kind: "namespace",
    namespace: `wxs:sha256:${createHash("sha256").update(canonical).digest("hex")}`
  };
}

export async function withOwnerCanvasExecutionCoordinator<T>(input: {
  requestInput: OwnerCanvasExecutionInput;
  operatorControl: Pick<OperatorControlService, "withExecutionProfile">;
  sessions: DesktopWorkspaceExecutionSessionRepository;
  sessionId?: string;
  operation(context: OwnerCanvasExecutionContext): Promise<T>;
}): Promise<T> {
  const locator = input.requestInput.locator;
  const workspace = await resolveTaskCanvasWorkspace(locator.projectRoot, locator.canvasId);
  const packageWorkspace = locator.projectRoot;
  const materializationScope = {
    ownerHumanPrincipalId: humanPrincipalIdSchema.parse(locator.humanPrincipalId),
    projectId: locator.projectId,
    canvasId: locator.canvasId
  } as const;
  const sessionBinding = input.sessionId
    ? (await input.sessions.get(ownerSessionStorage(locator), input.sessionId)).session
        .workspaceExecution?.binding
    : null;
  if (
    sessionBinding &&
    (sessionBinding.kind !== "remote" || !isOwnerCanvasRemoteAuthorityBinding(sessionBinding))
  ) {
    throw new Error("workspace_execution_resume_mismatch");
  }
  const persistedBinding = sessionBinding;
  if (
    persistedBinding &&
    (persistedBinding.connectionProfileId !== locator.operatorProfileId ||
      persistedBinding.humanPrincipalId !== locator.humanPrincipalId ||
      persistedBinding.projectId !== locator.projectId ||
      persistedBinding.canvasId !== locator.canvasId ||
      persistedBinding.blockRef !== input.requestInput.blockRef)
  ) {
    throw new Error("workspace_execution_resume_mismatch");
  }
  const startContent = persistedBinding
    ? null
    : await Promise.all([
        captureAuthorizedCanvasContent({
          projectRoot: workspace,
          authorityProjectId: locator.projectId
        }),
        loadPlanGraphPackage(workspace)
      ]);

  return input.operatorControl.withExecutionProfile(locator.operatorProfileId, async (client) => {
    const serverOrigin = new URL(client.connectionProfile.serverBaseUrl).origin;
    if (persistedBinding && persistedBinding.serverOrigin !== serverOrigin) {
      throw new Error("workspace_execution_resume_mismatch");
    }
    let expected: { contentRevision: string; graphFingerprint: string };
    let localAuthority = createLocalPackageAuthoritySource();
    if (persistedBinding) {
      expected = persistedBinding.contentAuthority.expected;
      localAuthority = {
        async inspect() {
          return {
            packageWorkspace: persistedBinding.contentAuthority.packageWorkspace,
            projectId: persistedBinding.projectId,
            canvasId: persistedBinding.canvasId,
            contentRevision: persistedBinding.contentRevision,
            graphFingerprint: persistedBinding.graphFingerprint
          };
        }
      };
    } else {
      if (!startContent) throw new Error("owner_canvas_materialization_content_missing");
      const [captured, loaded] = startContent;
      const localExpected = {
        contentRevision: packageSnapshotSourceRevision(captured.digestManifest),
        graphFingerprint: loaded.graph.packageFingerprint
      };
      const current = await client.inspectOwnerCanvasMaterializationHead(materializationScope);
      const currentContentMatches =
        current.head.kind === "present" &&
        current.head.content.canonicalDigest === captured.content.canonicalDigest;
      expected = currentContentMatches
        ? localExpected
        : await client
            .materializeOwnerCanvas({
              schemaVersion: "owner-canvas-materialization/v1",
              materializationId: ownerCanvasMaterializationIntentId(
                captured.content.canonicalDigest,
                current.head
              ),
              scope: materializationScope,
              expectedHead: current.head,
              content: captured.content
            })
            .then((materialized) => ({
              contentRevision: materialized.contentRevision,
              graphFingerprint: materialized.graphFingerprint
            }));
      if (
        expected.contentRevision !== localExpected.contentRevision ||
        expected.graphFingerprint !== localExpected.graphFingerprint
      ) {
        throw new Error("owner_canvas_materialization_authority_mismatch");
      }
    }
    const request = {
      authority: {
        kind: "owner_canvas",
        packageWorkspace,
        expected,
        connectionProfileId: locator.operatorProfileId,
        serverOrigin,
        humanPrincipalId: locator.humanPrincipalId,
        projectId: locator.projectId,
        canvasId: locator.canvasId
      },
      scope: { kind: "block", blockRef: input.requestInput.blockRef },
      trigger: "desktop",
      target: {
        policy: "remote",
        agentEndpointId: input.requestInput.agentEndpointId
      },
      effectiveExecutor: input.requestInput.effectiveExecutor,
      eventFormat: "execution-v1"
    } satisfies WorkspaceExecutionRequest;
    const coordinator = createOwnerCanvasCoordinator({
      blockRef: input.requestInput.blockRef,
      client,
      localAuthority,
      locator,
      sessions: input.sessions
    });
    return input.operation({
      coordinator,
      request,
      remoteOperations: {
        observeRemoteOperation: (operationId) =>
          client.observeRemoteOperation(operationId, locator.humanPrincipalId),
        executeRemoteOperationAction: (operationId, action) =>
          client.executeRemoteOperationAction(operationId, action, locator.humanPrincipalId),
        readOwnerRemoteOperationTerminalResult: (operationId) =>
          client.readOwnerRemoteOperationTerminalResult(operationId, locator.humanPrincipalId)
      },
      localRuntime: createRemoteBlockRuntimePort({ projectRoot: workspace })
    });
  });
}
