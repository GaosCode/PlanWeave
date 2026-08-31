import { describe, expect, it } from "vitest";
import {
  agentHostProtocolGoldenFixtures,
  hostEventSchema,
  hostHelloSchema,
  interactionSettlementSchema,
  normalizedAcpEventBatchSchema,
  parseInteractionSettlementForRequest,
  serverEventSchema
} from "../index.js";

describe("versioned Agent Host protocol", () => {
  it("parses every golden fixture through its owning strict schema", () => {
    expect(hostHelloSchema.parse(agentHostProtocolGoldenFixtures.hello)).toEqual(
      agentHostProtocolGoldenFixtures.hello
    );
    expect(serverEventSchema.parse(agentHostProtocolGoldenFixtures.executeDelivery)).toEqual(
      agentHostProtocolGoldenFixtures.executeDelivery
    );
    expect(serverEventSchema.parse(agentHostProtocolGoldenFixtures.resumeDelivery)).toEqual(
      agentHostProtocolGoldenFixtures.resumeDelivery
    );
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.acpEventBatch)).toEqual(
      agentHostProtocolGoldenFixtures.acpEventBatch
    );
    expect(() =>
      hostEventSchema.parse(agentHostProtocolGoldenFixtures.legacyAcpEventBatchV1)
    ).toThrow();
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.interrupted)).toEqual(
      agentHostProtocolGoldenFixtures.interrupted
    );
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.authenticationRequired)).toEqual(
      agentHostProtocolGoldenFixtures.authenticationRequired
    );
    expect(
      interactionSettlementSchema.parse(agentHostProtocolGoldenFixtures.authenticationSettlement)
    ).toEqual(agentHostProtocolGoldenFixtures.authenticationSettlement);
  });

  it("rejects unsupported versions, unknown fields, and mismatched execution identity", () => {
    expect(() =>
      hostHelloSchema.parse({ ...agentHostProtocolGoldenFixtures.hello, protocolVersion: 2 })
    ).toThrow("Unsupported Agent Host protocol version");
    expect(() =>
      serverEventSchema.parse({ ...agentHostProtocolGoldenFixtures.executeDelivery, secret: "no" })
    ).toThrow();
    expect(() =>
      serverEventSchema.parse({
        ...agentHostProtocolGoldenFixtures.executeDelivery,
        command: {
          ...agentHostProtocolGoldenFixtures.executeDelivery.command,
          executionAttemptId: "different-attempt"
        }
      })
    ).toThrow("Command identity must match the Execution Envelope");
  });

  it("accepts only redacted target-machine readiness observations", () => {
    expect(
      hostHelloSchema.parse({
        ...agentHostProtocolGoldenFixtures.hello,
        readiness: {
          workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
          acpProfiles: [
            {
              profileId: "codex-acp",
              agentId: "codex",
              displayName: "Codex",
              status: "ready",
              capabilities: ["acp.codex"]
            }
          ]
        }
      }).readiness
    ).toEqual({
      workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    expect(() =>
      hostHelloSchema.parse({
        ...agentHostProtocolGoldenFixtures.hello,
        readiness: {
          workspaceMappings: [{ workspaceId: "workspace-a", status: "ready", path: "/secret" }],
          acpProfiles: []
        }
      })
    ).toThrow();
  });

  it("rejects an execute command whose digest does not bind its canonical envelope", () => {
    expect(() =>
      serverEventSchema.parse({
        ...agentHostProtocolGoldenFixtures.executeDelivery,
        command: {
          ...agentHostProtocolGoldenFixtures.executeDelivery.command,
          envelopeDigest: `envelope:sha256:${"0".repeat(64)}`
        }
      })
    ).toThrow("envelopeDigest must match");
  });

  it("enforces monotonic contiguous ACP event cursors", () => {
    const {
      protocolVersion: _protocolVersion,
      messageId: _messageId,
      ...batch
    } = agentHostProtocolGoldenFixtures.legacyAcpEventBatchV1;
    expect(() =>
      normalizedAcpEventBatchSchema.parse({
        ...batch,
        events: [
          agentHostProtocolGoldenFixtures.legacyAcpEventBatchV1.events[0],
          { ...agentHostProtocolGoldenFixtures.legacyAcpEventBatchV1.events[1], cursor: 3 }
        ],
        cursor: 3
      })
    ).toThrow("ACP event cursors must be contiguous and monotonic");
  });

  it("never accepts secret material in authentication settlement", () => {
    expect(() =>
      interactionSettlementSchema.parse({
        ...agentHostProtocolGoldenFixtures.authenticationSettlement,
        token: "secret"
      })
    ).toThrow();
  });

  it("rejects stale leases and mismatched action identities during settlement", () => {
    const {
      protocolVersion: _protocolVersion,
      messageId: _messageId,
      ...request
    } = agentHostProtocolGoldenFixtures.authenticationRequired;
    expect(() =>
      parseInteractionSettlementForRequest(request, {
        ...agentHostProtocolGoldenFixtures.authenticationSettlement,
        leaseId: "stale-lease"
      })
    ).toThrow("interaction_identity_mismatch");
    expect(() =>
      parseInteractionSettlementForRequest(request, {
        ...agentHostProtocolGoldenFixtures.authenticationSettlement,
        actionId: "wrong-action"
      })
    ).toThrow("interaction_identity_mismatch");
    expect(() =>
      parseInteractionSettlementForRequest(request, {
        ...agentHostProtocolGoldenFixtures.authenticationSettlement,
        acpSessionId: "wrong-session"
      })
    ).toThrow("interaction_identity_mismatch");
  });
});
