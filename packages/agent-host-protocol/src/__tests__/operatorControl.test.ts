import { describe, expect, it } from "vitest";
import {
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorHostRenewalRequestSchema,
  operatorHostPageSchema,
  operatorOwnerTerminalResultMetadataSchema,
  operatorPageQuerySchema,
  operatorTokenSchema
} from "../index.js";

describe("operator control wire contracts", () => {
  it("bounds credentials, pagination, and Host pages", () => {
    expect(() => operatorTokenSchema.parse("short")).toThrow();
    expect(operatorTokenSchema.parse("operator_token_abcdefghijklmnopqrstuvwxyz_1234")).toContain(
      "operator_token"
    );
    expect(operatorPageQuerySchema.parse({ cursor: "10", limit: "100" })).toEqual({
      cursor: 10,
      limit: 100
    });
    expect(() => operatorPageQuerySchema.parse({ cursor: 0, limit: 101 })).toThrow();
    expect(
      operatorHostPageSchema.parse({
        items: [
          {
            id: "host-1",
            workspaceId: "workspace-1",
            displayName: "Host",
            capabilities: [],
            capacity: 1,
            online: false,
            availability: { status: "unavailable", reason: "offline" }
          }
        ],
        nextCursor: null
      }).items[0]?.online
    ).toBe(false);
    expect(
      operatorHostPageSchema.parse({
        items: [
          {
            id: "host-fleet",
            displayName: "Fleet Host",
            capabilities: [],
            capacity: 1,
            online: true,
            availability: { status: "available", reason: null }
          }
        ],
        nextCursor: null
      }).items[0]?.workspaceId
    ).toBeUndefined();
    expect(() =>
      operatorHostPageSchema.parse({
        items: [
          {
            id: "host-1",
            workspaceId: "workspace-1",
            displayName: "Host",
            capabilities: [],
            capacity: 1,
            online: false,
            availability: { status: "unavailable", reason: "offline" },
            unexpected: true
          }
        ],
        nextCursor: null
      })
    ).toThrow();
  });

  it("rejects malformed enrollment grant dates and extra fields", () => {
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        expiresAt: "not-a-date",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        expiresAt: "2030-01-01T00:00:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        operatorToken: "operator_token_abcdefghijklmnopqrstuvwxyz_1234"
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        expiresAt: "2030-01-01T00:00:00.000Z",
        credentialPolicy: { lifetimeDays: 181, renewal: "automatic" }
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantResponseSchema.parse({
        enrollmentCode: "pw_enroll_one_time",
        expiresAt: "2030-01-01T00:15:00.000Z"
      })
    ).toThrow();
    expect(
      operatorEnrollmentGrantResponseSchema.parse({
        enrollmentCode: `pw_enroll_${"A".repeat(43)}`,
        expiresAt: "2030-01-01T00:15:00.000Z",
        credentialExpiresAt: "2030-06-30T00:00:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }).enrollmentCode
    ).toBe(`pw_enroll_${"A".repeat(43)}`);
    expect(
      operatorEnrollmentGrantResponseSchema.parse({
        enrollmentCode: `pw_enroll_${"A".repeat(43)}`,
        workspaceId: "workspace-1",
        expiresAt: "2030-01-01T00:15:00.000Z",
        credentialExpiresAt: "2030-06-30T00:00:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }).workspaceId
    ).toBe("workspace-1");
    expect(operatorHostRenewalRequestSchema.parse({})).toEqual({});
    expect(() => operatorHostRenewalRequestSchema.parse({ lifetimeDays: 180 })).toThrow();
  });

  it("defaults an explicitly owned Remote Agent to unrestricted access", () => {
    const base = {
      expiresAt: "2030-01-01T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" as const }
    };
    expect(operatorEnrollmentGrantRequestSchema.parse(base)).toEqual(base);
    expect(
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        ownerHumanPrincipalId: "owner-human-1",
        accessMode: "unrestricted"
      })
    ).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    expect(
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        workspaceId: "workspace-1",
        ownerHumanPrincipalId: "owner-human-1",
        accessMode: "workspace_restricted",
        createWorkspaceGrant: true
      })
    ).toMatchObject({ createWorkspaceGrant: true, workspaceId: "workspace-1" });
    expect(
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        ownerHumanPrincipalId: "owner-human-1"
      })
    ).toMatchObject({ ownerHumanPrincipalId: "owner-human-1" });
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        accessMode: "unrestricted"
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        ownerHumanPrincipalId: "owner-human-1",
        accessMode: "workspace_restricted",
        createWorkspaceGrant: true
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        ...base,
        workspaceId: "workspace-1",
        createWorkspaceGrant: true
      })
    ).toThrow();
  });

  it("owns the strict Owner terminal-result transport metadata contract", () => {
    const metadata = {
      operationId: "operation-owner-1",
      projectId: "project-owner-1",
      canvasId: "canvas-owner-1",
      blockRef: "T-001#B-001",
      controlPlane: "owner" as const,
      sourceRevision: "source-revision-1",
      graphFingerprint: `pkg-${"a".repeat(64)}`,
      dispatchId: "dispatch-owner-1",
      executionAttemptId: "attempt-owner-1",
      reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
    };
    expect(operatorOwnerTerminalResultMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() =>
      operatorOwnerTerminalResultMetadataSchema.parse({ ...metadata, controlPlane: "workspace" })
    ).toThrow();
    expect(() =>
      operatorOwnerTerminalResultMetadataSchema.parse({ ...metadata, reportBytes: "private" })
    ).toThrow();
  });
});
