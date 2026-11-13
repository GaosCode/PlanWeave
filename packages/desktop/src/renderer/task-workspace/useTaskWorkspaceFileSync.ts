import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesktopBridgeApi, TaskWorkspace } from "@planweave-ai/runtime";
import type { PackageFileSyncCompletion } from "../hooks/usePackageFileSync";
import {
  isWorkspaceTaskWorkspaceNavigation,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";
import type { TaskWorkspacePromptAuthority } from "./useTaskWorkspacePromptDrafts";

type PromptHeader = { header: TaskWorkspace; generation: number };

export function useTaskWorkspaceFileSync({
  api,
  authority,
  navigation,
  nextGeneration,
  planweaveHome,
  setError
}: {
  api: Pick<DesktopBridgeApi, "getTaskWorkspace"> | null;
  authority: TaskWorkspacePromptAuthority;
  navigation: TaskWorkspaceNavigationIdentity | null;
  nextGeneration: () => number;
  planweaveHome?: string;
  setError?: (message: string | null) => void;
}) {
  const local = navigation && !isWorkspaceTaskWorkspaceNavigation(navigation) ? navigation : null;
  const { projectRoot, workspaceRoot, canvasLocator } = authority;
  const canvasId =
    canvasLocator?.kind === "local" && local?.canvasId === canvasLocator.canvasId
      ? local.canvasId
      : null;
  const projectId = canvasLocator?.kind === "local" ? canvasLocator.projectId : null;
  const taskId = local?.projectRoot === projectRoot ? local.taskId : null;
  const scope = useMemo(
    () =>
      api && projectRoot && workspaceRoot && canvasId && projectId && taskId
        ? { api, projectRoot, workspaceRoot, canvasId, projectId, taskId, planweaveHome }
        : null,
    [api, canvasId, planweaveHome, projectId, projectRoot, taskId, workspaceRoot]
  );
  const active = useRef({ scope, generation: 0 });
  useLayoutEffect(() => {
    active.current = { scope, generation: 0 };
    return () => {
      active.current = { scope: null, generation: 0 };
    };
  }, [scope]);
  const [accepted, setAccepted] = useState<{ scope: NonNullable<typeof scope> } & PromptHeader>();
  const refreshLocalPrompts = useCallback<PackageFileSyncCompletion>(
    (result, syncIsCurrent) => {
      if (!scope || active.current.scope !== scope || !syncIsCurrent() || result.primed) return;
      const { api, projectRoot, canvasId, projectId, taskId } = scope;
      if (
        !result.affectedTasks.includes(taskId) &&
        !result.dirtyPromptRefs.some((ref) => ref === taskId || ref.startsWith(`${taskId}#`))
      )
        return;
      const generation = nextGeneration();
      active.current.generation = generation;
      const isCurrent = () =>
        active.current.scope === scope &&
        active.current.generation === generation &&
        syncIsCurrent();
      void api
        .getTaskWorkspace({ projectRoot, canvasId, taskId })
        .then((header) => {
          if (!isCurrent()) return;
          if (
            "authority" in header.project ||
            header.project.projectRoot !== projectRoot ||
            header.project.projectId !== projectId ||
            header.project.canvasId !== canvasId ||
            header.task.taskId !== taskId
          ) {
            throw new Error("The loaded prompts do not match this Task Workspace.");
          }
          setAccepted({ scope, generation, header });
        })
        .catch((error: unknown) => {
          if (isCurrent()) setError?.(error instanceof Error ? error.message : String(error));
        });
    },
    [nextGeneration, scope, setError]
  );
  return {
    promptHeader: accepted && accepted.scope === scope ? accepted : null,
    refreshLocalPrompts
  };
}
