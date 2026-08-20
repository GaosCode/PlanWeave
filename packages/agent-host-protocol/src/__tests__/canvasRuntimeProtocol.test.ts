import { describe, expect, it } from "vitest";
import {
  CANVAS_RUNTIME_CAPABILITY,
  CANVAS_RUNTIME_JSON_MAX_ARRAY_ITEMS,
  CANVAS_RUNTIME_JSON_MAX_BYTES,
  CANVAS_RUNTIME_JSON_MAX_DEPTH,
  CANVAS_RUNTIME_JSON_MAX_STRING_LENGTH,
  canvasRuntimeArtifactMetadataSchema,
  canvasRuntimeArtifactTransferInputSchema,
  canvasRuntimeCancelCommandSchema,
  canvasRuntimeJsonValueSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponseEventSchema,
  capabilitySchema,
  hostEventSchema,
  hasCanvasRuntimeCapability,
  hostHelloSchema,
  mailboxCommandSchema,
  serverToHostCommandSchema
} from "../index.js";

const scope = { workspaceId: "workspace-a", projectId: "project-a", canvasId: "canvas-a" };
const deadline = "2030-01-01T00:00:00.000Z";
const evidence = {
  operationId: "operation-a",
  sourceRevision: "revision-a",
  graphFingerprint: `pkg-${"a".repeat(64)}`
};

function request(operation: Record<string, unknown>) {
  return {
    type: "canvas_runtime.request",
    protocolVersion: 1,
    requestId: "runtime-request-a",
    scope,
    deadline,
    operation
  };
}

function response(response: Record<string, unknown>, requestId = "runtime-request-a") {
  return {
    type: "canvas_runtime.response",
    protocolVersion: 1,
    messageId: "runtime-response-message-a",
    requestId,
    response
  };
}

