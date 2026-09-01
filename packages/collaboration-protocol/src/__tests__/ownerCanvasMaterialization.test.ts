import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "../contentVersion.js";
import {
  ownerCanvasMaterializationRequestSchema,
  ownerCanvasMaterializationUploadFrameSchema,
  ownerCanvasMaterializationUploadLimits
} from "../ownerCanvasMaterialization.js";
import { describe, expect, it } from "vitest";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function content(): CompleteContentVersion {
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content:
        '{"version":"desktop-layout/v1","projectId":"project-a","nodes":[],"updatedAt":"2026-01-01T00:00:00.000Z"}'
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content:
        '{"version":"plan-package/v1","project":{"title":"Plan","description":""},"execution":{"parallel":{"enabled":false,"maxConcurrent":1}},"review":{"maxFeedbackCycles":1,"completionPolicy":"strict"},"executors":{},"nodes":[],"edges":[]}'
    }
  ]
    .map((member) => ({
      ...member,
      digestSha256: sha256(member.content),
      sizeBytes: Buffer.byteLength(member.content)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((total, member) => total + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({
        members,
        totalBytes,
        canonicalDigest: "0".repeat(64)
      })
    )
  };
}

describe("owner Canvas materialization protocol", () => {
  it("keeps the public scope free of workspace locators and accepts complete content", () => {
    const parsed = ownerCanvasMaterializationRequestSchema.parse({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope: {
        ownerHumanPrincipalId: "human-owner",
        projectId: "project-a",
        canvasId: "default"
      },
      expectedHead: { kind: "absent" },
      content: content()
    });

    expect(parsed.scope).not.toHaveProperty("workspaceId");
    expect(parsed.content.canonicalDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an internal workspace locator and validates framed upload ordering fields", () => {
    const request = {
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope: {
        ownerHumanPrincipalId: "human-owner",
        projectId: "project-a",
        canvasId: "default",
        workspaceId: "secret-runtime-workspace"
      },
      expectedHead: { kind: "absent" },
      content: content()
    };
    expect(ownerCanvasMaterializationRequestSchema.safeParse(request).success).toBe(false);
    expect(
      ownerCanvasMaterializationUploadFrameSchema.parse({
        type: "member",
        index: 0,
        member: content().members[0]
      })
    ).toMatchObject({ type: "member", index: 0 });
    expect(ownerCanvasMaterializationUploadLimits.maxWireBytes).toBeGreaterThan(64 * 1024);
  });
});
