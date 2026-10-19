import { usePendingAttachmentDownload } from "./usePendingAttachmentDownload";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_LIST_PAGE_DEFAULT
} from "@planweave-ai/collaboration-protocol/core/limits";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { collaborationBridge } from "../bridge";
import {
  CommentPaginationSession,
  emptyCommentPaginationSnapshot
} from "../collaboration/commentPaginationSession";
import {
  createStagedAttachmentFromFile,
  isStagedAttachmentPending,
  uploadStagedAttachment,
  type StagedAttachment
} from "../collaboration/attachmentUpload";
import {
  beginCommentDraftSubmission,
  clearCommentDraft,
  getCommentDraft,
  setCommentDraft,
  subscribeCommentDrafts,
  type CommentComposerDraft
} from "../collaboration/commentDraftStore";
import {
  buildCommentRowViewModel,
  resolveCommentsPanelMode,
  validateCommentBodyLength,
  type CommentRowViewModel,
  type CommentsPanelMode
} from "../collaboration/commentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { resolveCurrentMembership } from "../collaboration/peopleViewModels";
import type { createTranslator } from "../i18n";
import {
  workItemKey,
  type CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import type {
  CollaborationCommentAttachmentBody,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type UseCommentsPanelControllerArgs = {
  workItem: WorkItemRef | null;
  /** Lazy-load histories only while the surface is open. */
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseCommentsPanelControllerResult = {
  editScope: object;
  mode: CommentsPanelMode;
  rows: CommentRowViewModel[];
  draft: CommentComposerDraft;
  stagedAttachments: StagedAttachment[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  submitting: boolean;
  actionError: string | null;
  canCompose: boolean;
  setDraftBody: (body: string) => void;
  setShowPreview: (show: boolean) => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  submitComment: () => Promise<boolean>;
  editComment: (commentId: string, body: string, expectedRevision: number) => Promise<boolean>;
  tombstoneComment: (commentId: string, expectedRevision: number) => Promise<boolean>;
  readAttachment: (
    commentId: string,
    digestSha256: string
  ) => Promise<CollaborationCommentAttachmentBody>;
  stageFiles: (
    files: Array<{
      name: string;
      type: string;
      size: number;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }>
  ) => Promise<void>;
  downloadPendingAttachment: (localId: string) => Promise<void>;
  downloadingAttachments: string[];
  cancelAttachment: (localId: string) => void;
  removeAttachment: (localId: string) => void;
};

function mapBoundaryError(error: unknown): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  ) {
    return error as CollaborationBoundaryErrorView;
  }
  return {
    kind: "unknown",
    code: "collaboration_comment_error",
    message: error instanceof Error ? error.message : "comment_error",
    retryable: true
  };
}

/**
 * On-demand comments controller for one WorkItemRef.
 * Reuses the shared collaboration hub for identity/sync; history is lazy-loaded
 * and paginated with cursor load-more. Drafts are keyed by stable work item id.
 */
export function useCommentsPanelController(
  args: UseCommentsPanelControllerArgs
): UseCommentsPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status, draftScope: scopeKey } = useCollaborationStatus({ api });
  const { snapshot, controller } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((p) => p.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const operationScope = status?.session.operationScope;
  const sessionConnected = isCollaborationSessionConnected(status);
  const currentMembership = resolveCurrentMembership({
    members: snapshot.members,
    status
  });
  const currentHumanPrincipalId =
    currentMembership?.humanPrincipalId ?? activeProfile?.humanPrincipalId ?? null;
  const currentUserIsOwner = currentMembership?.role === "owner";

  const workKey = args.workItem ? workItemKey(args.workItem) : null;
  const [pagination, setPagination] = useState(emptyCommentPaginationSnapshot);
  const { items: comments, nextCursor, loading, loadingMore } = pagination;
  const paginationRef = useRef<CommentPaginationSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const stagedAttachmentsRef = useRef<StagedAttachment[]>([]);
  const updateStagedAttachments = useCallback(
    (update: (current: StagedAttachment[]) => StagedAttachment[]) => {
      const next = update(stagedAttachmentsRef.current);
      stagedAttachmentsRef.current = next;
      setStagedAttachments(next);
    },
    []
  );
  const cancelledUploads = useRef(new Set<string>());
  const generationRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const currentScopeRef = useRef<object | null>(null);
  const connectionScopeKey = JSON.stringify([
    operationScope?.sessionId,
    activeProfile?.serverBaseUrl,
    activeProfile?.credentialRevision,
    activeProfile?.humanPrincipalId,
    status?.workspaceConnection.workspaceId,
    status?.workspaceConnection.credentialRevision
  ]);
  const scopeToken = useMemo(
    () => ({ api, controller, open: args.open, scopeKey, workKey, connectionScopeKey }),
    [api, controller, args.open, scopeKey, workKey, connectionScopeKey]
  );
  useLayoutEffect(() => {
    currentScopeRef.current = scopeToken;
    updateStagedAttachments(() => []);
    cancelledUploads.current = new Set();
    return () => {
      currentScopeRef.current = null;
      generationRef.current += 1;
    };
  }, [scopeToken, updateStagedAttachments]);
  const isCurrentScope = useCallback(() => currentScopeRef.current === scopeToken, [scopeToken]);

  useEffect(() => {
    if (!controller || !activeProfile || !sessionConnected || !operationScope) return;
    const current = controller.getSnapshot();
    if (current.profileId || current.projectId) return;
    void controller.setActiveProject({
      operationScope,
      profileId: activeProfile.profileId,
      projectId: activeProfile.projectId
    });
  }, [activeProfile, controller, sessionConnected, operationScope]);

  const getDraftSnapshot = useCallback(
    () => (args.workItem ? getCommentDraft(args.workItem, scopeKey) : null),
    [args.workItem, scopeKey]
  );
  const storedDraft = useSyncExternalStore(subscribeCommentDrafts, getDraftSnapshot);
  const draft = storedDraft ?? { body: "", showPreview: false };

  const canMutate =
    sessionConnected &&
    (snapshot.syncPhase === "ready" ||
      snapshot.syncPhase === "degraded" ||
      snapshot.syncPhase === "stale_conflict" ||
      snapshot.syncPhase === "loading");

  const invalidationVersion = workKey
    ? snapshot.commentInvalidationVersionByWorkItem[workKey]
    : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeToken captures api/open/work identity; invalidations do not retire the composer
  useEffect(() => {
    generationRef.current += 1;
    setPagination(emptyCommentPaginationSnapshot());
    setSubmitting(false);
    setActionError(null);
    if (!args.open || !args.workItem || !sessionConnected || !api || !operationScope) return;
    const generation = generationRef.current;
    const workItem = args.workItem;
    const session = new CommentPaginationSession({
      initialVersion: invalidationVersion ?? 0,
      listPage: (cursor) =>
        api.listCollaborationComments({
          operationScope,
          workItem,
          limit: COMMENT_LIST_PAGE_DEFAULT,
          includeTombstoned: true,
          cursor
        }),
      onChange: (next) => {
        if (
          isCurrentScope() &&
          generation === generationRef.current &&
          paginationRef.current === session
        )
          setPagination(next);
      },
      onError: (error) => {
        if (isCurrentScope() && generation === generationRef.current)
          setActionError(collaborationErrorMessage(mapBoundaryError(error)));
      },
      onRequestStart: () => {
        if (isCurrentScope() && generation === generationRef.current) setActionError(null);
      }
    });
    paginationRef.current = session;
    setPagination({ ...emptyCommentPaginationSnapshot(), loading: true });
    void (async () => {
      try {
        if (controller) await controller.trackWorkItemComments(workItem);
        if (!isCurrentScope() || generation !== generationRef.current) return;
        await session.start();
      } catch (error) {
        if (isCurrentScope() && generation === generationRef.current) {
          setActionError(collaborationErrorMessage(mapBoundaryError(error)));
          setPagination((current) => ({ ...current, loading: false, loadingMore: false }));
        }
      }
    })();
    return () => {
      session.dispose();
      if (paginationRef.current === session) paginationRef.current = null;
    };
  }, [scopeToken, sessionConnected]);

  useEffect(() => {
    if (
      snapshot.profileId !== activeProfile?.profileId ||
      snapshot.projectId !== activeProfile?.projectId ||
      !isCurrentScope()
    )
      return;
    if (invalidationVersion !== undefined)
      void paginationRef.current?.invalidate(invalidationVersion);
  }, [
    activeProfile?.profileId,
    activeProfile?.projectId,
    invalidationVersion,
    isCurrentScope,
    snapshot.profileId,
    snapshot.projectId
  ]);

  const rows = useMemo(
    () =>
      comments
        .filter((comment) => !comment.tombstoned)
        .map((comment) =>
          buildCommentRowViewModel({
            comment,
            currentHumanPrincipalId,
            currentUserIsOwner,
            canMutate,
            removedMemberLabel: args.t("commentsRemovedMember"),
            tombstonedLabel: args.t("commentsTombstoned")
          })
        ),
    [args.t, canMutate, comments, currentHumanPrincipalId, currentUserIsOwner]
  );

  const mode = resolveCommentsPanelMode({
    sessionConnected,
    sessionPhase: status?.session.phase ?? null,
    syncPhase: snapshot.syncPhase,
    loading,
    hasComments: rows.length > 0,
    lastErrorKind: snapshot.lastError?.kind ?? (actionError ? "error" : null)
  });

  const setDraftBody = useCallback(
    (body: string) => {
      if (!args.workItem || !isCurrentScope()) return;
      setCommentDraft(args.workItem, { body }, scopeKey);
    },
    [args.workItem, isCurrentScope, scopeKey]
  );

  const setShowPreview = useCallback(
    (show: boolean) => {
      if (!args.workItem || !isCurrentScope()) return;
      setCommentDraft(args.workItem, { showPreview: show }, scopeKey);
    },
    [args.workItem, isCurrentScope, scopeKey]
  );

  const refresh = useCallback(async () => {
    if (isCurrentScope()) await paginationRef.current?.refresh();
  }, [isCurrentScope]);

  const loadMore = useCallback(async () => {
    if (isCurrentScope()) await paginationRef.current?.loadMore();
  }, [isCurrentScope]);

  const submitComment = useCallback(async () => {
    if (!api || !args.workItem || !controller || !canMutate || !isCurrentScope()) return false;
    const submittedDraft = getCommentDraft(args.workItem, scopeKey);
    const bodyCheck = validateCommentBodyLength(submittedDraft.body.trim());
    if (!bodyCheck.ok) {
      setActionError(args.t("commentsBodyInvalid"));
      return false;
    }
    const attachments = stagedAttachmentsRef.current.filter(
      (item) => !cancelledUploads.current.has(item.localId)
    );
    const ready = attachments.flatMap((item) =>
      item.phase === "ready" && item.input ? [{ localId: item.localId, input: item.input }] : []
    );
    if (attachments.some(isStagedAttachmentPending)) {
      setActionError(args.t("commentsAttachmentsPending"));
      return false;
    }
    if (ready.length > COMMENT_ATTACHMENTS_MAX_COUNT) {
      setActionError(args.t("commentsAttachmentsTooMany"));
      return false;
    }
    const finishSubmission = beginCommentDraftSubmission(args.workItem, submittedDraft, scopeKey);
    if (!finishSubmission) return false;
    const consumedAttachments = new Set(ready.map((item) => item.localId));
    const request = ++mutationRequestRef.current;
    const isCurrentRequest = () => isCurrentScope() && request === mutationRequestRef.current;
    setSubmitting(true);
    setActionError(null);
    try {
      const result = await controller.createComment({
        workItem: args.workItem,
        body: submittedDraft.body.trim(),
        attachments: ready.map((item) => item.input)
      });
      if (result) clearCommentDraft(args.workItem, submittedDraft, scopeKey);
      if (!isCurrentRequest()) return result !== null;
      if (!result) {
        setActionError(
          collaborationErrorMessage(snapshot.lastError) || args.t("commentsSubmitFailed")
        );
        return false;
      }
      paginationRef.current?.confirm(result);
      for (const localId of consumedAttachments) cancelledUploads.current.add(localId);
      updateStagedAttachments((prev) =>
        prev.filter((item) => !consumedAttachments.has(item.localId))
      );
      return true;
    } catch (error) {
      if (isCurrentRequest()) setActionError(collaborationErrorMessage(mapBoundaryError(error)));
      return false;
    } finally {
      finishSubmission();
      if (isCurrentRequest()) setSubmitting(false);
    }
  }, [
    api,
    args.t,
    args.workItem,
    canMutate,
    controller,
    isCurrentScope,
    scopeKey,
    snapshot.lastError,
    updateStagedAttachments
  ]);

  const editComment = useCallback(
    async (commentId: string, body: string, expectedRevision: number) => {
      if (!controller || !canMutate || !isCurrentScope()) return false;
      const bodyCheck = validateCommentBodyLength(body.trim());
      if (!bodyCheck.ok) {
        setActionError(args.t("commentsBodyInvalid"));
        return false;
      }
      const request = ++mutationRequestRef.current;
      const isCurrentRequest = () => isCurrentScope() && request === mutationRequestRef.current;
      setSubmitting(true);
      setActionError(null);
      try {
        const result = await controller.editComment({
          commentId,
          body: body.trim(),
          expectedRevision
        });
        if (!isCurrentRequest()) return result !== null;
        if (!result) {
          setActionError(
            collaborationErrorMessage(snapshot.lastError) || args.t("commentsEditFailed")
          );
          return false;
        }
        paginationRef.current?.confirm(result);
        return true;
      } catch (error) {
        if (isCurrentRequest()) setActionError(collaborationErrorMessage(mapBoundaryError(error)));
        return false;
      } finally {
        if (isCurrentRequest()) setSubmitting(false);
      }
    },
    [args.t, canMutate, controller, isCurrentScope, snapshot.lastError]
  );

  const tombstoneComment = useCallback(
    async (commentId: string, expectedRevision: number) => {
      if (!controller || !canMutate || !isCurrentScope()) return false;
      const request = ++mutationRequestRef.current;
      const isCurrentRequest = () => isCurrentScope() && request === mutationRequestRef.current;
      setSubmitting(true);
      setActionError(null);
      try {
        const result = await controller.tombstoneComment({
          commentId,
          expectedRevision
        });
        if (!isCurrentRequest()) return result !== null;
        if (!result) {
          setActionError(
            collaborationErrorMessage(snapshot.lastError) || args.t("commentsTombstoneFailed")
          );
          return false;
        }
        paginationRef.current?.confirm(result);
        return true;
      } catch (error) {
        if (isCurrentRequest()) setActionError(collaborationErrorMessage(mapBoundaryError(error)));
        return false;
      } finally {
        if (isCurrentRequest()) setSubmitting(false);
      }
    },
    [args.t, canMutate, controller, isCurrentScope, snapshot.lastError]
  );

  const stageFiles = useCallback(
    async (
      files: Array<{
        name: string;
        type: string;
        size: number;
        arrayBuffer: () => Promise<ArrayBuffer>;
      }>
    ) => {
      if (!isCurrentScope()) return;
      if (!api || !operationScope || !canMutate) {
        setActionError(args.t("commentsOffline"));
        return;
      }
      const remaining =
        COMMENT_ATTACHMENTS_MAX_COUNT -
        stagedAttachmentsRef.current.filter((a) => a.phase !== "cancelled" && a.phase !== "error")
          .length;
      if (remaining <= 0) {
        setActionError(args.t("commentsAttachmentsTooMany"));
        return;
      }
      const selected = files.slice(0, remaining);
      for (const file of selected) {
        const created = createStagedAttachmentFromFile(file);
        if (!created.ok) {
          setActionError(args.t("commentsAttachmentInvalid"));
          continue;
        }
        const localId = created.staged.localId;
        updateStagedAttachments((prev) => [...prev, created.staged]);
        // Each selection creates one localId for one upload attempt; removed ids are never reused.
        const acceptsProgress = () =>
          isCurrentScope() &&
          !cancelledUploads.current.has(localId) &&
          stagedAttachmentsRef.current.some((item) => item.localId === localId);
        void (async () => {
          try {
            const buffer = new Uint8Array(await file.arrayBuffer());
            if (!acceptsProgress()) return;
            await uploadStagedAttachment({
              api,
              operationScope,
              staged: created.staged,
              bytes: buffer,
              isCancelled: () => !acceptsProgress(),
              onProgress: (next) => {
                if (!acceptsProgress()) return;
                updateStagedAttachments((prev) =>
                  prev.map((item) => (item.localId === localId ? next : item))
                );
              }
            });
          } catch {
            if (!acceptsProgress()) return;
            updateStagedAttachments((prev) =>
              prev.map((item) =>
                item.localId === localId
                  ? {
                      ...item,
                      phase: "error",
                      errorMessage: args.t("commentsAttachmentUploadFailed"),
                      progress: 0
                    }
                  : item
              )
            );
          }
        })();
      }
    },
    [api, operationScope, args.t, canMutate, isCurrentScope, updateStagedAttachments]
  );

  const cancelAttachment = useCallback(
    (localId: string) => {
      if (!isCurrentScope()) return;
      cancelledUploads.current.add(localId);
      updateStagedAttachments((prev) =>
        prev.map((item) =>
          item.localId === localId
            ? { ...item, phase: "cancelled", progress: 0, errorMessage: null, input: null }
            : item
        )
      );
    },
    [isCurrentScope, updateStagedAttachments]
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      if (!isCurrentScope()) return;
      cancelledUploads.current.add(localId);
      updateStagedAttachments((prev) => prev.filter((item) => item.localId !== localId));
    },
    [isCurrentScope, updateStagedAttachments]
  );

  const isCancelled = useCallback((localId: string) => cancelledUploads.current.has(localId), []);
  const onDownloadStart = useCallback(() => setActionError(null), []);
  const onDownloadError = useCallback((error: unknown) => {
    setActionError(collaborationErrorMessage(mapBoundaryError(error)));
  }, []);
  const pendingDownload = usePendingAttachmentDownload({
    api: sessionConnected ? api : null,
    operationScope: operationScope ?? null,
    stagedAttachments,
    isCurrentScope,
    isCancelled,
    onStart: onDownloadStart,
    onError: onDownloadError
  });

  const attachmentProfileId = operationScope?.profileId;
  const attachmentProjectId = operationScope?.projectId;
  const attachmentServerBaseUrl = operationScope?.serverBaseUrl;
  const attachmentSessionId = operationScope?.sessionId;
  const attachmentScope = useMemo(() => {
    if (
      attachmentProfileId === undefined ||
      attachmentProjectId === undefined ||
      attachmentServerBaseUrl === undefined ||
      attachmentSessionId === undefined
    ) {
      return null;
    }
    return {
      profileId: attachmentProfileId,
      projectId: attachmentProjectId,
      serverBaseUrl: attachmentServerBaseUrl,
      sessionId: attachmentSessionId
    };
  }, [attachmentProfileId, attachmentProjectId, attachmentServerBaseUrl, attachmentSessionId]);

  const readAttachment = useCallback(
    async (commentId: string, digestSha256: string) => {
      if (!api || !attachmentScope || !sessionConnected || !isCurrentScope()) {
        throw new Error("collaboration_session_inactive");
      }
      return api.readCollaborationCommentAttachment({
        operationScope: attachmentScope,
        commentId,
        digestSha256
      });
    },
    [api, attachmentScope, isCurrentScope, sessionConnected]
  );

  return {
    editScope: scopeToken,
    mode,
    rows,
    draft,
    stagedAttachments,
    loading,
    loadingMore,
    hasMore: nextCursor != null,
    submitting,
    actionError,
    canCompose: canMutate && Boolean(args.workItem) && sessionConnected,
    setDraftBody,
    setShowPreview,
    loadMore,
    refresh,
    submitComment,
    editComment,
    tombstoneComment,
    readAttachment,
    downloadPendingAttachment: pendingDownload.download,
    downloadingAttachments: pendingDownload.downloading,
    stageFiles,
    cancelAttachment,
    removeAttachment
  };
}
