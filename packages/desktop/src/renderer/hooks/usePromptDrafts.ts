import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import { useTaskPromptDrafts } from "./useTaskPromptDrafts";
export type { PromptConflictRef } from "./useTaskPromptDrafts";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

type UsePromptDraftsArgs = {
  graph: DesktopGraphViewModel | null;
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  /** When enabled, task title/prompt writes go through Workspace Canvas commands. */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

export function usePromptDrafts({
  graph,
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setError,
  workspaceCanvas = null
}: UsePromptDraftsArgs) {
  const draftScopeId = useRef<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [titleBase, setTitleBase] = useState<
    Record<string, { graphVersion: string; title: string }>
  >({});
  const titleDraftsRef = useRef(titleDrafts);
  const titleBaseRef = useRef(titleBase);
  const prompts = useTaskPromptDrafts({
    graph,
    refreshGraph,
    selectedCanvasId,
    selectedProject,
    setError,
    workspaceCanvas
  });

  useEffect(() => {
    titleDraftsRef.current = titleDrafts;
  }, [titleDrafts]);

  useEffect(() => {
    titleBaseRef.current = titleBase;
  }, [titleBase]);

  useEffect(() => {
    if (!graph || !selectedProject) {
      setTitleDrafts({});
      setTitleBase({});
      draftScopeId.current = null;
      return;
    }

    const nextScopeId = `${selectedProject.projectId}:${selectedCanvasId ?? "default"}`;
    const scopeChanged = draftScopeId.current !== nextScopeId;
    draftScopeId.current = nextScopeId;
    const currentTitleDrafts = titleDraftsRef.current;
    const currentTitleBase = titleBaseRef.current;

    setTitleDrafts((current) =>
      scopeChanged
        ? Object.fromEntries(graph.tasks.map((task) => [task.taskId, task.title]))
        : Object.fromEntries(
            graph.tasks.map((task) => {
              const base = currentTitleBase[task.taskId];
              const draft = current[task.taskId];
              const dirty = draft !== undefined && base && draft !== base.title;
              if (dirty && task.title !== draft) {
                return [task.taskId, draft];
              }
              return [task.taskId, task.title];
            })
          )
    );
    setTitleBase((current) =>
      scopeChanged
        ? Object.fromEntries(
            graph.tasks.map((task) => [
              task.taskId,
              { graphVersion: graph.graphVersion, title: task.title }
            ])
          )
        : Object.fromEntries(
            graph.tasks.map((task) => {
              const base = current[task.taskId];
              const draft = currentTitleDrafts[task.taskId];
              const dirty = draft !== undefined && base && draft !== base.title;
              if (dirty && task.title !== draft) {
                return [task.taskId, base];
              }
              return [task.taskId, { graphVersion: graph.graphVersion, title: task.title }];
            })
          )
    );
  }, [graph, selectedCanvasId, selectedProject]);

  const handleTitleChange = useCallback((taskId: string, value: string) => {
    setTitleDrafts((current) => ({ ...current, [taskId]: value }));
  }, []);

  const handleTitleSave = useCallback(
    async (taskId: string) => {
      if (!selectedProject) {
        return;
      }
      try {
        const title = titleDrafts[taskId] ?? "";
        const mode = await runDurablePackageWrite({
          workspaceCanvas,
          intent: {
            kind: "update_task_fields",
            taskId,
            fields: { title }
          },
          onError: setError,
          localWrite: async () => {
            if (!bridge) return;
            await bridge.updateTaskTitle(
              desktopCanvasReference(selectedProject, selectedCanvasId),
              taskId,
              title
            );
          }
        });
        if (mode === "failed" || mode === "retired") return;
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError, workspaceCanvas, titleDrafts]
  );

  return {
    ...prompts,
    handleTitleChange,
    handleTitleSave,
    titleDrafts
  };
}
