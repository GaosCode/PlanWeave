import { describe, expect, it, vi } from "vitest";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  createManagedProjectFromAuthoritativeContent,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument
} from "@planweave-ai/runtime";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { downloadWorkspaceCanvasFork } from "../main/collaboration/workspaceCanvasDownload.js";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";

vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("@planweave-ai/runtime")>();
  return {
    ...runtime,
    createManagedProjectFromAuthoritativeContent: vi.fn()
  };
});

describe("downloadWorkspaceCanvasFork", () => {
  it("creates an independent Local Canvas fork with lineage and no writeback", async () => {
    const manifest = basicManifest();
    const content: CompleteContentVersion = encodeCanvasReplicaDocument(
      parseCanvasReplicaDocument({
        schemaVersion: "canvas-replica-document/v1",
        manifest,
        promptMarkdownByPath: Object.fromEntries(
          manifest.nodes.flatMap((task) => [
            [task.prompt, `# ${task.id} task\n`],
            ...task.blocks.map((block) => [block.prompt, `# ${task.id} ${block.id}\n`])
          ])
        ),
        layout: {
          version: "desktop-layout/v1",
          projectId: "project-1",
          nodes: [{ nodeId: "T-001", x: 0, y: 0 }],
          updatedAt: "2026-08-22T00:00:00.000Z"
        }
      })
    );
    const digest = content.canonicalDigest;
    const completed = {
      versionId: `version-${digest}`,
      canonicalDigest: digest,
      verification: "complete" as const
    };
    const scope = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    };
    const discoverContentAuthority = vi.fn(async () => ({
      authoritativeHead: { scope, revision: 4, content: completed },
      localReplica: null,
      replicaStatus: "snapshot_required" as const
    }));
    const fetchContentVersion = vi.fn(async () => ({ scope, completed, content }));
    vi.mocked(createManagedProjectFromAuthoritativeContent).mockResolvedValue({
      project: {
        projectId: "fork-project",
        name: "Downloaded fork",
        kind: "managed",
        rootPath: "/tmp/fork-project",
        sourceRoot: null,
        workspaceRoot: "/tmp/fork-project",
        activeCanvasId: "default",
        taskCanvases: []
      },
      canvasId: "default",
      lineage: {
        schemaVersion: "workspace-fork-lineage/v1",
        writeback: false,
        source: { scope, revision: 4, content: completed }
      }
    });

    const result = await downloadWorkspaceCanvasFork({
      client: { discoverContentAuthority, fetchContentVersion } as CollaborationClient,
      rawInput: {
        ...scope,
        projectName: "Downloaded fork"
      }
    });

    expect(discoverContentAuthority).toHaveBeenCalledWith({
      canvasId: scope.canvasId,
      localReplica: null,
      knownRevision: null
    });
    expect(createManagedProjectFromAuthoritativeContent).toHaveBeenCalledWith(
      expect.objectContaining({
        importMode: "fork",
        sourceLineage: { scope, revision: 4, content: completed }
      })
    );
    expect(result).toMatchObject({
      locator: { kind: "local", projectId: "fork-project", canvasId: "default" },
      writeback: false,
      lineage: { source: { scope, revision: 4 }, writeback: false }
    });
  });
});
