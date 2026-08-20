import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_MAX_COUNT,
  CAPABILITY_MAX_LENGTH,
  CANVAS_RUNTIME_CAPABILITY,
  ARTIFACT_MEDIA_TYPE_MAX_LENGTH,
  NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH,
  OPAQUE_IDENTIFIER_MAX_LENGTH,
  EXECUTION_ENVELOPE_MAX_BYTES,
  agentHostProtocolVersion,
  agentHostProtocolVersionSchema,
  agentHostProtocolGoldenFixtures,
  artifactRefSchema,
  artifactMediaTypeSchema,
  capabilitiesSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponsePayloadSchema,
  capabilitySchema,
  dispatchIdSchema,
  hostEventSchema,
  hostHelloSchema,
  interactionSettlementSchema,
  executionAttemptIdSchema,
  executionIdentitySchema,
  executionEnvelopeSchema,
  exampleExecutionEnvelopeDigest,
  exampleExecutionEnvelopeInput,
  hashExecutionEnvelope,
  leaseIdSchema,
  leaseIdentitySchema,
  mailboxDeliveredSequenceSchema,
  mailboxIdentitySchema,
  mailboxMessageIdSchema,
  mailboxSequenceSchema,
  normalizedFailureSchema,
  observationEventSchema,
  opaqueIdentifierSchema,
  serverEventSchema,
  serverToHostCommandSchema
} from "../index.js";
import {
  DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS,
  CANVAS_RUNTIME_CAPABILITY as browserCanvasRuntimeCapability,
  canvasRuntimeRequestCommandSchema as browserCanvasRuntimeRequestCommandSchema,
  deploymentEndpointSchema,
  hostCredentialPolicySchema,
  isPrivateDeploymentHostname
} from "../browser.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

const publicRuntimeExports = {
  CAPABILITIES_MAX_COUNT,
  CAPABILITY_MAX_LENGTH,
  CANVAS_RUNTIME_CAPABILITY,
  ARTIFACT_MEDIA_TYPE_MAX_LENGTH,
  NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH,
  OPAQUE_IDENTIFIER_MAX_LENGTH,
  EXECUTION_ENVELOPE_MAX_BYTES,
  agentHostProtocolVersion,
  agentHostProtocolVersionSchema,
  agentHostProtocolGoldenFixtures,
  artifactRefSchema,
  artifactMediaTypeSchema,
  capabilitiesSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponsePayloadSchema,
  capabilitySchema,
  dispatchIdSchema,
  hostEventSchema,
  hostHelloSchema,
  interactionSettlementSchema,
  executionAttemptIdSchema,
  executionIdentitySchema,
  executionEnvelopeSchema,
  exampleExecutionEnvelopeDigest,
  exampleExecutionEnvelopeInput,
  hashExecutionEnvelope,
  leaseIdSchema,
  leaseIdentitySchema,
  mailboxDeliveredSequenceSchema,
  mailboxIdentitySchema,
  mailboxMessageIdSchema,
  mailboxSequenceSchema,
  normalizedFailureSchema,
  observationEventSchema,
  opaqueIdentifierSchema,
  serverEventSchema,
  serverToHostCommandSchema
} as const;

