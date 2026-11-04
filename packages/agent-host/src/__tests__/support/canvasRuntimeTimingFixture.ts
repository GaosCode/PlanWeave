import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CANVAS_RUNTIME_CAPABILITY,
  canvasRuntimeCancelCommandSchema,
  canvasRuntimeRequestCommandSchema,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import {
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt
} from "@planweave-ai/runtime";
import { vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { runtimeStateSchema } from "../../../../runtime/src/schema/runtimeState.js";
import {
  CanvasRuntimeService,
  type CanvasRuntimeServiceOptions
} from "../../runtime/canvasRuntimeService.js";
import { directories, setup, scope, response } from "./canvasRuntimeServiceFixture.js";

export type Invalidation =
  | "deadline"
  | "cancel"
  | "disconnect"
  | "lease_expired"
  | "lease_released";
type Phase = "ready" | "prepared" | "active";
type Identity = Parameters<ReturnType<typeof createRemoteBlockRuntimePort>["activate"]>[0];

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function evidence(
  identity: Pick<Identity, "operationId" | "sourceRevision" | "graphFingerprint">
) {
  return {
    operationId: identity.operationId,
    sourceRevision: identity.sourceRevision,
    graphFingerprint: identity.graphFingerprint
  };
}

async function artifactTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, content] of Object.entries(await artifactTree(path))) {
        result[`${entry.name}/${child}`] = content;
      }
    } else {
      result[entry.name] = await readFile(path, "utf8");
    }
  }
  return result;
}

