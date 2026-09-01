import {
  CANVAS_RUNTIME_CAPABILITY,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  agentHostProtocolVersion
} from "@planweave-ai/agent-host-protocol";
import {
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus
} from "@planweave-ai/runtime";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const acpCapabilities = ["acp.codex", "acp.session.load"] as const;

export type PathlessCanvasRuntimeFailure = "acquire" | "inspect" | "content_out_of_sync";

export type PathlessCanvasRuntimeHostHandle = {
  disconnect(): void;
};

function graphFingerprintFrom(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "graphFingerprint" in value &&
    typeof value.graphFingerprint === "string"
  ) {
    return value.graphFingerprint;
  }
  return undefined;
}

function runtimeError(operation: string, code: string) {
  return {
    outcome: "error" as const,
    operation,
    error: {
      code,
      message: "The Canvas Runtime request could not be completed.",
      retryable: false
    }
  };
}

/**
 * Opens an Agent Host WS session with canvas-runtime capability and answers
 * inspect/lease RPCs through the existing Runtime port for one test package.
 */
export async function connectPathlessCanvasRuntimeHost(input: {
  origin: string;
  hostId: string;
  token: string;
  scope: { workspaceId: string; projectId: string; canvasId: string };
  projectRoot: string;
  expectedPackageDir: string;
  sockets: WebSocket[];
  contentGraphFingerprint?: string;
  failOperation?: PathlessCanvasRuntimeFailure;
}): Promise<PathlessCanvasRuntimeHostHandle> {
  const runtime = createRemoteBlockRuntimePort({ projectRoot: input.projectRoot });
  const url = `${input.origin.replace(/^http/, "ws")}/agent-hosts/${input.hostId}/connect`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${input.token}` } });
  input.sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const welcomed = new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as { type?: unknown; code?: unknown };
      if (event.type === "host.welcome") {
        socket.off("message", onMessage);
        resolve();
        return;
      }
      if (event.type === "protocol.error") {
        socket.off("message", onMessage);
        reject(new Error(typeof event.code === "string" ? event.code : "host_hello_rejected"));
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: agentHostProtocolVersion,
      supportedExecutionEnvelopeVersions: [1, 2],
      lastAcknowledgedSequence: 0,
      capabilities: [
        CANVAS_RUNTIME_CAPABILITY,
        WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
        ...acpCapabilities
      ],
      capacity: 1,
      readiness: {
        workspaceMappings: [{ workspaceId: input.scope.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Test Agent",
            status: "ready",
            capabilities: [...acpCapabilities]
          }
        ],
        runtimeProjects: []
      }
    })
  );
  await welcomed;

  let contentGraphFingerprint = input.contentGraphFingerprint;
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString()) as {
      type?: unknown;
      command?: { type?: unknown; requestId?: unknown; operation?: unknown; scope?: unknown };
    };
    if (event.type !== "mailbox.message" || event.command?.type !== "canvas_runtime.request") {
      return;
    }
    const requestId = event.command.requestId;
    const operation = event.command.operation as {
      operation: string;
      input?: unknown;
      contentTarget?: unknown;
    };
    const scope = event.command.scope as
      | { workspaceId?: string; projectId?: string; canvasId?: string }
      | undefined;
    void (async () => {
      const fromAcquire = graphFingerprintFrom(operation.contentTarget);
      if (fromAcquire) contentGraphFingerprint = fromAcquire;
      const response = await answerRuntimeRequest({
        runtime,
        collaborationScope: input.scope,
        commandScope: {
          workspaceId: scope?.workspaceId ?? input.scope.workspaceId,
          projectId: scope?.projectId ?? input.scope.projectId,
          canvasId: scope?.canvasId ?? input.scope.canvasId
        },
        operation,
        projectRoot: input.projectRoot,
        expectedPackageDir: input.expectedPackageDir,
        contentGraphFingerprint,
        failOperation: input.failOperation
      });
      socket.send(
        JSON.stringify({
          type: "canvas_runtime.response",
          protocolVersion: agentHostProtocolVersion,
          messageId: randomUUID(),
          requestId,
          response
        })
      );
    })();
  });

  return {
    disconnect() {
      socket.terminate();
    }
  };
}

async function answerRuntimeRequest(input: {
  runtime: ReturnType<typeof createRemoteBlockRuntimePort>;
  collaborationScope: { workspaceId: string; projectId: string; canvasId: string };
  commandScope: { workspaceId: string; projectId: string; canvasId: string };
  operation: { operation: string; input?: unknown; contentTarget?: unknown };
  projectRoot: string;
  expectedPackageDir: string;
  contentGraphFingerprint?: string;
  failOperation?: PathlessCanvasRuntimeFailure;
}): Promise<Record<string, unknown>> {
  const {
    operation,
    runtime,
    collaborationScope,
    commandScope,
    projectRoot,
    expectedPackageDir,
    contentGraphFingerprint,
    failOperation
  } = input;
  if (failOperation === "content_out_of_sync" && operation.operation === "acquire") {
    return runtimeError(operation.operation, "content_out_of_sync");
  }
  if (failOperation && operation.operation === failOperation) {
    return runtimeError(operation.operation, "materialization_failed");
  }
  try {
    if (operation.operation === "acquire") {
      const acquiredAt = new Date().toISOString();
      const graphFingerprint =
        contentGraphFingerprint ?? graphFingerprintFrom(operation.contentTarget);
      if (!graphFingerprint) {
        return runtimeError(operation.operation, "materialization_failed");
      }
      return {
        outcome: "success",
        operation: "acquire",
        result: {
          runtimeLeaseId: randomUUID(),
          sourceRevision: "src-pathless-runtime",
          graphFingerprint,
          acquiredAt,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      };
    }
    if (operation.operation === "release") {
      return { outcome: "success", operation: "release", result: { released: true } };
    }
    if (operation.operation === "status" || operation.operation === "availability") {
      if (!contentGraphFingerprint) {
        return runtimeError(operation.operation, "materialization_failed");
      }
      const status = await readAuthorizedCanvasRuntimeStatus({
        projectRoot,
        canvasId: commandScope.canvasId,
        expectedPackageDir,
        scope: commandScope
      });
      if (operation.operation === "status") {
        return { outcome: "success", operation: "status", result: status };
      }
      return {
        outcome: "success",
        operation: "availability",
        result: {
          kind: "available",
          status,
          sourceRevision: "src-pathless-runtime",
          graphFingerprint: contentGraphFingerprint
        }
      };
    }
    if (operation.operation === "inspect") {
      const candidate = await runtime.inspect(operation.input as { ref: string });
      return {
        outcome: "success",
        operation: "inspect",
        result: {
          ...candidate,
          workspaceId: collaborationScope.workspaceId,
          projectId: collaborationScope.projectId,
          canvasId: collaborationScope.canvasId
        }
      };
    }
    if (operation.operation === "claim") {
      return {
        outcome: "success",
        operation: "claim",
        result: await runtime.claim(operation.input as Parameters<typeof runtime.claim>[0])
      };
    }
    if (operation.operation === "activate") {
      return {
        outcome: "success",
        operation: "activate",
        result: await runtime.activate(operation.input as Parameters<typeof runtime.activate>[0])
      };
    }
    if (operation.operation === "query") {
      return {
        outcome: "success",
        operation: "query",
        result: await runtime.query(operation.input as Parameters<typeof runtime.query>[0])
      };
    }
    if (operation.operation === "reconcile") {
      return {
        outcome: "success",
        operation: "reconcile",
        result: await runtime.reconcile(operation.input as Parameters<typeof runtime.reconcile>[0])
      };
    }
    return runtimeError(operation.operation, "canvas_runtime_operation_failed");
  } catch (error) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "canvas_runtime_operation_failed";
    return runtimeError(operation.operation, code);
  }
}
