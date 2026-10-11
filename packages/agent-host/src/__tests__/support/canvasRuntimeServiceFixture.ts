import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWorkspace } from "@planweave-ai/runtime";
import { afterEach, vi } from "vitest";
import type { CanvasRuntimeResolverPort } from "../../runtime/canvasRuntimeResolver.js";
import { openAgentHostState, type AgentHostState } from "../../state/agentHostState.js";
export const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

export async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-canvas-runtime-service-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  states.push(state);
  return { state };
}

export const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };
export const sourceRevision = `snapshot:${"b".repeat(64)}`;
export const graphFingerprint = `pkg-${"a".repeat(64)}`;
export const artifactTransfer = {
  updateCredentialToken: vi.fn(),
  synchronizeServerTime: vi.fn(),
  download: vi.fn(async () => new Uint8Array([1])),
  upload: vi.fn(async () => {})
};
export const contentTransfer = {
  updateCredentialToken: vi.fn(),
  fetch: vi.fn(async () => {
    throw new Error("unexpected_content_transfer");
  })
};

export function contentTarget(fingerprint = graphFingerprint) {
  const canonicalDigest = "c".repeat(64);
  return {
    revision: 1,
    content: {
      versionId: `version-${canonicalDigest}`,
      canonicalDigest,
      verification: "complete" as const
    },
    graphFingerprint: fingerprint
  };
}

export function request(
  requestId: string,
  operation: Record<string, unknown> = { operation: "availability" },
  deadline = "2099-01-01T00:00:00.000Z"
) {
  const materializingOperation =
    operation.operation === "availability" ||
    operation.operation === "resolve_work_items" ||
    operation.operation === "acquire"
      ? { ...operation, contentTarget: operation.contentTarget ?? contentTarget() }
      : operation;
  return {
    type: "canvas_runtime.request" as const,
    protocolVersion: 1 as const,
    requestId,
    scope,
    deadline,
    operation: materializingOperation
  };
}

export function cancel(requestId: string, targetRequestId: string) {
  return {
    type: "canvas_runtime.cancel" as const,
    protocolVersion: 1 as const,
    requestId,
    targetRequestId,
    scope,
    deadline: "2099-01-01T00:00:00.000Z"
  };
}

export function delivery(
  sequence: number,
  command: ReturnType<typeof request> | ReturnType<typeof cancel>
) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command
  };
}

export function response(state: AgentHostState, requestId: string) {
  return state
    .pendingEvents()
    .find((event) => event.type === "canvas_runtime.response" && event.requestId === requestId);
}

export function unusedWorkspace(): ProjectWorkspace {
  return {
    id: "project-1",
    projectCreatedAt: null,
    packageStorageIdentity: null,
    resultsStorageIdentity: null,
    kind: "managed",
    rootPath: "/not-observed",
    sourceRoot: null,
    planweaveHome: "/not-observed",
    workspaceRoot: "/not-observed",
    projectFile: "/not-observed/project.json",
    packageDir: "/not-observed/package",
    manifestFile: "/not-observed/manifest.json",
    stateFile: "/not-observed/state.json",
    resultsDir: "/not-observed/results",
    projectPromptFile: "/not-observed/project-prompt.md"
  };
}

export function resolverWith(
  resolve: CanvasRuntimeResolverPort["resolve"]
): CanvasRuntimeResolverPort {
  const workspace = unusedWorkspace();
  return {
    configured: () => true,
    mappings: () => [],
    resolveProject: async () => workspace,
    resolve
  };
}

export function createLease(state: AgentHostState, runtimeLeaseId = "runtime-lease-1") {
  state.canvasRuntime.createLease({
    runtimeLeaseId,
    ...scope,
    sourceRevision,
    graphFingerprint,
    status: "active",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
}

export async function writeContentTargetReceipt(
  workspace: ProjectWorkspace,
  target: ReturnType<typeof contentTarget>
): Promise<void> {
  await writeFile(
    join(workspace.workspaceRoot, "authority-content-target.json"),
    `${JSON.stringify(target, null, 2)}\n`,
    "utf8"
  );
}
