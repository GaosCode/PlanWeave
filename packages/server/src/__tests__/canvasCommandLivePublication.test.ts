import { describe, expect, it, vi } from "vitest";
import { type CanvasJournalEntry } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { CanvasCommandService } from "../canvas/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command service (OSS-004 B-002)", () => {
  it("publishes one complete journal entry only after a durable non-idempotent accept", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {}
    });

    const accepted = await service.submit(actor("editor"), submitBody("op-live-1", 0));
    expect(accepted).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      revision: 1,
      previousRevision: 0,
      operationId: "op-live-1",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });

    const replay = await service.submit(actor("editor"), submitBody("op-live-1", 0));
    const viewerDenied = await service.submit(actor("viewer"), submitBody("op-live-viewer", 1));
    const stale = await service.submit(actor("editor"), submitBody("op-live-stale", 0));
    expect(replay).toMatchObject({ type: "canvas.command.accepted", idempotentReplay: true });
    expect(viewerDenied).toMatchObject({ type: "canvas.command.rejected", code: "forbidden" });
    expect(stale).toMatchObject({ type: "canvas.command.rejected", code: "stale_revision" });
    expect(published).toHaveLength(1);
  });

  it("publishes strictly increasing revisions for consecutive accepted commits", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {}
    });

    await service.submit(actor("owner"), submitBody("op-live-order-1", 0));
    await service.submit(actor("editor"), submitBody("op-live-order-2", 1));

    expect(published.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(published.map((entry) => entry.previousRevision)).toEqual([0, 1]);
  });

  it("does not publish when the durable journal commit fails", async () => {
    const published: CanvasJournalEntry[] = [];
    const { service, repository } = await fixture({
      onAcceptedEntry: (entry) => published.push(entry),
      onAcceptedEntryUnavailable: () => {},
      onAcceptedInCallerTransaction: () => {
        throw new Error("commit_failed");
      }
    });

    const outcome = await service.submit(actor("owner"), submitBody("op-live-commit-failure", 0));
    expect(outcome).toMatchObject({ type: "canvas.command.rejected", code: "journal_unavailable" });
    expect(published).toEqual([]);
    expect(
      repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision
    ).toBe(0);
    expect(
      repository.getOperation(
        { workspaceId: "w", projectId: "p", canvasId: "default" },
        "op-live-commit-failure"
      )
    ).toBeUndefined();
  });

  it("keeps accepted responses stable and invalidates live scope when publication fails", async () => {
    const invalidated: Array<{ revision: number; scope: string }> = [];
    const { service, repository } = await fixture({
      onAcceptedEntry: () => {
        throw new Error("live_publish_failed");
      },
      onAcceptedEntryUnavailable: ({ scope, headRevision }) =>
        invalidated.push({
          revision: headRevision,
          scope: `${scope.workspaceId}/${scope.projectId}/${scope.canvasId}`
        })
    });

    const callbackFailure = await service.submit(
      actor("owner"),
      submitBody("op-live-callback-failure", 0)
    );
    expect(callbackFailure).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(invalidated).toEqual([{ revision: 1, scope: "w/p/default" }]);

    vi.spyOn(repository, "journalEntryAt").mockReturnValue(undefined);
    const entryUnavailable = await service.submit(
      actor("editor"),
      submitBody("op-live-entry-missing", 1)
    );
    expect(entryUnavailable).toMatchObject({ type: "canvas.command.accepted", revision: 2 });
    expect(invalidated).toEqual([
      { revision: 1, scope: "w/p/default" },
      { revision: 2, scope: "w/p/default" }
    ]);
  });

  it("fails fast when only one live publication callback is configured", async () => {
    const { repository, access, database, runtime } = await fixture();
    expect(
      () =>
        new CanvasCommandService({
          repository,
          access,
          workspaceIdentity: new WorkspaceIdentityRepository(database),
          runtime,
          onAcceptedEntry: () => {}
        })
    ).toThrow("canvas_live_sync_publication_callbacks_must_be_paired");
  });

  it("preserves accepted responses when both publish and invalidation fail", async () => {
    const { service } = await fixture({
      onAcceptedEntry: () => {
        throw new Error("live_publish_failed");
      },
      onAcceptedEntryUnavailable: () => {
        throw new Error("live_invalidation_failed");
      }
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const outcome = await service.submit(actor("owner"), submitBody("op-live-double-failure", 0));

    expect(outcome).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(warning).toHaveBeenCalledWith("canvas_live_sync_invalidation_failed", {
      code: "PLANWEAVE_CANVAS_LIVE_SYNC_INVALIDATION_FAILED"
    });
  });
});
