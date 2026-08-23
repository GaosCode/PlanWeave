import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema
} from "@planweave-ai/collaboration-protocol/content/version";
import { contentVersionTransferMediaType } from "@planweave-ai/collaboration-protocol/content/transfer";
import { describe, expect, it, vi } from "vitest";
import { CanvasRuntimeContentTransfer } from "../runtime/canvasRuntimeContentTransfer.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("CanvasRuntimeContentTransfer", () => {
  it("uses only the Host credential and verifies the scoped immutable stream", async () => {
    const members = [
      {
        kind: "desktop_layout" as const,
        path: "desktop/layout.json",
        content: "{}",
        digestSha256: sha256("{}"),
        sizeBytes: 2
      },
      {
        kind: "manifest" as const,
        path: "manifest.json",
        content: "{}",
        digestSha256: sha256("{}"),
        sizeBytes: 2
      }
    ];
    const provisional = { members, totalBytes: 4, canonicalDigest: "0".repeat(64) };
    const content = completeContentVersionSchema.parse({
      ...provisional,
      canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
    });
    const completed = {
      versionId: `version-${content.canonicalDigest}`,
      canonicalDigest: content.canonicalDigest,
      verification: "complete" as const
    };
    const scope = { workspaceId: "workspace-a", projectId: "project-a", canvasId: "default" };
    const frames = [
      {
        type: "header",
        schemaVersion: "content-version/v1",
        scope,
        completed,
        canonicalDigest: content.canonicalDigest,
        totalBytes: 4,
        memberCount: 2,
        createdAt: "2030-01-01T00:00:00.000Z",
        createdBy: { kind: "system", id: "server" }
      },
      ...members.map((member, index) => ({ type: "member", index, member })),
      { type: "complete", canonicalDigest: content.canonicalDigest, totalBytes: 4, memberCount: 2 }
    ];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(
        `/agent-hosts/host-a/canvas-runtime/content/project-a/default/${completed.versionId}`
      );
      expect(url.searchParams.get("workspaceId")).toBe(scope.workspaceId);
      expect(url.searchParams.get("canonicalDigest")).toBe(content.canonicalDigest);
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer host-token-a",
        Accept: contentVersionTransferMediaType
      });
      return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
        headers: { "content-type": `${contentVersionTransferMediaType}; charset=utf-8` }
      });
    });
    const transfer = new CanvasRuntimeContentTransfer({
      baseUrl: new URL("https://server.example"),
      hostId: "host-a",
      token: "host-token-a",
      request
    });

    await expect(
      transfer.fetch(
        scope,
        { revision: 1, content: completed, graphFingerprint: `pkg-${"a".repeat(64)}` },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ scope, completed, content });
  });
});