describe("Canvas Runtime control protocol", () => {
  it("uses one versioned capability and independent Runtime identities", () => {
    expect(CANVAS_RUNTIME_CAPABILITY).toBe("canvas-runtime.v1");
    expect(capabilitySchema.parse(CANVAS_RUNTIME_CAPABILITY)).toBe(CANVAS_RUNTIME_CAPABILITY);
    expect(hasCanvasRuntimeCapability(["acp.codex", CANVAS_RUNTIME_CAPABILITY])).toBe(true);
    expect(hasCanvasRuntimeCapability(["acp.codex"])).toBe(false);
    expect(
      serverToHostCommandSchema.parse(
        request({
          operation: "claim",
          runtimeLeaseId: "runtime-lease-a",
          evidence,
          input: { ref: "T-001#B-001" }
        })
      )
    ).toMatchObject({
      requestId: "runtime-request-a",
      operation: { runtimeLeaseId: "runtime-lease-a", evidence }
    });
  });

  it("accepts every strict request operation through the durable mailbox union", () => {
    const leasedInputOperations = [
      "claim",
      "activate",
      "mark_interrupted",
      "resume_attempt",
      "retry_attempt",
      "complete",
      "fail"
    ] as const;
    const commands = [
      request({ operation: "availability" }),
      request({
        operation: "acquire",
        expectedEvidence: {
          sourceRevision: evidence.sourceRevision,
          graphFingerprint: evidence.graphFingerprint
        }
      }),
      request({ operation: "status", runtimeLeaseId: "runtime-lease-a" }),
      request({ operation: "inspect", runtimeLeaseId: "runtime-lease-a", input: { ref: "b" } }),
      ...leasedInputOperations.map((operation) =>
        request({ operation, runtimeLeaseId: "runtime-lease-a", evidence, input: { ref: "b" } })
      ),
      request({
        operation: "query",
        runtimeLeaseId: "runtime-lease-a",
        operationId: evidence.operationId,
        input: { ref: "b", operationId: evidence.operationId }
      }),
      request({
        operation: "reconcile",
        runtimeLeaseId: "runtime-lease-a",
        operationId: evidence.operationId,
        input: { ref: "b", operationId: evidence.operationId }
      }),
      request({
        operation: "artifact_read",
        runtimeLeaseId: "runtime-lease-a",
        sourceRevision: evidence.sourceRevision,
        input: { artifactRef: `artifact:sha256:${"a".repeat(64)}` }
      }),
      request({ operation: "release", runtimeLeaseId: "runtime-lease-a" })
    ];

    for (const command of commands) {
      expect(mailboxCommandSchema.parse(command)).toEqual(command);
    }
    expect(commands).toHaveLength(15);
  });

  it("keeps cancellation separate from ACP leases and correlates its durable response", () => {
    const command = {
      type: "canvas_runtime.cancel",
      protocolVersion: 1,
      requestId: "cancel-request-a",
      targetRequestId: "runtime-request-a",
      scope,
      deadline
    };
    expect(canvasRuntimeCancelCommandSchema.parse(command)).toEqual(command);
    expect(
      hostEventSchema.parse(
        response(
          {
            outcome: "success",
            operation: "cancel",
            result: { targetRequestId: "runtime-request-a", cancelled: true }
          },
          "cancel-request-a"
        )
      )
    ).toMatchObject({ requestId: "cancel-request-a", messageId: "runtime-response-message-a" });
    expect(() =>
      canvasRuntimeCancelCommandSchema.parse({
        ...command,
        requestId: command.targetRequestId
      })
    ).toThrow("must have its own request identity");
  });

  it("defines availability, acquire, release, and error results without binary payloads", () => {
    expect(
      canvasRuntimeResponseEventSchema.parse(
        response({
          outcome: "success",
          operation: "availability",
          result: {
            kind: "available",
            status: { phase: "ready" },
            sourceRevision: evidence.sourceRevision,
            graphFingerprint: evidence.graphFingerprint
          }
        })
      )
    ).toMatchObject({ requestId: "runtime-request-a" });
    expect(
      canvasRuntimeResponseEventSchema.parse(
        response({
          outcome: "success",
          operation: "acquire",
          result: {
            runtimeLeaseId: "runtime-lease-a",
            sourceRevision: evidence.sourceRevision,
            graphFingerprint: evidence.graphFingerprint,
            acquiredAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:01:00.000Z"
          }
        })
      )
    ).toMatchObject({ response: { operation: "acquire" } });
    expect(
      canvasRuntimeResponseEventSchema.parse(
        response({ outcome: "success", operation: "release", result: { released: true } })
      )
    ).toMatchObject({ response: { operation: "release" } });
    expect(
      canvasRuntimeResponseEventSchema.parse(
        response({
          outcome: "error",
          operation: "complete",
          error: {
            code: "runtime_deadline_exceeded",
            message: "The Runtime request exceeded its deadline.",
            retryable: false,
            reconcileRequired: true
          }
        })
      )
    ).toMatchObject({ response: { outcome: "error" } });
  });

  it("rejects unknown operations, extra fields, bad identities, deadlines, and evidence", () => {
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(request({ operation: "write_file" }))
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse({
        ...request({ operation: "availability" }),
        projectRoot: "/private/project"
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse({
        ...request({ operation: "availability" }),
        requestId: "/tmp/request"
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse({
        ...request({ operation: "availability" }),
        scope: { ...scope, projectId: "../project" }
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse({
        ...request({ operation: "availability" }),
        deadline: "tomorrow"
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse({
        ...request({ operation: "availability" }),
        protocolVersion: 2
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(
        request({
          operation: "acquire",
          expectedEvidence: { sourceRevision: evidence.sourceRevision, graphFingerprint: "fp-a" }
        })
      )
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(
        request({
          operation: "claim",
          runtimeLeaseId: "runtime-lease-a",
          evidence: { ...evidence, sourceRevision: "/Users/private/project" },
          input: {}
        })
      )
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(
        request({
          operation: "complete",
          runtimeLeaseId: "runtime-lease-a",
          evidence,
          input: { operationId: "another-operation" }
        })
      )
    ).toThrow("operationId must match");
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(
        request({ operation: "claim", runtimeLeaseId: "runtime-lease-a", input: {} })
      )
    ).toThrow();
    expect(() =>
      canvasRuntimeRequestCommandSchema.parse(
        request({
          operation: "artifact_read",
          runtimeLeaseId: "runtime-lease-a",
          sourceRevision: evidence.sourceRevision,
          input: { sourceRevision: "revision-b" }
        })
      )
    ).toThrow("sourceRevision must match");
  });

  it("bounds domain JSON and rejects binary, dangerous keys, and excessive nesting", () => {
    expect(canvasRuntimeJsonValueSchema.parse({ ref: "T-001#B-001", flags: [true, null] })).toEqual(
      {
        ref: "T-001#B-001",
        flags: [true, null]
      }
    );
    expect(() => canvasRuntimeJsonValueSchema.parse(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() =>
      canvasRuntimeJsonValueSchema.parse(JSON.parse('{"__proto__":{"polluted":true}}'))
    ).toThrow("forbidden key");
    expect(() =>
      canvasRuntimeJsonValueSchema.parse("x".repeat(CANVAS_RUNTIME_JSON_MAX_STRING_LENGTH + 1))
    ).toThrow();
    expect(() =>
      canvasRuntimeJsonValueSchema.parse(
        Array.from({ length: CANVAS_RUNTIME_JSON_MAX_ARRAY_ITEMS + 1 }, () => null)
      )
    ).toThrow();
    const stringsWithinIndividualLimit = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `field-${index}`,
        "x".repeat(CANVAS_RUNTIME_JSON_MAX_STRING_LENGTH)
      ])
    );
    expect(
      new TextEncoder().encode(JSON.stringify(stringsWithinIndividualLimit)).byteLength
    ).toBeGreaterThan(CANVAS_RUNTIME_JSON_MAX_BYTES);
    expect(() => canvasRuntimeJsonValueSchema.parse(stringsWithinIndividualLimit)).toThrow(
      "payload is too large"
    );
    let nested: unknown = "leaf";
    for (let index = 0; index <= CANVAS_RUNTIME_JSON_MAX_DEPTH; index += 1) nested = [nested];
    expect(() => canvasRuntimeJsonValueSchema.parse(nested)).toThrow();
  });

  it("binds artifact metadata to its digest and rejects bytes or base64 side channels", () => {
    const sha256 = "a".repeat(64);
    const metadata = {
      artifactRef: `artifact:sha256:${sha256}`,
      sha256,
      sizeBytes: 42,
      mediaType: "text/plain"
    };
    expect(canvasRuntimeArtifactMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() =>
      canvasRuntimeArtifactMetadataSchema.parse({ ...metadata, sha256: "b".repeat(64) })
    ).toThrow("must match its digest");
    expect(() =>
      canvasRuntimeArtifactMetadataSchema.parse({ ...metadata, bytes: new Uint8Array([1]) })
    ).toThrow();
    expect(() =>
      canvasRuntimeArtifactMetadataSchema.parse({ ...metadata, base64: "c2VjcmV0" })
    ).toThrow();
    expect(() =>
      canvasRuntimeArtifactMetadataSchema.parse({ ...metadata, sizeBytes: Number.MAX_SAFE_INTEGER })
    ).toThrow("must not exceed");
  });

  it("strictly binds Runtime artifact transfer descriptors without URLs or bytes", () => {
    const sha256 = "a".repeat(64);
    const transfer = {
      version: "canvas-runtime-artifact-transfer/v1",
      grantId: "runtime-artifact-grant-a",
      direction: "download",
      runtimeLeaseId: "runtime-lease-a",
      artifactRef: `artifact:sha256:${sha256}`,
      sha256,
      sizeBytes: 42,
      mediaType: "text/plain",
      expiresAt: deadline
    };
    expect(
      canvasRuntimeArtifactTransferInputSchema.parse({
        domainInput: { ref: "T-001#B-001" },
        transfer
      })
    ).toMatchObject({ transfer });
    expect(() =>
      canvasRuntimeArtifactTransferInputSchema.parse({
        domainInput: {},
        transfer: { ...transfer, artifactRef: `artifact:sha256:${"b".repeat(64)}` }
      })
    ).toThrow("must match its digest");
    for (const forbidden of [
      { url: "https://server.invalid/private" },
      { path: "/private/runtime/report.md" },
      { bytes: new Uint8Array([1]) },
      { base64: "c2VjcmV0" }
    ]) {
      expect(() =>
        canvasRuntimeArtifactTransferInputSchema.parse({
          domainInput: {},
          transfer: { ...transfer, ...forbidden }
        })
      ).toThrow();
    }
  });

  it("adds optional path-free Runtime project readiness without changing old observations", () => {
    const oldHello = {
      type: "host.hello",
      protocolVersion: 1,
      lastAcknowledgedSequence: 0,
      capabilities: [],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [] }
    };
    expect(hostHelloSchema.parse(oldHello)).toEqual(oldHello);
    expect(
      hostHelloSchema.parse({
        ...oldHello,
        capabilities: [CANVAS_RUNTIME_CAPABILITY],
        readiness: {
          ...oldHello.readiness,
          runtimeProjects: [{ workspaceId: "workspace-a", projectId: "project-a", status: "ready" }]
        }
      }).readiness?.runtimeProjects
    ).toEqual([{ workspaceId: "workspace-a", projectId: "project-a", status: "ready" }]);
    expect(() =>
      hostHelloSchema.parse({
        ...oldHello,
        readiness: {
          ...oldHello.readiness,
          runtimeProjects: [
            {
              workspaceId: "workspace-a",
              projectId: "project-a",
              status: "ready",
              path: "/private/project"
            }
          ]
        }
      })
    ).toThrow();
  });
});
