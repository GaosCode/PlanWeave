import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hostEnrollmentCompletedSchema,
  hostEnrollmentErrorSchema,
  hostEnrollmentRequestSchema
} from "../index.js";

const secret = (prefix: "pw_enroll_" | "pw_host_") =>
  `${prefix}${randomBytes(32).toString("base64url")}`;

function request() {
  return {
    type: "host.enrollment.request",
    protocolVersion: agentHostProtocolVersion,
    enrollmentCode: secret("pw_enroll_"),
    enrollmentAttemptId: "attempt-enrollment-001",
    installationId: "4b3ba96d-0f84-4cf4-aac5-87ef90f58ec2",
    supersedesHostId: "host-enrolled-previous",
    credentialToken: secret("pw_host_"),
    displayName: "Build Host",
    capabilities: ["linux", "workspace.git"],
    capacity: 2
  };
}

describe("Agent Host enrollment protocol", () => {
  it("parses bounded request, completion, and error contracts", () => {
    expect(hostEnrollmentRequestSchema.parse(request()).displayName).toBe("Build Host");
    expect(
      hostEnrollmentCompletedSchema.parse({
        type: "host.enrollment.completed",
        protocolVersion: agentHostProtocolVersion,
        enrollmentAttemptId: "attempt-enrollment-001",
        hostId: "host-enrolled-001",
        workspaceId: "workspace-enrolled-001",
        credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }).hostId
    ).toBe("host-enrolled-001");
    expect(
      hostEnrollmentCompletedSchema.parse({
        type: "host.enrollment.completed",
        protocolVersion: agentHostProtocolVersion,
        enrollmentAttemptId: "attempt-enrollment-001",
        hostId: "host-enrolled-001",
        credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }).workspaceId
    ).toBeUndefined();
    expect(
      hostEnrollmentErrorSchema.parse({
        type: "host.enrollment.error",
        protocolVersion: agentHostProtocolVersion,
        code: "conflict",
        message: "Enrollment request conflicts with a prior attempt.",
        retryable: false
      }).code
    ).toBe("conflict");
  });

  it("rejects unknown fields, duplicate capabilities, and invalid capacity or secrets", () => {
    expect(
      hostEnrollmentRequestSchema.safeParse({ ...request(), command: "/bin/sh" }).success
    ).toBe(false);
    expect(
      hostEnrollmentRequestSchema.safeParse({ ...request(), capabilities: ["linux", "linux"] })
        .success
    ).toBe(false);
    expect(hostEnrollmentRequestSchema.safeParse({ ...request(), capacity: 0 }).success).toBe(
      false
    );
    expect(
      hostEnrollmentRequestSchema.safeParse({ ...request(), enrollmentCode: "secret" }).success
    ).toBe(false);
    expect(
      hostEnrollmentRequestSchema.safeParse({ ...request(), installationId: "not-a-uuid" }).success
    ).toBe(false);
  });
});
