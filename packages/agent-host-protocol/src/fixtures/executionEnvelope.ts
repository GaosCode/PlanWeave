import type { ExecutionEnvelopeInput } from "../executionEnvelope.js";

/**
 * Stable producer fixture for contract tests.
 * Digest is locked by executionEnvelope.test.ts so consumers can share the same hash.
 */
export const exampleExecutionEnvelopeInput = {
  protocolVersion: 2,
  execution: {
    dispatchId: "dispatch-demo-001",
    attemptId: "attempt-001"
  },
  projectId: "project-demo",
  canvasId: "default",
  taskId: "FND-001",
  blockRef: "FND-001#B-002",
  blockType: "implementation" as const,
  sourceRevision: "pgv-pkg-demo-revision-001",
  graphFingerprint: "graph-fp-demo-001",
  renderedPrompt:
    "# Define and hash the portable Execution Envelope\n\nImplement a strict envelope.",
  acceptance: [
    "Envelope is bounded and content-addressed",
    "Forbidden Coordinator-local fields are rejected by schema shape"
  ],
  dependencySummaries: [
    {
      blockRef: "FND-001#B-001",
      outcome: "completed" as const,
      summary: "Created schema-only agent-host-protocol package.",
      reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
    }
  ],
  inputArtifacts: [
    {
      artifactRef: `artifact:sha256:${"c".repeat(64)}`,
      logicalName: "upstream-report",
      mediaType: "text/markdown"
    }
  ],
  runtimeAuthority: "workspace_canvas" as const,
  workspaceId: "workspace.planweave-core",
  agentId: "codex",
  agentProfileId: "acp.codex",
  session: {
    modeId: "default",
    configOptions: [{ optionId: "model", valueId: "default" }]
  },
  requiredCapabilities: ["linux", "acp.codex", "workspace.git"],
  output: {
    reportRequired: true,
    maxArtifactBytes: 1_048_576,
    maxArtifactCount: 16
  },
  trace: {
    correlationId: "corr-demo-001",
    parentDispatchId: "dispatch-parent-000"
  }
} satisfies ExecutionEnvelopeInput;

/**
 * Locked digest for exampleExecutionEnvelopeInput after schema parse + canonical hash.
 * Update only when the fixture or canonicalization rules intentionally change.
 */
export const exampleExecutionEnvelopeDigest =
  "envelope:sha256:1b9a03f48542080bfdb243317fb1b16b976f892e1d3d8fe6464a499a1323d971";

/** Fixed pre-v2 payload used to prove persisted v1 replay byte-for-byte. */
export const exampleExecutionEnvelopeV1Input = {
  protocolVersion: 1,
  execution: {
    dispatchId: "dispatch-demo-001",
    attemptId: "attempt-001"
  },
  projectId: "project-demo",
  canvasId: "default",
  taskId: "FND-001",
  blockRef: "FND-001#B-002",
  blockType: "implementation" as const,
  sourceRevision: "pgv-pkg-demo-revision-001",
  graphFingerprint: "graph-fp-demo-001",
  renderedPrompt:
    "# Define and hash the portable Execution Envelope\n\nImplement a strict envelope.",
  acceptance: [
    "Envelope is bounded and content-addressed",
    "Forbidden Coordinator-local fields are rejected by schema shape"
  ],
  dependencySummaries: [
    {
      blockRef: "FND-001#B-001",
      outcome: "completed" as const,
      summary: "Created schema-only agent-host-protocol package.",
      reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
    }
  ],
  inputArtifacts: [
    {
      artifactRef: `artifact:sha256:${"c".repeat(64)}`,
      logicalName: "upstream-report",
      mediaType: "text/markdown"
    }
  ],
  workspaceId: "workspace.planweave-core",
  agentId: "codex",
  agentProfileId: "acp.codex",
  session: {
    modeId: "default",
    configOptions: [{ optionId: "model", valueId: "default" }]
  },
  requiredCapabilities: ["linux", "acp.codex", "workspace.git"],
  output: {
    reportRequired: true,
    maxArtifactBytes: 1_048_576,
    maxArtifactCount: 16
  },
  trace: {
    correlationId: "corr-demo-001",
    parentDispatchId: "dispatch-parent-000"
  }
} satisfies ExecutionEnvelopeInput;

export const exampleExecutionEnvelopeV1Digest =
  "envelope:sha256:4e2d0ec6f0e9db7f3663c3ca5642a19c2647f1d40f39a401b48d5bf8b78da43d";