describe("public package exports", () => {
  it("exposes a stable schema surface for Server and Agent Host consumers", () => {
    expect(Object.keys(publicRuntimeExports).sort()).toEqual(
      [
        "CAPABILITIES_MAX_COUNT",
        "CAPABILITY_MAX_LENGTH",
        "CANVAS_RUNTIME_CAPABILITY",
        "ARTIFACT_MEDIA_TYPE_MAX_LENGTH",
        "NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH",
        "OPAQUE_IDENTIFIER_MAX_LENGTH",
        "EXECUTION_ENVELOPE_MAX_BYTES",
        "agentHostProtocolVersion",
        "agentHostProtocolVersionSchema",
        "agentHostProtocolGoldenFixtures",
        "artifactRefSchema",
        "artifactMediaTypeSchema",
        "capabilitiesSchema",
        "canvasRuntimeRequestCommandSchema",
        "canvasRuntimeResponsePayloadSchema",
        "capabilitySchema",
        "dispatchIdSchema",
        "hostEventSchema",
        "hostHelloSchema",
        "interactionSettlementSchema",
        "executionAttemptIdSchema",
        "executionIdentitySchema",
        "executionEnvelopeSchema",
        "exampleExecutionEnvelopeDigest",
        "exampleExecutionEnvelopeInput",
        "hashExecutionEnvelope",
        "leaseIdSchema",
        "leaseIdentitySchema",
        "mailboxDeliveredSequenceSchema",
        "mailboxIdentitySchema",
        "mailboxMessageIdSchema",
        "mailboxSequenceSchema",
        "normalizedFailureSchema",
        "observationEventSchema",
        "opaqueIdentifierSchema",
        "serverEventSchema",
        "serverToHostCommandSchema"
      ].sort()
    );

    expect(agentHostProtocolVersion).toBe(1);
    expect(OPAQUE_IDENTIFIER_MAX_LENGTH).toBe(128);
    expect(CAPABILITY_MAX_LENGTH).toBe(128);
    expect(CANVAS_RUNTIME_CAPABILITY).toBe("canvas-runtime.v1");
    expect(ARTIFACT_MEDIA_TYPE_MAX_LENGTH).toBe(255);
    expect(CAPABILITIES_MAX_COUNT).toBe(128);
    expect(NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH).toBe(16384);
    expect(typeof opaqueIdentifierSchema.parse).toBe("function");
    expect(typeof capabilitySchema.parse).toBe("function");
    expect(typeof capabilitiesSchema.parse).toBe("function");
    expect(typeof canvasRuntimeRequestCommandSchema.parse).toBe("function");
    expect(typeof canvasRuntimeResponsePayloadSchema.parse).toBe("function");
    expect(typeof artifactRefSchema.parse).toBe("function");
    expect(artifactMediaTypeSchema.parse("Text/Plain")).toBe("text/plain");
    expect(typeof dispatchIdSchema.parse).toBe("function");
    expect(typeof executionAttemptIdSchema.parse).toBe("function");
    expect(typeof executionIdentitySchema.parse).toBe("function");
    expect(typeof executionEnvelopeSchema.parse).toBe("function");
    expect(
      hashExecutionEnvelope(executionEnvelopeSchema.parse(exampleExecutionEnvelopeInput))
    ).toBe(exampleExecutionEnvelopeDigest);
    expect(typeof leaseIdSchema.parse).toBe("function");
    expect(typeof leaseIdentitySchema.parse).toBe("function");
    expect(typeof mailboxMessageIdSchema.parse).toBe("function");
    expect(typeof mailboxSequenceSchema.parse).toBe("function");
    expect(typeof mailboxDeliveredSequenceSchema.parse).toBe("function");
    expect(typeof mailboxIdentitySchema.parse).toBe("function");
    expect(typeof normalizedFailureSchema.parse).toBe("function");
    expect(typeof agentHostProtocolVersionSchema.parse).toBe("function");
    expect(hostHelloSchema.parse(agentHostProtocolGoldenFixtures.hello)).toEqual(
      agentHostProtocolGoldenFixtures.hello
    );
    expect(serverEventSchema.parse(agentHostProtocolGoldenFixtures.executeDelivery)).toEqual(
      agentHostProtocolGoldenFixtures.executeDelivery
    );
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.acpEventBatch)).toEqual(
      agentHostProtocolGoldenFixtures.acpEventBatch
    );
    expect(typeof serverToHostCommandSchema.parse).toBe("function");
    expect(typeof observationEventSchema.parse).toBe("function");
    expect(typeof interactionSettlementSchema.parse).toBe("function");
  });

  it("declares a schema-only package with zod as the only runtime dependency", () => {
    const packageJson = require(join(packageRoot, "package.json")) as {
      name: string;
      type: string;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports: Record<string, { types: string; import: string }>;
    };

    expect(packageJson.name).toBe("@planweave-ai/agent-host-protocol");
    expect(packageJson.type).toBe("module");
    expect(Object.keys(packageJson.dependencies)).toEqual(["zod"]);
    expect(packageJson.devDependencies ?? {}).toEqual({});
    expect(packageJson.exports["./browser"]).toEqual({
      types: "./dist/browser.d.ts",
      import: "./dist/browser.js"
    });
  });

  it("exposes browser-safe credential and deployment contracts", () => {
    expect(browserCanvasRuntimeCapability).toBe(CANVAS_RUNTIME_CAPABILITY);
    expect(typeof browserCanvasRuntimeRequestCommandSchema.parse).toBe("function");
    expect(DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS).toBe(180);
    expect(hostCredentialPolicySchema.parse({ lifetimeDays: 180, renewal: "automatic" })).toEqual({
      lifetimeDays: 180,
      renewal: "automatic"
    });
    expect(isPrivateDeploymentHostname("192.168.1.10")).toBe(true);
    expect(
      deploymentEndpointSchema.parse({
        topology: "private_https",
        serverOrigin: "https://192.168.1.10:7443",
        allowedClientOrigins: ["https://192.168.1.20:7443"],
        tlsTrust: "system_ca"
      })
    ).toMatchObject({ topology: "private_https" });
  });

  it("lets a minimal Agent Host consumer parse the same primitives as Server", () => {
    // Simulates an independently deployed Agent Host importing the shared package.
    const hostHelloCapabilities = capabilitiesSchema.parse(["acp.codex", "workspace.git"]);
    const lease = leaseIdentitySchema.parse({
      dispatchId: "dispatch-host-1",
      leaseId: "lease-host-1"
    });
    const failure = normalizedFailureSchema.parse({
      code: "cancelled",
      message: "Host cancelled after Coordinator request.",
      retryable: false
    });

    expect(hostHelloCapabilities).toEqual(["acp.codex", "workspace.git"]);
    expect(lease.dispatchId).toBe("dispatch-host-1");
    expect(failure.retryable).toBe(false);
    expect(agentHostProtocolVersionSchema.parse(agentHostProtocolVersion)).toBe(1);
  });
});
