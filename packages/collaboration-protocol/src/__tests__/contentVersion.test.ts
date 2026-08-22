import { describe, expect, it } from "vitest";
import {
  authorizedContentVersionFetchSchema,
  authoritativeContentHeadSchema,
  canonicalContentVersionDigestPayload,
  compareContentVersionMemberPaths,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  contentVersionJournalEntrySchema,
  contentVersionMaterializeResultSchema,
  workspaceCanvasInitialPublishRequestSchema,
  workspaceCanvasInitialPublishResultSchema
} from "../contentVersion.js";
import {
  exampleAuthoritativeContentVersion,
  exampleCompleteContentVersion,
  exampleContentVersionCanonicalPayload
} from "../fixtures/contentVersion.js";

const scope = exampleAuthoritativeContentVersion.scope;
const content = exampleAuthoritativeContentVersion.completed;
const head = {
  schemaVersion: "content-version/v1" as const,
  scope,
  revision: 1,
  content,
  advancedAt: "2030-01-01T00:00:01.000Z"
};

describe("authoritative content-version contracts", () => {
  it("requires a bounded canonical manifest, every prompt member, and desktop layout", () => {
    expect(exampleCompleteContentVersion.members).toHaveLength(4);
    expect(canonicalContentVersionDigestPayload(exampleCompleteContentVersion)).toBe(
      exampleContentVersionCanonicalPayload
    );
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [...exampleCompleteContentVersion.members].reverse()
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: exampleCompleteContentVersion.members.filter(
          (member) => member.kind !== "desktop_layout"
        )
      })
    ).toThrow();
  });

  it("uses the canonical comparator for paths whose locale and code-unit orders differ", () => {
    const members = exampleCompleteContentVersion.members.map((member) => {
      if (member.kind === "task_prompt") return { ...member, path: "nodes/a/prompt.md" };
      if (member.kind === "block_prompt") {
        return { ...member, path: "nodes/A/blocks/B-001.prompt.md" };
      }
      return member;
    });
    expect(compareContentVersionMemberPaths("nodes/a/prompt.md", "nodes/A/prompt.md")).toBeLessThan(
      0
    );
    expect(
      completeContentVersionSchema
        .parse({
          ...exampleCompleteContentVersion,
          canonicalDigest: "a".repeat(64),
          members
        })
        .members.map((member) => member.path)
    ).toEqual(members.map((member) => member.path));
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        canonicalDigest: "a".repeat(64),
        members: [...members.slice(0, 2), ...members.slice(2).reverse()]
      })
    ).toThrow();
  });

  it("pins case-distinct ASCII path order independently of the runtime locale", () => {
    const upperCaseI = "nodes/I/prompt.md";
    const lowerCaseI = "nodes/i/prompt.md";
    expect(
      new Intl.Collator("tr", { sensitivity: "variant" }).compare(upperCaseI, lowerCaseI)
    ).toBeLessThan(0);
    expect(compareContentVersionMemberPaths(upperCaseI, lowerCaseI)).toBeGreaterThan(0);
    expect(compareContentVersionMemberPaths(upperCaseI, lowerCaseI)).toBe(
      new Intl.Collator("en-US", {
        usage: "sort",
        sensitivity: "variant",
        numeric: false,
        caseFirst: "false",
        ignorePunctuation: false
      }).compare(upperCaseI, lowerCaseI)
    );
  });

  it("rejects arbitrary paths, invalid member kinds, and unverified byte metadata", () => {
    const [layout] = exampleCompleteContentVersion.members;
    expect(layout).toBeDefined();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [
          { ...layout!, path: "../../desktop/layout.json" },
          ...exampleCompleteContentVersion.members.slice(1)
        ]
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [
          { ...layout!, kind: "manifest" },
          ...exampleCompleteContentVersion.members.slice(1)
        ]
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [{ ...layout!, sizeBytes: 1 }, ...exampleCompleteContentVersion.members.slice(1)],
        totalBytes: 18
      })
    ).toThrow();
  });

  it("keeps desktop layout as a logical member address rather than a physical path", () => {
    expect(contentVersionDesktopLayoutMemberPath).toBe("desktop/layout.json");
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: exampleCompleteContentVersion.members.map((member) =>
          member.kind === "desktop_layout"
            ? { ...member, path: "canvases/default/desktop/layout.json" }
            : member
        )
      })
    ).toThrow();
  });

  it("returns workspace scope, revision, operation id, and recovery token for idempotent initial publish", () => {
    const request = workspaceCanvasInitialPublishRequestSchema.parse({
      operationId: "publish-op-1",
      localSource: { localProjectId: "local-project-1", localCanvasId: "default" },
      content: exampleCompleteContentVersion
    });
    expect(request).not.toHaveProperty("canvasId");
    expect(() =>
      workspaceCanvasInitialPublishRequestSchema.parse({
        operationId: "publish-op-1",
        canvasId: scope.canvasId,
        content: exampleCompleteContentVersion
      })
    ).toThrow();
    const published = workspaceCanvasInitialPublishResultSchema.parse({
      outcome: "published",
      operationId: request.operationId,
      recoveryToken: "wp-publish-op-1",
      scope,
      revision: 1,
      content,
      visibility: "private"
    });
    expect(published.scope).toEqual(scope);
    expect(published).not.toHaveProperty("connectionProfileId");
    expect(
      workspaceCanvasInitialPublishResultSchema.parse({
        ...published,
        outcome: "reused"
      }).outcome
    ).toBe("reused");
    expect(
      workspaceCanvasInitialPublishResultSchema.parse({
        outcome: "rejected",
        reason: "storage_unavailable",
        retryable: true,
        detail: "initial_publish_failed",
        scope: null,
        recoveryToken: null
      }).recoveryToken
    ).toBeNull();
  });

  it("binds immutable completed versions to heads and contiguous journal entries", () => {
    expect(authoritativeContentHeadSchema.parse(head).content.versionId).toBe(content.versionId);
    expect(
      contentVersionJournalEntrySchema.parse({
        schemaVersion: "content-version/v1",
        scope,
        revision: 1,
        previousRevision: 0,
        content,
        acceptedAt: "2030-01-01T00:00:01.000Z"
      }).content.canonicalDigest
    ).toBe(content.canonicalDigest);
    expect(() =>
      contentVersionJournalEntrySchema.parse({
        schemaVersion: "content-version/v1",
        scope,
        revision: 2,
        previousRevision: 0,
        content,
        acceptedAt: "2030-01-01T00:00:01.000Z"
      })
    ).toThrow();
    expect(() =>
      authoritativeContentHeadSchema.parse({
        ...head,
        content: { ...content, verification: "pending" }
      })
    ).toThrow();
  });

  it("allows fetch only through a matching authorized scope and device", () => {
    const request = { projectId: scope.projectId, canvasId: scope.canvasId, content };
    expect(
      authorizedContentVersionFetchSchema.parse({
        request,
        scope,
        deviceSessionId: "device-session-002",
        aclRevision: 2
      }).request.content.versionId
    ).toBe(content.versionId);
    expect(() =>
      authorizedContentVersionFetchSchema.parse({
        request: { ...request, canvasId: "canvas-other" },
        scope,
        deviceSessionId: "device-session-002",
        aclRevision: 2
      })
    ).toThrow();
  });

  it("requires explicit materialization failure reasons", () => {
    expect(
      contentVersionMaterializeResultSchema.parse({
        outcome: "materialized",
        content,
        retryable: false,
        reason: null
      }).outcome
    ).toBe("materialized");
    expect(() =>
      contentVersionMaterializeResultSchema.parse({
        outcome: "retry_required",
        content,
        retryable: true,
        reason: null
      })
    ).toThrow();
  });
});
