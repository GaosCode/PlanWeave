import { expect, it } from "vitest";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { decodeCanvasReplicaDocument } from "@planweave-ai/runtime";
import {
  actor,
  canvasCommandServiceFixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

it.each([
  "task",
  "block"
] as const)("rejects a queued %s prompt based on A even when the command revision already includes C", async (kind) => {
  const { service, repository, contentVersions } = await canvasCommandServiceFixture();
  const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
  const intent = (promptMarkdown: string, baseContentDigest?: string): CanvasCommandIntent =>
    kind === "task"
      ? { kind: "update_task_prompt", taskId: "T-001", promptMarkdown, baseContentDigest }
      : { kind: "update_block_prompt", blockRef: "T-001#B-001", promptMarkdown, baseContentDigest };
  const first = await service.submit(actor("owner"), submitBody("op-a", 0, intent("A")));
  expect(first).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
  if (first.type !== "canvas.command.accepted") throw new Error("Expected accepted A");
  const external = await service.submit(
    actor("editor"),
    submitBody("op-c", 1, intent("C", first.contentDigest))
  );
  expect(external).toMatchObject({ type: "canvas.command.accepted", revision: 2 });
  const before = contentVersions.head(scope);
  if (!before) throw new Error("Missing content authority");
  const queued = await service.submit(
    actor("owner"),
    submitBody("op-ab", 2, intent("AB", first.contentDigest))
  );
  expect(queued).toMatchObject({
    type: "canvas.command.rejected",
    code: "operation_conflict",
    detail: "base_content_digest_mismatch"
  });
  expect(repository.head(scope)).toMatchObject({
    revision: 2,
    contentDigest: before.content.canonicalDigest
  });
  expect(contentVersions.head(scope)).toEqual(before);
  const document = decodeCanvasReplicaDocument(
    contentVersions.readVersion(scope, before.content).content
  );
  const task = document.manifest.nodes[0];
  if (!task) throw new Error("Missing task");
  const path = kind === "task" ? task.prompt : task.blocks[0]?.prompt;
  if (!path) throw new Error("Missing prompt path");
  expect(document.promptMarkdownByPath[path]).toBe("C");
});
