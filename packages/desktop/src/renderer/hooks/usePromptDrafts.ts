import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { TaskNodeData } from "../types";
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

export type PromptConflictRef = {
  taskId: string;
  title: string;
  draft: string;
  remote: string;
};

function graphTask(graph: DesktopGraphViewModel | null, taskId: string) {
  return graph?.tasks.find((task) => task.taskId === taskId) ?? null;
}

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
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptBase, setPromptBase] = useState<
    Record<string, { graphVersion: string; promptHash: string; markdown: string }>
  >({});
  const [promptConflicts, setPromptConflicts] = useState<Record<string, PromptConflictRef>>({});
  const [saveStates, setSaveStates] = useState<Record<string, TaskNodeData["saveState"]>>({});
  const titleDraftsRef = useRef(titleDrafts);
  const titleBaseRef = useRef(titleBase);
  const promptDraftsRef = useRef(promptDrafts);
  const promptBaseRef = useRef(promptBase);

  useEffect(() => {
    titleDraftsRef.current = titleDrafts;
  }, [titleDrafts]);

  useEffect(() => {
    titleBaseRef.current = titleBase;
  }, [titleBase]);

  useEffect(() => {
    promptDraftsRef.current = promptDrafts;
  }, [promptDrafts]);

  useEffect(() => {
    promptBaseRef.current = promptBase;
  }, [promptBase]);

  useEffect(() => {
    if (!graph || !selectedProject) {
      setTitleDrafts({});
      setTitleBase({});
      setPromptDrafts({});
      setPromptBase({});
      setPromptConflicts({});
      setSaveStates({});
      draftScopeId.current = null;
      return;
    }

    const nextScopeId = `${selectedProject.projectId}:${selectedCanvasId ?? "default"}`;
    const scopeChanged = draftScopeId.current !== nextScopeId;
    draftScopeId.current = nextScopeId;
    const taskIds = new Set(graph.tasks.map((task) => task.taskId));
    const currentTitleDrafts = titleDraftsRef.current;
    const currentTitleBase = titleBaseRef.current;
    const currentBase = promptBaseRef.current;
    const currentDrafts = promptDraftsRef.current;

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
    setPromptDrafts((current) =>
      scopeChanged
        ? Object.fromEntries(graph.tasks.map((task) => [task.taskId, task.promptMarkdown]))
        : Object.fromEntries(
            graph.tasks.map((task) => {
              const base = currentBase[task.taskId];
              const draft = current[task.taskId];
              const remoteChanged = base && base.promptHash !== (task.promptHash ?? "");
              const dirty = draft !== undefined && base && draft !== base.markdown;
              if (dirty && (!remoteChanged || task.promptMarkdown !== draft)) {
                return [task.taskId, draft];
              }
              return [task.taskId, task.promptMarkdown];
            })
          )
    );
    setPromptBase((current) =>
      scopeChanged
        ? Object.fromEntries(
            graph.tasks.map((task) => [
              task.taskId,
              {
                graphVersion: graph.graphVersion,
                promptHash: task.promptHash ?? "",
                markdown: task.promptMarkdown
              }
            ])
          )
        : Object.fromEntries(
            graph.tasks.map((task) => {
              const base = current[task.taskId];
              const draft = currentDrafts[task.taskId];
              const remoteChanged = base && base.promptHash !== (task.promptHash ?? "");
              const dirty = draft !== undefined && base && draft !== base.markdown;
              if (dirty && (!remoteChanged || task.promptMarkdown !== draft)) {
                return [task.taskId, base];
              }
              return [
                task.taskId,
                {
                  graphVersion: graph.graphVersion,
                  promptHash: task.promptHash ?? "",
                  markdown: task.promptMarkdown
                }
              ];
            })
          )
    );
    setPromptConflicts((current) => {
      if (scopeChanged) {
        return {};
      }
      const next: Record<string, PromptConflictRef> = {};
      for (const task of graph.tasks) {
        const base = currentBase[task.taskId];
        const draft = currentDrafts[task.taskId];
        if (
          draft !== undefined &&
          base &&
          base.promptHash !== (task.promptHash ?? "") &&
          draft !== base.markdown &&
          task.promptMarkdown !== draft
        ) {
          next[task.taskId] = {
            taskId: task.taskId,
            title: task.title,
            draft,
            remote: task.promptMarkdown
          };
        } else if (current[task.taskId] && taskIds.has(task.taskId)) {
          next[task.taskId] = current[task.taskId];
        }
      }
      return next;
    });
    setSaveStates((current) =>
      scopeChanged
        ? {}
        : Object.fromEntries(Object.entries(current).filter(([taskId]) => taskIds.has(taskId)))
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
        if (mode === "failed") return;
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError, workspaceCanvas, titleDrafts]
  );

  const handlePromptChange = useCallback((taskId: string, value: string) => {
    setPromptDrafts((current) => ({ ...current, [taskId]: value }));
    setPromptConflicts((current) => {
      const { [taskId]: _removed, ...rest } = current;
      return rest;
    });
    setSaveStates((current) => ({ ...current, [taskId]: "idle" }));
  }, []);

  const handlePromptSave = useCallback(
    async (taskId: string) => {
      if (!selectedProject) {
        return;
      }
      setSaveStates((current) => ({ ...current, [taskId]: "saving" }));
      try {
        const task = graphTask(graph, taskId);
        const base =
          promptBase[taskId] ??
          (task
            ? {
                graphVersion: graph?.graphVersion ?? "",
                promptHash: task.promptHash ?? "",
                markdown: task.promptMarkdown
              }
            : undefined);
        const markdown = promptDrafts[taskId] ?? "";
        const mode = await runDurablePackageWrite({
          workspaceCanvas,
          intent: {
            kind: "update_task_prompt",
            taskId,
            promptMarkdown: markdown
          },
          onError: (message) => {
            setSaveStates((current) => ({ ...current, [taskId]: "error" }));
            setError(message);
          },
          localWrite: async () => {
            if (!bridge) return;
            const result = await bridge.updateTaskPrompt(
              desktopCanvasReference(selectedProject, selectedCanvasId),
              taskId,
              markdown,
              {
                baseGraphVersion: base?.graphVersion,
                basePromptHash: base?.promptHash
              }
            );
            if (!result.ok) {
              setSaveStates((current) => ({ ...current, [taskId]: "error" }));
              if (
                result.diagnostics.some(
                  (diagnostic) => diagnostic.code === "graph_version_conflict"
                )
              ) {
                setPromptConflicts((current) => ({
                  ...current,
                  [taskId]: {
                    taskId,
                    title: task?.title ?? taskId,
                    draft: markdown,
                    remote: task?.promptMarkdown ?? base?.markdown ?? ""
                  }
                }));
              }
              throw new Error(
                result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              );
            }
          }
        });
        if (mode === "failed") return;
        const savedMarkdown = markdown;
        setPromptBase((current) => ({
          ...current,
          [taskId]: {
            graphVersion: base?.graphVersion ?? graph?.graphVersion ?? "",
            promptHash: task?.promptHash ?? base?.promptHash ?? "",
            markdown: savedMarkdown
          }
        }));
        setSaveStates((current) => ({ ...current, [taskId]: "saved" }));
        setPromptConflicts((current) => {
          const { [taskId]: _removed, ...rest } = current;
          return rest;
        });
        await refreshGraph();
      } catch (caught) {
        setSaveStates((current) => ({ ...current, [taskId]: "error" }));
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      graph,
      promptBase,
      promptDrafts,
      refreshGraph,
      selectedCanvasId,
      selectedProject,
      setError,
      workspaceCanvas
    ]
  );

  const reloadPromptConflicts = useCallback(async () => {
    if (graph) {
      setPromptDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.keys(promptConflicts).flatMap((taskId) => {
            const task = graphTask(graph, taskId);
            return task ? [[taskId, task.promptMarkdown]] : [];
          })
        )
      }));
      setPromptBase((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.keys(promptConflicts).flatMap((taskId) => {
            const task = graphTask(graph, taskId);
            return task
              ? [
                  [
                    taskId,
                    {
                      graphVersion: graph.graphVersion,
                      promptHash: task.promptHash ?? "",
                      markdown: task.promptMarkdown
                    }
                  ]
                ]
              : [];
          })
        )
      }));
    }
    setPromptConflicts({});
    setSaveStates((current) => ({
      ...current,
      ...Object.fromEntries(Object.keys(promptConflicts).map((taskId) => [taskId, "idle" as const]))
    }));
    await refreshGraph();
  }, [graph, promptConflicts, refreshGraph]);

  const keepLocalPromptConflicts = useCallback(() => {
    setSaveStates((current) => ({
      ...current,
      ...Object.fromEntries(
        Object.keys(promptConflicts).map((taskId) => [taskId, "error" as const])
      )
    }));
  }, [promptConflicts]);

  const applyLocalPromptConflicts = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    for (const conflict of Object.values(promptConflicts)) {
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_task_prompt",
          taskId: conflict.taskId,
          promptMarkdown: conflict.draft
        },
        onError: setError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateTaskPrompt(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            conflict.taskId,
            conflict.draft
          );
          if (!result.ok) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }
        }
      });
      if (mode === "failed") return;
    }
    setPromptConflicts({});
    await refreshGraph();
  }, [promptConflicts, refreshGraph, selectedCanvasId, selectedProject, setError, workspaceCanvas]);

  useEffect(() => {
    if (!bridge || !selectedProject || !graph) {
      return undefined;
    }
    const dirtyTaskIds = graph.tasks
      .filter((task) => {
        const draft = promptDrafts[task.taskId];
        return (
          draft !== undefined &&
          draft !== task.promptMarkdown &&
          !promptConflicts[task.taskId] &&
          (saveStates[task.taskId] ?? "idle") === "idle"
        );
      })
      .map((task) => task.taskId);
    if (dirtyTaskIds.length === 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      for (const taskId of dirtyTaskIds) {
        void handlePromptSave(taskId);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [graph, handlePromptSave, promptConflicts, promptDrafts, saveStates, selectedProject]);

  return {
    applyLocalPromptConflicts,
    handlePromptChange,
    handlePromptSave,
    handleTitleChange,
    handleTitleSave,
    keepLocalPromptConflicts,
    promptDrafts,
    promptConflicts: Object.values(promptConflicts),
    reloadPromptConflicts,
    saveStates,
    titleDrafts
  };
}
