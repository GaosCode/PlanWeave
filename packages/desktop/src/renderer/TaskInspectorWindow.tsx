import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopAutoRunEvent } from "@planweave-ai/runtime";
import type { DesktopGraphViewModel, DesktopTaskDetail } from "@planweave-ai/runtime";
import { autoRunEventMatchesCanvas } from "./autoRunEvents";
import { bridge } from "./bridge";
import { createTranslator, type Language } from "./i18n";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { TaskInspector } from "./inspector/TaskInspector";

function supportedLanguage(value: string | null): Language {
  return value === "en" || value === "zh-CN" ? value : "zh-CN";
}

function taskBlockRefs(taskId: string, graph: DesktopGraphViewModel | null, task: DesktopTaskDetail | null): Set<string> {
  const refs = new Set<string>();
  for (const blockRef of task?.blockOrder ?? []) {
    refs.add(blockRef);
  }
  const graphTask = graph?.tasks.find((candidate) => candidate.taskId === taskId);
  for (const block of graphTask?.blocks ?? []) {
    refs.add(block.ref);
  }
  return refs;
}

function eventMatchesTask(event: DesktopAutoRunEvent, taskId: string, graph: DesktopGraphViewModel | null, task: DesktopTaskDetail | null): boolean {
  const refs = taskBlockRefs(taskId, graph, task);
  if (refs.size === 0) {
    return true;
  }
  if (event.currentRef && refs.has(event.currentRef)) {
    return true;
  }
  return Boolean(event.latestRecordId && [...refs].some((ref) => event.latestRecordId?.startsWith(`${ref}::`)));
}

export function TaskInspectorWindow() {
  const search = window.location.search;
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const projectRoot = params.get("projectRoot") ?? "";
  const taskId = params.get("taskId") ?? "";
  const canvasId = params.get("canvasId");
  const language = supportedLanguage(params.get("language"));
  const t = useMemo(() => createTranslator(language), [language]);
  const { executorOptions } = useDetectedAgents();
  const [selectedTask, setSelectedTask] = useState<DesktopTaskDetail | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [draftDirty, setDraftDirty] = useState(false);
  const draftDirtyRef = useRef(false);

  const updateDraftDirty = useCallback((nextDraftDirty: boolean) => {
    draftDirtyRef.current = nextDraftDirty;
    setDraftDirty(nextDraftDirty);
  }, []);

  const loadTask = useCallback(async (options: { skipCommitWhenDirty?: boolean } = {}) => {
    if (!bridge || !projectRoot || !taskId) {
      return;
    }
    const canvas = { projectRoot, canvasId };
    try {
      const [nextGraph, task] = await Promise.all([
        bridge.getGraphViewModel(canvas),
        bridge.getTaskDetail(canvas, taskId)
      ]);
      if (options.skipCommitWhenDirty && draftDirtyRef.current) {
        return;
      }
      setGraph(nextGraph);
      setSelectedTask(task);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [canvasId, projectRoot, taskId]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  useEffect(() => {
    if (!bridge || draftDirty || !projectRoot || !taskId) {
      return undefined;
    }
    return bridge.onAutoRunChanged((event) => {
      if (!autoRunEventMatchesCanvas(event, projectRoot, canvasId) || !eventMatchesTask(event, taskId, graph, selectedTask)) {
        return;
      }
      void loadTask({ skipCommitWhenDirty: true });
    });
  }, [canvasId, draftDirty, graph, loadTask, projectRoot, selectedTask, taskId]);

  const saveSelectedTaskTitle = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedTask) {
      return;
    }
    const result = await bridge.updateTaskTitle({ projectRoot, canvasId }, selectedTask.taskId, selectedTask.title);
    if (!result.ok) {
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await loadTask();
  }, [canvasId, loadTask, projectRoot, selectedTask]);

  const saveSelectedTaskExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !projectRoot || !selectedTask) {
        return;
      }
      const result = await bridge.updateTaskExecutor({ projectRoot, canvasId }, selectedTask.taskId, executorName);
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await loadTask();
    },
    [canvasId, loadTask, projectRoot, selectedTask]
  );

  const saveSelectedTaskPrompt = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedTask) {
      return;
    }
    const result = await bridge.updateTaskPrompt({ projectRoot, canvasId }, selectedTask.taskId, selectedTask.promptMarkdown);
    if (!result.ok) {
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await loadTask();
  }, [canvasId, loadTask, projectRoot, selectedTask]);

  return (
    <TaskInspector
      className="inset-0 h-screen w-screen min-w-0 rounded-none border-0 shadow-none ring-0"
      error={error}
      executorOptions={executorOptions}
      graph={graph}
      onClose={() => window.close()}
      onDraftDirtyChange={updateDraftDirty}
      saveSelectedTaskExecutor={saveSelectedTaskExecutor}
      saveSelectedTaskPrompt={saveSelectedTaskPrompt}
      saveSelectedTaskTitle={saveSelectedTaskTitle}
      selectedTask={selectedTask}
      setSelectedTask={setSelectedTask}
      t={t}
    />
  );
}
