/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CommentAttachmentView } from "../renderer/team/CommentAttachmentView";
import type { CollaborationCommentAttachmentBody } from "../shared/collaboration";
import { CommentsPanel } from "../renderer/team/CommentsPanel";
import { ActivityPanel } from "../renderer/team/ActivityPanel";
import type { CommentRowViewModel } from "../renderer/collaboration/commentViewModels";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const imageDisplayName = "clipboard_2026-08-02_10-02_with-a-very-long-name.png";

const liveRow: CommentRowViewModel = {
  commentId: "comment-1",
  authorLabel: "Ada",
  authorActive: true,
  isCurrentUser: true,
  body: "Hello **team**\n\n<script>alert(1)</script>",
  bodyFormat: "markdown",
  revision: 1,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  tombstoned: false,
  tombstoneLabel: null,
  workItemMissing: false,
  attachments: [
    {
      id: "a".repeat(64),
      displayName: imageDisplayName,
      mediaType: "image/png",
      sizeBytes: 4,
      digestShort: "aaaaaaaa…"
    },
    {
      id: "b".repeat(64),
      displayName: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      digestShort: "bbbbbbbb…"
    }
  ],
  actions: { canEdit: true, canTombstone: true, reason: "author" }
};

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("CommentsPanel", () => {
  it("renders active comments without exposing removed tombstones", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn().mockResolvedValue(true);
    const onTombstone = vi.fn().mockResolvedValue(true);
    const onSubmit = vi.fn().mockResolvedValue(true);
    const onDraftBodyChange = vi.fn();
    const onReadAttachment = vi.fn(async (_commentId: string, digestSha256: string) =>
      digestSha256 === "a".repeat(64)
        ? {
            digestSha256,
            mediaType: "image/png" as const,
            sizeBytes: 4,
            bodyBase64: "iVBORw=="
          }
        : {
            digestSha256,
            mediaType: "text/plain" as const,
            sizeBytes: 5,
            bodyBase64: "bm90ZXM="
          }
    );

    render(
      <CommentsPanel
        mode="ready"
        rows={[liveRow]}
        draft={{ body: "draft body", showPreview: false }}
        stagedAttachments={[]}
        loading={false}
        loadingMore={false}
        hasMore
        submitting={false}
        actionError={null}
        canCompose
        t={t}
        onDraftBodyChange={onDraftBodyChange}
        onShowPreviewChange={vi.fn()}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onSubmit={onSubmit}
        onEdit={onEdit}
        onTombstone={onTombstone}
        onStageFiles={vi.fn().mockResolvedValue(undefined)}
        onCancelAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReadAttachment={onReadAttachment}
      />
    );

    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-mode", "ready");
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-item-tombstone")).toBeNull();
    expect(screen.queryByText("This comment was removed.")).toBeNull();
    // SafeMarkdown renders text nodes; script tags are not executable DOM.
    expect(screen.getByTestId("comments-item-body").textContent).toContain("<script>");
    expect(screen.queryByTestId("comments-item-body")?.querySelector("script")).toBeNull();
    const imageAttachmentButton = screen.getByRole("button", {
      name: `View attachment ${imageDisplayName}`
    });
    expect(imageAttachmentButton).toHaveAttribute("title", imageDisplayName);
    expect(imageAttachmentButton).toHaveClass("w-full", "min-w-0", "truncate");
    await user.click(imageAttachmentButton);
    expect(onReadAttachment).toHaveBeenCalledWith("comment-1", "a".repeat(64));
    expect(screen.getByRole("img", { name: imageDisplayName })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw=="
    );
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "download",
      imageDisplayName
    );
    await user.click(screen.getByRole("button", { name: `Expand image ${imageDisplayName}` }));
    const imageDialog = screen.getByRole("dialog", { name: imageDisplayName });
    expect(screen.getByTestId("comments-attachment-lightbox-overlay")).toHaveClass("bg-black/25");
    expect(screen.getByTestId("comments-attachment-lightbox-overlay")).not.toHaveClass(
      "bg-black/80"
    );
    expect(imageDialog).toHaveClass("bg-background", "text-text");
    expect(imageDialog).not.toHaveClass("bg-neutral-950", "text-white");
    expect(within(imageDialog).getByRole("img", { name: imageDisplayName })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw=="
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: imageDisplayName })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View attachment notes.txt" }));
    expect(onReadAttachment).toHaveBeenCalledWith("comment-1", "b".repeat(64));
    expect(screen.getByText(t("commentsAttachmentPreviewUnavailable"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("download", "notes.txt");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "data:text/plain;base64,bm90ZXM="
    );
    expect(screen.getByTestId("comments-load-more")).toBeInTheDocument();

    await user.click(screen.getByTestId("comments-edit"));
    await user.clear(screen.getByLabelText(t("commentsEditAria")));
    await user.type(screen.getByLabelText(t("commentsEditAria")), "updated");
    await user.click(screen.getByTestId("comments-edit-save"));
    expect(onEdit).toHaveBeenCalledWith("comment-1", "updated", 1);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getAllByTestId("comments-tombstone")[0]!);
    expect(onTombstone).toHaveBeenCalledWith("comment-1", 1);

    await user.click(screen.getByTestId("comments-submit"));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("exposes load-more, retry, and attachment cancel controls", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(
      <CommentsPanel
        mode="error"
        rows={[]}
        draft={{ body: "", showPreview: false }}
        stagedAttachments={[
          {
            localId: "local-1",
            displayName: "a.png",
            mediaType: "image/png",
            sizeBytes: 10,
            phase: "uploading",
            progress: 0.4,
            errorMessage: null,
            pendingUploadId: "pending-1",
            digestSha256: null,
            input: null
          }
        ]}
        loading={false}
        loadingMore={false}
        hasMore
        submitting={false}
        actionError="offline"
        canCompose
        t={t}
        onDraftBodyChange={vi.fn()}
        onShowPreviewChange={vi.fn()}
        onLoadMore={onLoadMore}
        onRefresh={onRefresh}
        onSubmit={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn().mockResolvedValue(false)}
        onTombstone={vi.fn().mockResolvedValue(false)}
        onStageFiles={vi.fn().mockResolvedValue(undefined)}
        onCancelAttachment={onCancel}
        onRemoveAttachment={vi.fn()}
        onReadAttachment={vi.fn().mockResolvedValue({
          digestSha256: "a".repeat(64),
          mediaType: "image/png",
          sizeBytes: 4,
          bodyBase64: "iVBORw=="
        })}
      />
    );

    await user.click(screen.getByTestId("comments-retry"));
    expect(onRefresh).toHaveBeenCalled();
    await user.click(screen.getByTestId("comments-load-more"));
    expect(onLoadMore).toHaveBeenCalled();
    await user.click(screen.getByTestId("comments-cancel-attachment"));
    expect(onCancel).toHaveBeenCalledWith("local-1");
    expect(screen.getByTestId("comments-staged-attachment")).toHaveAttribute(
      "data-phase",
      "uploading"
    );
  });
});

