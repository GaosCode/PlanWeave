import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { CanvasLocator } from "../../shared/canvasLocator";
import type { WorkspaceCanvasCommandsResult } from "../hooks/useWorkspaceCanvasCommands";
import {
  isWorkspaceTaskWorkspaceNavigation,
  taskWorkspaceNavigationAuthorityKey,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";
import type { TaskWorkspaceController } from "./contracts";
import type { TaskWorkspacePromptWorkspace } from "./taskWorkspaceHeaderProjection";
import {
  sharedBlockPromptMarkdown,
  sharedTaskPromptMarkdown
} from "./taskWorkspaceSharedProjection";
import {
  type TaskWorkspacePromptSourceReader,
  TaskWorkspacePromptDraft
} from "./taskWorkspacePromptDraft";

export type TaskWorkspacePromptAuthority = {
  canvasLocator: CanvasLocator | null;
  projectRoot: string | null;
  workspaceRoot: string | null;
};

export function useTaskWorkspacePromptDrafts({
  authority,
  navigation,
  workspace,
  workspaceCanvas
}: {
  authority: TaskWorkspacePromptAuthority;
  navigation: TaskWorkspaceNavigationIdentity | null;
  workspaceCanvas: WorkspaceCanvasCommandsResult | null;
  workspace: TaskWorkspacePromptWorkspace | null;
}) {
  const locator = authority.canvasLocator;
  const authorityKey = JSON.stringify([
    authority.projectRoot,
    authority.workspaceRoot,
    locator?.kind,
    locator?.projectId,
    locator?.canvasId,
    locator?.kind === "workspace" ? locator.connectionProfileId : null,
    locator?.kind === "workspace" ? locator.workspaceId : null
  ]);
  const sessionAuthority = locator?.kind === "workspace" ? workspaceCanvas?.sessionAuthority : null;
  const scope = useMemo<{
    key: string;
    sessionAuthority: object | null | undefined;
    confirmedProjection: CollaborationCanvasBindingReplicaProjection | null;
    sharedSource: { key: string; generation: number } | null;
  }>(
    () => ({ key: authorityKey, sessionAuthority, confirmedProjection: null, sharedSource: null }),
    [authorityKey, sessionAuthority]
  );
  const context = useRef({ scope, workspaceCanvas, mounted: true });
  const drafts = useRef(
    new Map<
      string,
      {
        scope: typeof scope;
        writer: TaskWorkspaceController["saveTaskPrompt"];
        readSource: TaskWorkspacePromptSourceReader;
        blockRef: string | null;
        navigationKey: string;
        draft: TaskWorkspacePromptDraft;
      }
    >()
  );
  useLayoutEffect(() => {
    context.current = { scope, workspaceCanvas, mounted: true };
    for (const [key, entry] of drafts.current) {
      if (entry.scope === scope) {
        entry.draft.activate(scope, entry.writer, entry.readSource);
      } else {
        entry.draft.deactivate();
        if (entry.draft.canRelease()) drafts.current.delete(key);
      }
    }
  }, [scope, workspaceCanvas]);
  useLayoutEffect(
    () => () => {
      context.current.mounted = false;
      for (const entry of drafts.current.values()) entry.draft.deactivate();
    },
    []
  );

  const matches =
    navigation &&
    locator &&
    (isWorkspaceTaskWorkspaceNavigation(navigation)
      ? locator.kind === "workspace" &&
        navigation.connectionProfileId === locator.connectionProfileId &&
        navigation.workspaceId === locator.workspaceId &&
        navigation.projectId === locator.projectId &&
        navigation.canvasId === locator.canvasId
      : locator.kind === "local" &&
        navigation.projectRoot === authority.projectRoot &&
        navigation.canvasId === locator.canvasId);
  const getWriteContext = useCallback(
    () =>
      matches && context.current.mounted && context.current.scope === scope
        ? context.current
        : null,
    [matches, scope]
  );
  const navigationKey = navigation ? taskWorkspaceNavigationAuthorityKey(navigation) : null;
  const getPromptDraft = useCallback(
    (
      blockRef: string | null,
      markdown: string,
      writer: TaskWorkspaceController["saveTaskPrompt"],
      readSource: TaskWorkspacePromptSourceReader
    ) => {
      if (!navigationKey) throw new Error("A prompt draft requires a Task Workspace identity.");
      const key = JSON.stringify([authorityKey, navigationKey, blockRef]);
      let entry = drafts.current.get(key);
      if (!entry) {
        entry = {
          scope,
          writer,
          readSource,
          blockRef,
          navigationKey,
          draft: new TaskWorkspacePromptDraft(markdown, writer, readSource)
        };
        drafts.current.set(key, entry);
      }
      entry.scope = scope;
      entry.writer = writer;
      entry.readSource = readSource;
      if (getWriteContext()) entry.draft.activate(scope, writer, readSource);
      return entry.draft;
    },
    [authorityKey, getWriteContext, navigationKey, scope]
  );
  const confirmProjection = useCallback(
    (projection: CollaborationCanvasBindingReplicaProjection) => {
      const current = getWriteContext();
      if (!current) return;
      const visible = current.workspaceCanvas?.projection;
      if (!visible || visible.authorityId !== projection.authorityId)
        throw new Error("The shared prompt authority changed before its save was confirmed.");
      const confirmed = scope.confirmedProjection;
      if (confirmed && confirmed.revision > projection.revision) return;
      if (
        confirmed &&
        confirmed.revision === projection.revision &&
        confirmed.contentDigest !== projection.contentDigest
      )
        throw new Error(
          "The shared prompt confirmation has conflicting content at the same revision."
        );
      scope.confirmedProjection = projection;
    },
    [getWriteContext, scope]
  );
  const getProjection = useCallback(() => {
    const current = getWriteContext();
    const projection = current?.workspaceCanvas?.projection ?? null;
    const confirmed = scope.confirmedProjection;
    if (
      current &&
      confirmed &&
      projection?.canEdit &&
      projection.authorityId === confirmed.authorityId &&
      projection.revision < confirmed.revision
    )
      return confirmed;
    return projection;
  }, [getWriteContext, scope]);

  const getSharedSource = useCallback(() => {
    const projection = getProjection();
    if (!projection) return null;
    const key = JSON.stringify([
      projection.authorityId,
      projection.revision,
      projection.contentDigest,
      projection.optimisticOperationIds
    ]);
    if (scope.sharedSource?.key !== key) {
      scope.sharedSource = { key, generation: (scope.sharedSource?.generation ?? 0) + 1 };
    }
    return { projection, generation: scope.sharedSource.generation };
  }, [getProjection, scope]);

  const shared = workspaceCanvas?.enabled === true;
  const visibleProjection = workspaceCanvas?.projection;
  const taskId = navigation?.taskId;
  useLayoutEffect(() => {
    if (!workspace || !taskId || !getWriteContext()) return;
    const local = shared ? undefined : workspace.local;
    const sharedSource = shared && visibleProjection ? getSharedSource() : null;
    const projection = sharedSource?.projection ?? null;
    const generation = sharedSource?.generation ?? local?.generation;
    if (generation === undefined) return;
    for (const entry of drafts.current.values()) {
      if (entry.scope !== scope || entry.navigationKey !== navigationKey) continue;
      const { blockRef } = entry;
      const markdown = local
        ? (blockRef ? local.blocks.get(blockRef) : local.task)?.promptMarkdown
        : blockRef
          ? sharedBlockPromptMarkdown(projection, workspace, blockRef)
          : sharedTaskPromptMarkdown(projection, workspace, taskId);
      if (markdown != null) entry.draft.acceptSource(scope, generation, markdown);
    }
  }, [
    getSharedSource,
    getWriteContext,
    navigationKey,
    scope,
    shared,
    taskId,
    visibleProjection,
    workspace
  ]);
  return { confirmProjection, getProjection, getSharedSource, getPromptDraft, getWriteContext };
}
