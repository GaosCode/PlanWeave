import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVITY_LIST_PAGE_DEFAULT } from "@planweave-ai/collaboration-protocol/core/limits";
import { type ActivityRecord } from "@planweave-ai/collaboration-protocol/activity/comments";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { collaborationBridge } from "../bridge";
import {
  buildActivityRowViewModel,
  resolveActivityPanelMode,
  type ActivityRowViewModel,
  type CommentsPanelMode
} from "../collaboration/commentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import type { createTranslator } from "../i18n";
import {
  workItemKey,
  type CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type UseActivityPanelControllerArgs = {
  /** When set, list activity for this work item; otherwise project-wide. */
  workItem?: WorkItemRef | null;
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseActivityPanelControllerResult = {
  mode: CommentsPanelMode;
  rows: ActivityRowViewModel[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  actionError: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
};

type ActivityCursor = { occurredAt: string; activityId: string };

type ActivityRequest = {
  generation: number;
  mode: "replace" | "append";
  initialActivityIds: Set<string>;
  arrivals: Map<string, ActivityRecord>;
};

function mergeActivity(...groups: ActivityRecord[][]): ActivityRecord[] {
  const byId = new Map<string, ActivityRecord>();
  for (const group of groups) {
    for (const item of group) byId.set(item.activityId, item);
  }
  return [...byId.values()].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.activityId.localeCompare(a.activityId)
  );
}

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
    code: "collaboration_activity_error",
    message: error instanceof Error ? error.message : "activity_error",
    retryable: true
  };
}

/**
 * Lazy activity history for project or work-item scope.
 * Uses typed ActivityRecord summaries only — never ACP event streams.
 */
export function useActivityPanelController(
  args: UseActivityPanelControllerArgs
): UseActivityPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status } = useCollaborationStatus({ api });
  const { snapshot, controller } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const sessionConnected = isCollaborationSessionConnected(status);
  const workKey = args.workItem ? workItemKey(args.workItem) : "project";

  const [items, setItems] = useState<ActivityRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const requestRef = useRef<ActivityRequest | null>(null);
  const cursorRef = useRef<ActivityCursor | null>(null);
  const activeProfileId = status?.session.activeProfileId ?? null;
  const activeProjectId =
    status?.profiles.find((profile) => profile.profileId === activeProfileId)?.projectId ?? null;
  const scopeConnected =
    sessionConnected &&
    snapshot.profileId === activeProfileId &&
    snapshot.projectId === activeProjectId &&
    snapshot.projectId !== null;
  const filterActivity = useCallback(
    (records: ActivityRecord[]) =>
      records.filter((record) => {
        if (record.projectId !== snapshot.projectId) return false;
        if (!args.workItem) return true;
        const item = record.workItem ?? record.summary.workItem;
        return item != null && workItemKey(item) === workKey;
      }),
    [args.workItem, snapshot.projectId, workKey]
  );

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!api || !controller || !args.open || !scopeConnected) return;
      if (mode === "append" && (requestRef.current || !cursorRef.current)) return;
      const request: ActivityRequest = {
        generation: generationRef.current,
        mode,
        initialActivityIds: new Set(
          controller.getSnapshot().activity.map((item) => item.activityId)
        ),
        arrivals: new Map()
      };
      requestRef.current = request;
      setLoading(mode === "replace");
      setLoadingMore(mode === "append");
      setActionError(null);
      const isCurrent = () =>
        requestRef.current === request &&
        request.generation === generationRef.current &&
        controller.getSnapshot().profileId === snapshot.profileId &&
        controller.getSnapshot().projectId === snapshot.projectId;
      try {
        const page = await api.listCollaborationActivity({
          workItem: args.workItem ?? undefined,
          limit: ACTIVITY_LIST_PAGE_DEFAULT,
          cursor: mode === "append" ? (cursorRef.current ?? undefined) : undefined
        });
        if (!isCurrent()) return;
        if (mode === "replace") {
          for (const item of filterActivity(controller.getSnapshot().activity)) {
            if (!request.initialActivityIds.has(item.activityId)) {
              request.arrivals.set(item.activityId, item);
            }
          }
        }
        setItems((prev) =>
          mode === "replace"
            ? mergeActivity(page.items, [...request.arrivals.values()])
            : mergeActivity(prev, page.items)
        );
        cursorRef.current = page.nextCursor;
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (!isCurrent()) return;
        setActionError(collaborationErrorMessage(mapBoundaryError(error)));
      } finally {
        if (isCurrent()) {
          requestRef.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [
      api,
      controller,
      args.open,
      args.workItem,
      scopeConnected,
      snapshot.profileId,
      snapshot.projectId,
      filterActivity
    ]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: only scope changes retire history requests
  useEffect(() => {
    generationRef.current += 1;
    requestRef.current = null;
    cursorRef.current = null;
    setItems([]);
    setNextCursor(null);
    setActionError(null);
    setLoading(false);
    setLoadingMore(false);
    void loadPage("replace");
    return () => {
      generationRef.current += 1;
      requestRef.current = null;
    };
  }, [
    args.open,
    workKey,
    scopeConnected,
    api,
    snapshot.projectId,
    snapshot.profileId,
    activeProfileId,
    activeProjectId,
    controller
  ]);

  // Hub records are immutable. Only IDs first observed after this request started
  // survive its replacement; prior history remains governed by the server page.
  useEffect(() => {
    if (!args.open || !scopeConnected) return;
    const filtered = filterActivity(snapshot.activity);
    const request = requestRef.current;
    if (request?.mode === "replace") {
      for (const item of filtered) {
        if (!request.initialActivityIds.has(item.activityId)) {
          request.arrivals.set(item.activityId, item);
        }
      }
    }
    if (filtered.length) setItems((prev) => mergeActivity(prev, filtered));
  }, [args.open, scopeConnected, snapshot.activity, filterActivity]);

  const rows = useMemo(() => items.map(buildActivityRowViewModel), [items]);

  const mode = resolveActivityPanelMode({
    sessionConnected,
    sessionPhase: status?.session.phase ?? null,
    syncPhase: snapshot.syncPhase,
    loading,
    hasItems: rows.length > 0,
    lastErrorKind: snapshot.lastError?.kind ?? (actionError ? "error" : null)
  });

  const refresh = useCallback(async () => {
    await loadPage("replace");
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    await loadPage("append");
  }, [loadPage]);

  return {
    mode,
    rows,
    loading,
    loadingMore,
    hasMore: nextCursor != null,
    actionError,
    loadMore,
    refresh
  };
}