describe("ActivityPanel", () => {
  it("renders typed sources without interactive command affordances", () => {
    render(
      <ActivityPanel
        mode="ready"
        rows={[
          {
            activityId: "a1",
            type: "assignment_updated",
            sourceKind: "assignment",
            sourceLabelKey: "activitySourceAssignment",
            headline: "Assigned to Ada",
            occurredAt: "2030-01-01T00:00:00.000Z",
            workItemLabel: "Task T-1",
            interactive: false
          },
          {
            activityId: "a2",
            type: "remote_run_succeeded",
            sourceKind: "remote_run",
            sourceLabelKey: "activitySourceRemoteRun",
            headline: "Remote run succeeded",
            occurredAt: "2030-01-01T00:01:00.000Z",
            workItemLabel: "Block T-1#B-001",
            interactive: false
          }
        ]}
        loading={false}
        loadingMore={false}
        hasMore={false}
        actionError={null}
        t={t}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const items = screen.getAllByTestId("activity-item");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toHaveAttribute("data-interactive", "false");
      expect(within(item).queryByRole("button")).toBeNull();
    }
    expect(screen.getAllByTestId("activity-source")[0]).toHaveTextContent("Assignment");
    expect(screen.getAllByTestId("activity-source")[1]).toHaveTextContent("Remote run");
  });
});

describe("comment attachment preview scope", () => {
  it.each([
    true,
    false
  ])("ignores old callback completion and finally while B preview is pending (success=%s)", async (success) => {
    const user = userEvent.setup();
    let resolveA!: (body: CollaborationCommentAttachmentBody) => void;
    let rejectA!: (error: unknown) => void;
    let resolveB!: (body: CollaborationCommentAttachmentBody) => void;
    const pendingA = new Promise<CollaborationCommentAttachmentBody>((resolve, reject) => {
      resolveA = resolve;
      rejectA = reject;
    });
    const pendingB = new Promise<CollaborationCommentAttachmentBody>((resolve) => {
      resolveB = resolve;
    });
    const readA = vi.fn(() => pendingA);
    const readB = vi.fn(() => pendingB);
    const props = { commentId: liveRow.commentId, attachments: liveRow.attachments, t };
    const view = render(<CommentAttachmentView {...props} onReadAttachment={readA} />);
    const buttonName = `View attachment ${imageDisplayName}`;
    await user.click(screen.getByRole("button", { name: buttonName }));
    view.rerender(<CommentAttachmentView {...props} onReadAttachment={readB} />);
    await user.click(screen.getByRole("button", { name: buttonName }));
    expect(readB).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (success)
        resolveA({
          digestSha256: "a".repeat(64),
          mediaType: "image/png",
          sizeBytes: 4,
          bodyBase64: "QQ=="
        });
      else rejectA(new Error("A failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("comments-attachment-preview")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: buttonName })).toBeDisabled();
    await act(async () => {
      resolveB({
        digestSha256: "a".repeat(64),
        mediaType: "image/png",
        sizeBytes: 4,
        bodyBase64: "Qg=="
      });
    });
    expect(screen.getByRole("img", { name: imageDisplayName })).toHaveAttribute(
      "src",
      "data:image/png;base64,Qg=="
    );
    view.unmount();
  });
});
