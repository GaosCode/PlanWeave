import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { TaskNodeData } from "../types";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

export type PromptConflictRef = {
  projectRoot: string;
  canvasId: string | null;
  taskId: string;
  title: string;
  draft: string;
  remote: string;
};

type PromptBase = { graphVersion?: string; promptHash?: string; markdown: string };
type PromptWrite = {
  revision: number;
  markdown: string;
  previousBase: PromptBase;
  confirmed: boolean;
  settled: boolean;
  observedBase?: PromptBase;
  conflictRevision?: number;
  promise?: Promise<void>;
};
type PromptDraft = {
  taskId: string;
  title: string;
  draft: string;
  revision: number;
  retiredRevision?: number;
  base: PromptBase;
  saveState: TaskNodeData["saveState"];
  conflict?: PromptConflictRef;
  conflictRevision: number;
  inFlight?: PromptWrite;
};
type PromptScope = {
  id: string;
  projectRoot: string;
  canvasId: string | null;
  tasks: Map<string, PromptDraft>;
  graph: DesktopGraphViewModel;
};
type PromptSnapshot = {
  promptDrafts: Record<string, string>;
  promptConflicts: PromptConflictRef[];
  saveStates: Record<string, TaskNodeData["saveState"]>;
};

function samePrompt(base: PromptBase, remote: PromptBase) {
  return base.markdown === remote.markdown && base.promptHash === remote.promptHash;
}

function completeWrite(draft: PromptDraft, write: PromptWrite) {
  if (draft.inFlight !== write || !write.confirmed || !write.settled) return;
  const newConflict =
    draft.conflict &&
    (write.conflictRevision === undefined || draft.conflictRevision !== write.conflictRevision);
  if (!write.observedBase && !newConflict) return;
  if (write.observedBase) {
    draft.base = write.observedBase;
    if (write.conflictRevision !== undefined && draft.conflictRevision === write.conflictRevision) {
      draft.conflict = undefined;
    }
  }
  draft.inFlight = undefined;
  draft.saveState = draft.conflict
    ? "error"
    : draft.revision === write.revision && draft.draft === write.markdown
      ? "saved"
      : "idle";
}

