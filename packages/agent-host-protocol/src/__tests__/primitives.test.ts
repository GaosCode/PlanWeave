import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_MAX_COUNT,
  CAPABILITY_MAX_LENGTH,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH,
  OPAQUE_IDENTIFIER_MAX_LENGTH,
  agentHostProtocolVersion,
  agentHostProtocolVersionSchema,
  artifactRefSchema,
  capabilitiesSchema,
  capabilitySchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  executionIdentitySchema,
  leaseIdSchema,
  leaseIdentitySchema,
  mailboxDeliveredSequenceSchema,
  mailboxIdentitySchema,
  mailboxMessageIdSchema,
  mailboxSequenceSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema,
  userRequiredCapabilitiesSchema
} from "../index.js";

const validSha256 = "a".repeat(64);
const validArtifactRef = `artifact:sha256:${validSha256}`;

function expectZodRejects(parse: () => unknown): void {
  expect(parse).toThrow();
}

describe("opaque identifiers", () => {
  it("accepts bounded portable identifiers", () => {
    expect(opaqueIdentifierSchema.parse("host-1")).toBe("host-1");
    expect(opaqueIdentifierSchema.parse("Dispatch:abc_01")).toBe("Dispatch:abc_01");
    expect(opaqueIdentifierSchema.parse("a".repeat(OPAQUE_IDENTIFIER_MAX_LENGTH))).toHaveLength(
      OPAQUE_IDENTIFIER_MAX_LENGTH
    );
  });

  it("rejects empty, oversized, and path-like values", () => {
    expectZodRejects(() => opaqueIdentifierSchema.parse(""));
    expectZodRejects(() =>
      opaqueIdentifierSchema.parse("a".repeat(OPAQUE_IDENTIFIER_MAX_LENGTH + 1))
    );
    expectZodRejects(() => opaqueIdentifierSchema.parse("/tmp/workspace"));
    expectZodRejects(() => opaqueIdentifierSchema.parse("../escape"));
    expectZodRejects(() => opaqueIdentifierSchema.parse("has space"));
    expectZodRejects(() => opaqueIdentifierSchema.parse("-leading-dash"));
  });
});

describe("capabilities", () => {
  it("accepts unique lowercase capability tokens and rejects duplicates", () => {
    expect(capabilitySchema.parse("acp.codex")).toBe("acp.codex");
    expect(capabilitiesSchema.parse(["node", "acp.codex", "git.read"])).toEqual([
      "node",
      "acp.codex",
      "git.read"
    ]);
    expectZodRejects(() => capabilitiesSchema.parse(["node", "acp.codex", "node"]));
    expectZodRejects(() =>
      userRequiredCapabilitiesSchema.parse(["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY])
    );
  });

  it("rejects uppercase, path-like, oversized tokens, and over-count lists", () => {
    expectZodRejects(() => capabilitySchema.parse("ACP"));
    expectZodRejects(() => capabilitySchema.parse("/usr/bin/node"));
    expectZodRejects(() => capabilitySchema.parse("a".repeat(CAPABILITY_MAX_LENGTH + 1)));
    expectZodRejects(() =>
      capabilitiesSchema.parse(
        Array.from({ length: CAPABILITIES_MAX_COUNT + 1 }, (_, i) => `c${i}`)
      )
    );
  });
});

describe("block references", () => {
  it("rejects absolute, separated, and traversal-like segments", async () => {
    const { blockRefSchema } = await import("../index.js");
    expect(blockRefSchema.parse("FND-001#B-002")).toBe("FND-001#B-002");
    for (const ref of [
      "FND-001#/tmp/secret",
      "FND-001#..\\secret",
      "FND-001#../secret",
      "FND-001#.",
      "FND-001#..",
      "/tmp/task#B-001"
    ]) {
      expectZodRejects(() => blockRefSchema.parse(ref));
    }
  });
});

describe("artifact references", () => {
  it("accepts content-addressed sha256 refs only", () => {
    expect(artifactRefSchema.parse(validArtifactRef)).toBe(validArtifactRef);
  });

  it("rejects paths, uppercase digests, and wrong schemes", () => {
    expectZodRejects(() => artifactRefSchema.parse("/var/artifacts/report.md"));
    expectZodRejects(() => artifactRefSchema.parse(`artifact:sha256:${"A".repeat(64)}`));
    expectZodRejects(() => artifactRefSchema.parse(`sha256:${validSha256}`));
    expectZodRejects(() => artifactRefSchema.parse(`artifact:sha256:${"a".repeat(63)}`));
  });
});

describe("execution, mailbox, and lease identities", () => {
  it("parses branded identity parts and strict composite objects", () => {
    const dispatchId = dispatchIdSchema.parse("dispatch-1");
    const attemptId = executionAttemptIdSchema.parse("attempt-1");
    const leaseId = leaseIdSchema.parse("lease-1");
    const messageId = mailboxMessageIdSchema.parse("msg-1");

    expect(
      executionIdentitySchema.parse({
        dispatchId,
        attemptId
      })
    ).toEqual({ dispatchId, attemptId });

    expect(
      leaseIdentitySchema.parse({
        dispatchId,
        leaseId
      })
    ).toEqual({ dispatchId, leaseId });

    expect(
      mailboxIdentitySchema.parse({
        messageId,
        sequence: mailboxDeliveredSequenceSchema.parse(3)
      })
    ).toEqual({ messageId, sequence: 3 });

    expect(mailboxSequenceSchema.parse(0)).toBe(0);
  });

  it("rejects unknown fields on composite identity objects", () => {
    expectZodRejects(() =>
      executionIdentitySchema.parse({
        dispatchId: "dispatch-1",
        attemptId: "attempt-1",
        hostPath: "/tmp/workspace"
      })
    );
    expectZodRejects(() =>
      leaseIdentitySchema.parse({
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        token: "secret"
      })
    );
    expectZodRejects(() =>
      mailboxIdentitySchema.parse({
        messageId: "msg-1",
        sequence: 1,
        extra: true
      })
    );
  });

  it("rejects non-positive delivered sequences", () => {
    expectZodRejects(() => mailboxDeliveredSequenceSchema.parse(0));
    expectZodRejects(() => mailboxDeliveredSequenceSchema.parse(-1));
  });
});

describe("normalized failure", () => {
  it("accepts bounded portable failures", () => {
    expect(
      normalizedFailureSchema.parse({
        code: "executor_failed",
        message: "ACP session ended with non-zero stop reason.",
        retryable: true
      })
    ).toEqual({
      code: "executor_failed",
      message: "ACP session ended with non-zero stop reason.",
      retryable: true
    });
  });

  it("rejects unknown fields and oversized messages", () => {
    expectZodRejects(() =>
      normalizedFailureSchema.parse({
        code: "executor_failed",
        message: "boom",
        retryable: false,
        stack: "/Users/local/secret.ts:1"
      })
    );
    expectZodRejects(() =>
      normalizedFailureSchema.parse({
        code: "executor_failed",
        message: "x".repeat(NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH + 1),
        retryable: false
      })
    );
  });
});

describe("protocol version", () => {
  it("pins the current agent-host protocol version", () => {
    expect(agentHostProtocolVersion).toBe(1);
    expect(agentHostProtocolVersionSchema.parse(1)).toBe(1);
    expectZodRejects(() => agentHostProtocolVersionSchema.parse(2));
    expectZodRejects(() => agentHostProtocolVersionSchema.parse("1"));
  });
});
