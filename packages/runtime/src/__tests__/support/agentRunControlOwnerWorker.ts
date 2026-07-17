import { createInterface } from "node:readline";
import { z } from "zod";
import type { AcpConnection } from "../../autoRun/acpConnection.js";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../../autoRun/activeAgentRunRegistry.js";
import {
  agentRunControlLeaseIdSchema,
  type AgentRunControlEndpointDescriptor
} from "../../autoRun/agentRunControlContract.js";
import { AgentRunControlServer } from "../../autoRun/agentRunControlServer.js";
import { createActiveAgentRunControlTarget } from "../../autoRun/agentRunControlTarget.js";
import {
  createLiveOwnership,
  type JsonRpcValue,
  type LivePendingRequestHandle,
  type RunnerInterventionCapabilities,
  type RunnerLiveControl
} from "../../autoRun/liveControl.js";
import { runnerSessionActionIdentitySchema } from "../../autoRun/runnerContractSchemas.js";

const [runDir, rawIdentity] = process.argv.slice(2);
if (!(runDir && rawIdentity)) {
  throw new Error("Agent run control owner worker requires runDir and identity arguments.");
}

const identity = runnerSessionActionIdentitySchema.parse(JSON.parse(rawIdentity) as unknown);
if (identity.scope !== runDir) throw new Error("Worker identity scope must equal runDir.");

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const workerCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add_request"),
      requestKind: z.enum(["permission", "elicitation"]),
      requestId: z.string().min(1),
      delayMs: z.number().int().min(0).max(2000).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("capabilities"),
      cancel: z.boolean().optional(),
      permission: z.boolean().optional(),
      elicitationPreview: z.boolean().optional()
    })
    .strict(),
  z.object({ kind: z.literal("snapshot") }).strict(),
  z.object({ kind: z.literal("stop") }).strict()
]);
type WorkerCommand = z.infer<typeof workerCommandSchema>;

function fakeConnection(): AcpConnection {
  const unavailable = async (): Promise<never> => {
    throw new Error("Fake ACP connection operation is unavailable in this fixture.");
  };
  return {
    processId: process.pid,
    pendingOperationCount: 0,
    pendingOperations: new Map(),
    stderr: [],
    closed: new Promise<void>(() => undefined),
    initialize: unavailable,
    authenticate: unavailable,
    newSession: unavailable,
    loadSession: unavailable,
    prompt: unavailable,
    cancel: async () => undefined,
    closeSession: unavailable,
    setSessionMode: unavailable,
    setSessionConfigOption: unavailable,
    dispose: async () => undefined
  };
}

const registry = new ActiveAgentRunRegistry();
const ownership = createLiveOwnership(`${identity.scope}:${identity.executorRunId}`, 1);
const pendingRequests = new Map<string, LivePendingRequestHandle>();
const capabilities: RunnerInterventionCapabilities = {
  cancel: true,
  permission: true,
  elicitationPreview: true
};
const control: RunnerLiveControl = {
  ownership,
  sessionId: identity.sessionId,
  process: {
    pid: process.pid,
    terminate: async (reason) => emit({ kind: "cleanup", operation: "terminate", reason })
  },
  connection: {
    send: async () => undefined,
    close: async (reason) => emit({ kind: "cleanup", operation: "close", reason }),
    cancelSession: async (sessionId) =>
      emit({ kind: "cleanup", operation: "cancel_session", sessionId }),
    closeSession: async (sessionId) =>
      emit({ kind: "cleanup", operation: "close_session", sessionId }),
    supportsSessionClose: true
  },
  interventionCapabilities: capabilities,
  pendingRequests,
  pendingOperations: new Map()
};

let server: AgentRunControlServer;
let drainingPrompt = false;
const handle: ActiveAgentRunHandle = {
  identity: { ...identity },
  connection: fakeConnection(),
  abortController: new AbortController(),
  eventSink: () => undefined,
  ownership,
  control,
  lifecycleState: "running",
  agentRunControlLeaseId: agentRunControlLeaseIdSchema.parse(globalThis.crypto.randomUUID()),
  beforeRemove: async () => server.requestShutdown()
};
registry.register(handle);

registry.subscribeInteractionChanges((changed) => {
  if (changed !== handle || drainingPrompt || !registry.promptInFlight(handle)) return;
  drainingPrompt = true;
  void registry
    .drainPromptQueue(handle, async (prompt) => {
      emit({ kind: "delivery", action: "follow_up", prompt });
    })
    .finally(() => {
      drainingPrompt = false;
    });
});

function setRunningAfterResponse(): void {
  if (handle.lifecycleState === "waiting_interaction") registry.transition(handle, "running");
}

function addRequest(message: Extract<WorkerCommand, { kind: "add_request" }>): void {
  const requestId = message.requestId;
  const requestKind = message.requestKind;
  const delayMs = message.delayMs ?? 0;
  const respond = async (value: JsonRpcValue): Promise<void> => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    pendingRequests.delete(requestId);
    setRunningAfterResponse();
    emit({ kind: "delivery", action: "respond", requestId, value });
  };
  const reject = async (reason: string): Promise<void> => {
    pendingRequests.delete(requestId);
    emit({ kind: "delivery", action: "reject", requestId, reason });
  };
  const base = {
    requestId,
    interactionId: requestId,
    requestedAt: new Date().toISOString(),
    summary: `Fixture ${requestKind} request`,
    respond,
    reject
  };
  pendingRequests.set(
    requestId,
    requestKind === "permission"
      ? {
          ...base,
          kind: "permission",
          permissionOptions: [
            { optionId: "allow", label: "Allow", decision: "approve" },
            { optionId: "deny", label: "Deny", decision: "deny" }
          ]
        }
      : { ...base, kind: "elicitation", elicitationSchema: { type: "object" } }
  );
  if (handle.lifecycleState === "running") registry.transition(handle, "waiting_interaction");
  registry.notifyInteractionChanged(handle);
  emit({ kind: "request_ready", requestId, requestKind });
}

async function stopOwner(): Promise<void> {
  await server.stop();
  await server.stop();
  emit({ kind: "stopped", registrySize: registry.size });
  process.exit(0);
}

server = new AgentRunControlServer({
  runDir,
  leaseId: handle.agentRunControlLeaseId,
  target: createActiveAgentRunControlTarget({ registry, handle, identity }),
  idleTimeoutMs: 150
});
const descriptor: AgentRunControlEndpointDescriptor = await server.start();
emit({ kind: "ready", descriptor, identity });

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
async function handleCommand(line: string): Promise<void> {
  const message = workerCommandSchema.parse(JSON.parse(line) as unknown);
  switch (message.kind) {
    case "add_request":
      addRequest(message);
      break;
    case "capabilities":
      if (message.cancel !== undefined) capabilities.cancel = message.cancel;
      if (message.permission !== undefined) capabilities.permission = message.permission;
      if (message.elicitationPreview !== undefined) {
        capabilities.elicitationPreview = message.elicitationPreview;
      }
      emit({ kind: "capabilities_set", capabilities: { ...capabilities } });
      break;
    case "snapshot":
      emit({
        kind: "snapshot",
        pendingRequestIds: [...pendingRequests.keys()],
        lifecycleState: handle.lifecycleState,
        registrySize: registry.size
      });
      break;
    case "stop":
      await stopOwner();
      break;
  }
}

lines.on("line", (line) => {
  handleCommand(line).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    emit({ kind: "worker_error", message });
    process.exitCode = 1;
  });
});