export function useTaskPromptDrafts({
  graph,
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setError,
  workspaceCanvas
}: {
  graph: DesktopGraphViewModel | null;
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  workspaceCanvas: WorkspaceCanvasCommandsResult | null;
}) {
  const scopeRef = useRef<PromptScope | null>(null);
  const workspaceCanvasRef = useRef(workspaceCanvas);
  useEffect(() => {
    workspaceCanvasRef.current = workspaceCanvas;
  }, [workspaceCanvas]);
  const [snapshot, setSnapshot] = useState<PromptSnapshot>({
    promptDrafts: {},
    promptConflicts: [],
    saveStates: {}
  });
  const publish = useCallback(() => {
    const tasks = Array.from(scopeRef.current?.tasks.values() ?? []);
    setSnapshot({
      promptDrafts: Object.fromEntries(tasks.map((task) => [task.taskId, task.draft])),
      promptConflicts: tasks.flatMap((task) => (task.conflict ? [task.conflict] : [])),
      saveStates: Object.fromEntries(tasks.map((task) => [task.taskId, task.saveState]))
    });
  }, []);

  useEffect(() => {
    if (!graph || !selectedProject) {
      scopeRef.current = null;
      publish();
      return;
    }
    const id = JSON.stringify([
      selectedProject.projectId,
      selectedProject.rootPath,
      selectedCanvasId
    ]);
    let scope = scopeRef.current;
    if (!scope || scope.id !== id) {
      scope = {
        id,
        projectRoot: selectedProject.rootPath,
        canvasId: selectedCanvasId,
        tasks: new Map(),
        graph
      };
      scopeRef.current = scope;
    } else if (scope.graph === graph) {
      return;
    }
    scope.graph = graph;
    const taskIds = new Set(graph.tasks.map((task) => task.taskId));
    for (const taskId of scope.tasks.keys()) {
      if (!taskIds.has(taskId)) scope.tasks.delete(taskId);
    }
    for (const task of graph.tasks) {
      const remote: PromptBase = {
        graphVersion: graph.graphVersion,
        promptHash: task.promptHash,
        markdown: task.promptMarkdown
      };
      const draft = scope.tasks.get(task.taskId);
      if (!draft) {
        scope.tasks.set(task.taskId, {
          taskId: task.taskId,
          title: task.title,
          draft: remote.markdown,
          revision: 0,
          base: remote,
          saveState: "idle",
          conflictRevision: 0
        });
        continue;
      }
      draft.title = task.title;
      const write = draft.inFlight;
      // The graph prop may still precede the active write and its authoritative readback.
      if (write && remote.markdown !== write.markdown && samePrompt(write.previousBase, remote))
        continue;
      if (write && remote.markdown === write.markdown) {
        // A watcher may observe our write before its promise settles.
        write.observedBase = remote;
        draft.base = remote;
        completeWrite(draft, write);
      } else if (samePrompt(draft.base, remote)) {
        draft.base = remote;
      } else if (draft.draft === draft.base.markdown && !write && !draft.conflict) {
        draft.draft = remote.markdown;
        draft.base = remote;
        draft.saveState = "idle";
      } else if (draft.draft === remote.markdown && !write && !draft.conflict) {
        draft.base = remote;
        draft.saveState = "idle";
      } else {
        draft.conflictRevision += 1;
        draft.conflict = {
          projectRoot: scope.projectRoot,
          canvasId: scope.canvasId,
          taskId: task.taskId,
          title: task.title,
          draft: draft.draft,
          remote: remote.markdown
        };
        draft.saveState = "error";
        if (write?.settled) draft.inFlight = undefined;
      }
    }
    publish();
  }, [graph, publish, selectedCanvasId, selectedProject]);

  useEffect(
    () => () => {
      scopeRef.current = null;
    },
    []
  );

  const handlePromptChange = useCallback(
    (taskId: string, value: string) => {
      const draft = scopeRef.current?.tasks.get(taskId);
      if (!draft || draft.draft === value) return;
      draft.draft = value;
      draft.revision += 1;
      if (draft.conflict) draft.conflict = { ...draft.conflict, draft: value };
      draft.saveState = draft.inFlight ? "saving" : "idle";
      publish();
    },
    [publish]
  );

  const savePrompt = useCallback(
    async (taskId: string, force = false): Promise<void> => {
      const scope = scopeRef.current;
      const draft = scope?.tasks.get(taskId);
      if (!scope || !draft || !selectedProject) return;
      if (draft.inFlight) {
        await draft.inFlight.promise;
        if (
          !force ||
          scopeRef.current !== scope ||
          scope.tasks.get(taskId) !== draft ||
          draft.inFlight
        )
          return;
      }
      if (
        !force &&
        (draft.conflict || (draft.draft === draft.base.markdown && draft.saveState !== "error"))
      )
        return;
      const write: PromptWrite = {
        revision: draft.revision,
        markdown: draft.draft,
        previousBase: draft.base,
        confirmed: false,
        settled: false,
        conflictRevision: force ? draft.conflictRevision : undefined
      };
      draft.inFlight = write;
      draft.saveState = "saving";
      publish();
      const isCurrent = () => scopeRef.current === scope && scope.tasks.get(taskId) === draft;
      const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
      write.promise = (async () => {
        try {
          const mode = await runDurablePackageWrite({
            workspaceCanvas,
            intent: { kind: "update_task_prompt", taskId, promptMarkdown: write.markdown },
            onError: (message) => {
              throw new Error(message ?? "Task prompt write failed");
            },
            localWrite: async () => {
              if (!bridge) throw new Error("Desktop bridge is unavailable");
              const result = await bridge.updateTaskPrompt(
                canvasRef,
                taskId,
                write.markdown,
                force
                  ? undefined
                  : {
                      baseGraphVersion: write.previousBase.graphVersion,
                      basePromptHash: write.previousBase.promptHash
                    }
              );
              if (!result.ok) {
                if (
                  isCurrent() &&
                  result.diagnostics.some(
                    (diagnostic) => diagnostic.code === "graph_version_conflict"
                  )
                ) {
                  const remote = await bridge.getTaskDetail(canvasRef, taskId);
                  if (isCurrent()) {
                    draft.conflictRevision += 1;
                    draft.conflict = {
                      projectRoot: scope.projectRoot,
                      canvasId: scope.canvasId,
                      taskId,
                      title: draft.title,
                      draft: draft.draft,
                      remote: remote.promptMarkdown
                    };
                  }
                }
                throw new Error(
                  result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
                );
              }
            }
          });
          if (!isCurrent()) return;
          if (mode === "retired") {
            draft.inFlight = undefined;
            draft.retiredRevision = draft.revision;
            draft.saveState = "idle";
            publish();
            return;
          }
          if (mode === "failed") throw new Error("Task prompt write failed");
          if (mode === "local") {
            if (!bridge) throw new Error("Desktop bridge is unavailable");
            const remote = await bridge.getTaskDetail(canvasRef, taskId);
            if (!isCurrent()) return;
            if (remote.promptMarkdown !== write.markdown) {
              draft.conflictRevision += 1;
              draft.conflict = {
                projectRoot: scope.projectRoot,
                canvasId: scope.canvasId,
                taskId,
                title: draft.title,
                draft: draft.draft,
                remote: remote.promptMarkdown
              };
              throw new Error("Task prompt changed before the saved version could be confirmed");
            }
            write.observedBase = {
              graphVersion: remote.graphVersion,
              promptHash: remote.promptHash,
              markdown: remote.promptMarkdown
            };
            draft.base = write.observedBase;
          }
          write.confirmed = true;
          await refreshGraph();
          if (!isCurrent()) return;
          write.settled = true;
          completeWrite(draft, write);
          publish();
        } catch (caught) {
          if (!isCurrent()) return;
          draft.inFlight = undefined;
          draft.saveState = draft.conflict || draft.revision === write.revision ? "error" : "idle";
          setError(caught instanceof Error ? caught.message : String(caught));
          publish();
        }
      })();
      await write.promise;
    },
    [publish, refreshGraph, selectedCanvasId, selectedProject, setError, workspaceCanvas]
  );

  const handlePromptSave = useCallback((taskId: string) => savePrompt(taskId), [savePrompt]);

  const reloadPromptConflicts = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || !selectedProject) return;
    const shared = Boolean(workspaceCanvasRef.current?.enabled);
    const authorityId = workspaceCanvasRef.current?.projection?.authorityId;
    const isCurrent = () =>
      scopeRef.current === scope && Boolean(workspaceCanvasRef.current?.enabled) === shared;
    const targets = Array.from(scope.tasks.values())
      .filter((draft) => draft.conflict)
      .map((draft) => ({ draft, revision: draft.revision }));
    if (targets.length === 0) return;
    try {
      for (const { draft } of targets) {
        if (draft.inFlight) await draft.inFlight.promise;
        if (!isCurrent()) return;
        if (draft.inFlight)
          throw new Error("Task prompt is still awaiting authoritative confirmation");
      }
      await refreshGraph();
      if (!isCurrent()) return;
      const replacements: Array<{ draft: PromptDraft; revision: number; base: PromptBase }> = [];
      for (const target of targets) {
        if (scope.tasks.get(target.draft.taskId) !== target.draft) continue;
        let base: PromptBase;
        if (shared) {
          const projection = workspaceCanvasRef.current?.projection;
          if (!projection) throw new Error("Shared canvas projection is unavailable");
          if (authorityId && authorityId !== projection.authorityId) return;
          const projectId =
            "bindingKind" in projection ? projection.projectId : projection.localProjectId;
          const canvasId =
            "bindingKind" in projection ? projection.canvasId : projection.localCanvasId;
          if (
            projectId !== selectedProject.projectId ||
            canvasId !== (selectedCanvasId ?? "default")
          ) {
            throw new Error("Shared canvas projection does not match the selected canvas");
          }
          const task = projection.content.tasks.find((task) => task.taskId === target.draft.taskId);
          if (!task) throw new Error("Task is missing from the shared canvas projection");
          base = {
            graphVersion: projection.content.graphVersion,
            promptHash: task.promptHash,
            markdown: task.promptMarkdown
          };
        } else {
          if (!bridge) throw new Error("Desktop bridge is unavailable");
          const task = await bridge.getTaskDetail(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            target.draft.taskId
          );
          base = {
            graphVersion: task.graphVersion,
            promptHash: task.promptHash,
            markdown: task.promptMarkdown
          };
        }
        if (!isCurrent()) return;
        replacements.push({ ...target, base });
      }
      for (const { draft, revision, base } of replacements) {
        if (
          scope.tasks.get(draft.taskId) !== draft ||
          draft.revision !== revision ||
          draft.inFlight
        )
          continue;
        draft.draft = base.markdown;
        draft.revision += 1;
        draft.base = base;
        draft.conflict = undefined;
        draft.saveState = "idle";
      }
      publish();
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [publish, refreshGraph, selectedCanvasId, selectedProject, setError]);

  const keepLocalPromptConflicts = useCallback(() => {
    for (const draft of scopeRef.current?.tasks.values() ?? []) {
      if (draft.conflict) draft.saveState = "error";
    }
    publish();
  }, [publish]);

  const applyLocalPromptConflicts = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope) return;
    for (const draft of scope.tasks.values()) {
      if (scopeRef.current !== scope) return;
      if (draft.conflict) {
        await savePrompt(draft.taskId, true);
        if (draft.conflict || draft.saveState === "error") return;
      }
    }
  }, [savePrompt]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || !selectedProject || (!bridge && !workspaceCanvas?.enabled)) return;
    const dirtyTaskIds = Object.keys(snapshot.promptDrafts).filter((taskId) => {
      const draft = scope.tasks.get(taskId);
      return (
        draft &&
        draft.draft !== draft.base.markdown &&
        !draft.conflict &&
        !draft.inFlight &&
        draft.retiredRevision !== draft.revision &&
        draft.saveState === "idle"
      );
    });
    if (dirtyTaskIds.length === 0) return;
    const timer = window.setTimeout(() => {
      if (scopeRef.current !== scope) return;
      for (const taskId of dirtyTaskIds) void handlePromptSave(taskId);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [handlePromptSave, selectedProject, snapshot, workspaceCanvas?.enabled]);

  return {
    ...snapshot,
    handlePromptChange,
    handlePromptSave,
    reloadPromptConflicts,
    keepLocalPromptConflicts,
    applyLocalPromptConflicts
  };
}