export async function createTimingFixture(
  options: { firstPhase?: Phase; secondPhase?: Phase; leaseExpiresAt?: string } = {}
) {
  const { state } = await setup();
  const manifest = basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 });
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const workspace = await createTestWorkspace(manifest);
  directories.push(workspace.home, workspace.root);
  const canvas = workspace.init.workspace;
  const runtime = createRemoteBlockRuntimePort({ projectRoot: canvas });
  let now = new Date("2030-01-01T00:00:00.000Z");
  let sequence = 0;
  const resolve = vi.fn(async () => ({ scope, project: canvas, canvas }));
  const bytes = Buffer.from("timing fixture report\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: canvas,
    authorityProjectId: scope.projectId
  });
  const status = await readAuthorizedCanvasRuntimeStatus({
    projectRoot: canvas,
    canvasId: scope.canvasId,
    expectedPackageDir: canvas.packageDir,
    scope
  });
  const target = {
    revision: 1,
    content: {
      versionId: `version-${captured.content.canonicalDigest}`,
      canonicalDigest: captured.content.canonicalDigest,
      verification: "complete" as const
    },
    graphFingerprint: status.packageFingerprint
  };
  const contentTransfer = {
    updateCredentialToken: () => {},
    fetch: vi.fn(async () => ({
      schemaVersion: "content-version/v1" as const,
      scope,
      content: captured.content,
      completed: target.content,
      createdAt: now.toISOString(),
      createdBy: { kind: "system" as const, id: "server" }
    }))
  };
  const artifactTransfer = {
    updateCredentialToken: () => {},
    synchronizeServerTime: () => {},
    download: vi.fn(async () => bytes),
    upload: vi.fn(async () => {
      throw new Error("unexpected_upload");
    })
  };
  const createService = (overrides: Partial<CanvasRuntimeServiceOptions> = {}) =>
    new CanvasRuntimeService({
      resolver: {
        configured: () => true,
        mappings: () => [],
        resolveProject: async () => canvas,
        resolve
      },
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer,
      now: () => now,
      ...overrides
    });
  const service = createService();
  const command = (operation: unknown, requestId: string, deadline = "2099-01-01T00:00:00.000Z") =>
    canvasRuntimeRequestCommandSchema.parse({
      type: "canvas_runtime.request",
      protocolVersion: agentHostProtocolVersion,
      requestId,
      scope,
      deadline,
      operation
    });
  const receive = (
    request: CanvasRuntimeRequestCommand | ReturnType<typeof canvasRuntimeCancelCommandSchema.parse>
  ) => {
    sequence += 1;
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence,
      previousSequence: sequence - 1,
      messageId: `mailbox-${sequence}`,
      command: request
    });
  };
  const bootstrap = command(
    { operation: "availability", contentTarget: target },
    "request-bootstrap"
  );
  receive(bootstrap);
  await service.handle(bootstrap);
  const bootstrapped = response(state, bootstrap.requestId);
  if (
    bootstrapped?.type !== "canvas_runtime.response" ||
    bootstrapped.response.outcome !== "success"
  ) {
    throw new Error("fixture_materialization_failed");
  }
  resolve.mockClear();
  contentTransfer.fetch.mockClear();
  const { snapshot: packageSnapshot } = await capturePackageSnapshot({ projectRoot: canvas });
  const lease = {
    runtimeLeaseId: "runtime-lease-timing",
    ...scope,
    sourceRevision: packageSnapshot.sourceRevision,
    graphFingerprint: status.packageFingerprint,
    status: "active" as const,
    acquiredAt: now.toISOString(),
    expiresAt: options.leaseExpiresAt ?? "2099-01-01T00:00:00.000Z"
  };
  state.canvasRuntime.createLease(lease);
  const prepare = async (ref: string, operationId: string, phase: Phase) => {
    const candidate = await runtime.inspect({ ref });
    const identity = {
      ref,
      operationId,
      controlPlane: "collaboration" as const,
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint,
      dispatchId: `dispatch-${operationId}`,
      executionAttemptId: `attempt-${operationId}`
    };
    if (phase !== "ready")
      await runtime.claim({ ref, ...evidence(identity), controlPlane: identity.controlPlane });
    if (phase === "active") await runtime.activate(identity);
    return identity;
  };
  const firstIdentity = await prepare(
    "T-001#B-001",
    "operation-first",
    options.firstPhase ?? "active"
  );
  const secondIdentity = await prepare(
    "T-002#B-001",
    "operation-second",
    options.secondPhase ?? "ready"
  );
  await writeFile(join(canvas.resultsDir, "preserved-history.txt"), "existing history\n", "utf8");
  const complete = (identity: Identity, requestId: string, deadline?: string) =>
    command(
      {
        operation: "complete",
        runtimeLeaseId: lease.runtimeLeaseId,
        evidence: evidence(identity),
        input: {
          domainInput: { ...identity, reportArtifactRef: `artifact:sha256:${sha256}` },
          transfer: {
            version: "canvas-runtime-artifact-transfer/v1",
            direction: "download",
            grantId: `grant-${requestId}`,
            runtimeLeaseId: lease.runtimeLeaseId,
            artifactRef: `artifact:sha256:${sha256}`,
            sha256,
            mediaType: "text/plain",
            sizeBytes: bytes.byteLength,
            expiresAt: "2099-01-01T00:00:00.000Z"
          }
        }
      },
      requestId,
      deadline
    );
  const reset = (requestId: string, deadline?: string) => {
    const resetEvidence = {
      operationId: "operation-reset",
      sourceRevision: lease.sourceRevision,
      graphFingerprint: lease.graphFingerprint
    };
    return command(
      {
        operation: "reset",
        runtimeLeaseId: lease.runtimeLeaseId,
        evidence: resetEvidence,
        input: resetEvidence
      },
      requestId,
      deadline
    );
  };
  const invalidate = async (kind: Invalidation, requestId: string, current = service) => {
    if (kind === "deadline" || kind === "lease_expired") now = new Date("2030-01-01T00:00:02.000Z");
    else if (kind === "lease_released") state.canvasRuntime.releaseLease(lease.runtimeLeaseId);
    else if (kind === "disconnect") current.disconnect();
    else {
      const cancellation = canvasRuntimeCancelCommandSchema.parse({
        type: "canvas_runtime.cancel",
        protocolVersion: agentHostProtocolVersion,
        requestId: `cancel-${requestId}`,
        targetRequestId: requestId,
        scope,
        deadline: "2099-01-01T00:00:00.000Z"
      });
      receive(cancellation);
      await current.handle(cancellation);
    }
  };
  const snapshot = async () => {
    const stateText = await readFile(canvas.stateFile, "utf8");
    return {
      stateText,
      state: runtimeStateSchema.parse(JSON.parse(stateText)),
      results: await artifactTree(canvas.resultsDir),
      package: (await capturePackageSnapshot({ projectRoot: canvas })).snapshot,
      resetReceipt: await readRuntimeResetReceipt({ projectRoot: canvas })
    };
  };
  return {
    state,
    canvas,
    service,
    createService,
    resolve,
    artifactTransfer,
    contentTransfer,
    bytes,
    lease,
    target,
    firstIdentity,
    secondIdentity,
    prepare,
    command,
    receive,
    complete,
    reset,
    invalidate,
    snapshot,
    response: (requestId: string) => response(state, requestId)
  };
}

export async function waitUntilResolved(
  fixture: Awaited<ReturnType<typeof createTimingFixture>>,
  count: number
) {
  await vi.waitFor(() => {
    if (fixture.resolve.mock.calls.length < count) throw new Error("command_not_resolved");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}
