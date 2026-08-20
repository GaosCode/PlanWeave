import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopAutoRunEvent } from "@planweave-ai/runtime";
import type { DesktopGraphViewModel, DesktopTaskDetail } from "@planweave-ai/runtime";
import { autoRunEventMatchesCanvas } from "./autoRunEvents";
import { bridge, collaborationBridge } from "./bridge";
import { runDurablePackageWrite } from "./collaboration/packageWriteAdapter";
import { createTranslator, type Language } from "./i18n";
import { TaskInspector } from "./inspector/TaskInspector";
import { useCollaborationStatus } from "./hooks/useCollaborationStatus";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useSharedCanvasCommands } from "./hooks/useSharedCanvasCommands";
import { useTaskAgentEndpointSelection } from "./hooks/useTaskAgentEndpointSelection";
import { useOwnerControlPlaneAvailability } from "./hooks/useOwnerControlPlaneAvailability";
import { useWorkspaceAgentEndpointCatalog } from "./hooks/useWorkspaceAgentEndpointCatalog";
import { isCollaborationSessionConnected } from "./collaboration/sessionState";

function supportedLanguage(value: string | null): Language {
  return value === "en" || value === "zh-CN" ? value : "zh-CN";
}

function taskBlockRefs(
  taskId: string,
  graph: DesktopGraphViewModel | null,
  task: DesktopTaskDetail | null
): Set<string> {
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

function eventMatchesTask(
  event: DesktopAutoRunEvent,
  taskId: string,
  graph: DesktopGraphViewModel | null,
  task: DesktopTaskDetail | null
): boolean {
  const refs = taskBlockRefs(taskId, graph, task);
  if (refs.size === 0) {
    return true;
  }
  if (event.currentRef && refs.has(event.currentRef)) {
    return true;
  }
  return Boolean(
    event.latestRecordId && [...refs].some((ref) => event.latestRecordId?.startsWith(`${ref}::`))
  );
}

export function TaskInspectorWindow() {
  const search = window.location.search;
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const projectRoot = params.get("projectRoot") ?? "";
  const taskId = params.get("taskId") ?? "";
  const canvasId = params.get("canvasId");
  const language = supportedLanguage(params.get("language"));
  const t = useMemo(() => createTranslator(language), [language]);
  const [selectedTask, setSelectedTask] = useState<DesktopTaskDetail | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [draftDirty, setDraftDirty] = useState(false);
  const { settings, updateSettingsAndWait } = useDesktopSettingsBridge({ setError });
  const { agentDetections } = useDetectedAgents();
  const draftDirtyRef = useRef(false);

  const updateDraftDirty = useCallback((nextDraftDirty: boolean) => {
    draftDirtyRef.current = nextDraftDirty;
    setDraftDirty(nextDraftDirty);
  }, []);

  const loadTask = useCallback(
    async (options: { skipCommitWhenDirty?: boolean } = {}) => {
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
    },
    [canvasId, projectRoot, taskId]
  );

  const { status: collaborationStatus } = useCollaborationStatus({ api: collaborationBridge });
  const activeCollaborationProfile = useMemo(() => {
    if (!collaborationStatus?.activeProfileId) return null;
    return (
      collaborationStatus.profiles.find(
        (profile) => profile.profileId === collaborationStatus.activeProfileId
      ) ?? null
    );
  }, [collaborationStatus]);
  const sessionConnected = isCollaborationSessionConnected(collaborationStatus);
  const sharedProjectId = activeCollaborationProfile?.projectId ?? null;
  const graphProjectId = graph?.projectId ?? null;
  const sharedCanvasEnabled =
    sessionConnected &&
    sharedProjectId !== null &&
    graphProjectId !== null &&
    sharedProjectId === graphProjectId;
  const sharedCanvas = useSharedCanvasCommands({
    api: collaborationBridge,
    binding:
      sharedProjectId && canvasId
        ? { kind: "local", localProjectId: sharedProjectId, canvasId }
        : null,
    enabled: sharedCanvasEnabled,
    sessionConnected,
    profileId: activeCollaborationProfile?.profileId ?? null,
    activeProjectId: sharedProjectId,
    localOwnerDirectWriteAvailable: false,
    t,
    onAuthoritativeChange: async () => {
      await loadTask();
    }
  });
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const agentEndpointCatalog = useWorkspaceAgentEndpointCatalog({
    agentDetections,
    agentTransport: settings.execution.agentTransport,
    enabled: ownerControlPlane.fleetCatalogEnabled,
    fleetCatalogBlockedCode: ownerControlPlane.fleetCatalogBlockedCode,
    graph,
    operatorProfileId: ownerControlPlane.operatorProfileId,
    updateSettingsAndWait
  });

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  useEffect(() => {
    if (!bridge || draftDirty || !projectRoot || !taskId) {
      return undefined;
    }
    return bridge.onAutoRunChanged((event) => {
      if (
        !autoRunEventMatchesCanvas(event, projectRoot, canvasId) ||
        !eventMatchesTask(event, taskId, graph, selectedTask)
      ) {
        return;
      }
      void loadTask({ skipCommitWhenDirty: true });
    });
  }, [canvasId, draftDirty, graph, loadTask, projectRoot, selectedTask, taskId]);

  const saveSelectedTaskTitle = useCallback(async () => {
    if (!projectRoot || !selectedTask) {
      return;
    }
    try {
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_task_fields",
          taskId: selectedTask.taskId,
          fields: { title: selectedTask.title }
        },
        onError: setError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateTaskTitle(
            { projectRoot, canvasId },
            selectedTask.taskId,
            selectedTask.title
          );
          if (!result.ok) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }
        }
      });
      if (mode === "failed") return;
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [canvasId, loadTask, projectRoot, selectedTask, sharedCanvas]);

  const changeLogicalExecutor = useCallback(
    async (targetTaskId: string, executorName: string) => {
      if (!projectRoot) {
        return false;
      }
      try {
        const mode = await runDurablePackageWrite({
          sharedCanvas,
          intent: {
            kind: "update_task_fields",
            taskId: targetTaskId,
            fields: { executor: executorName }
          },
          onError: setError,
          localWrite: async () => {
            if (!bridge) return;
            const result = await bridge.updateTaskExecutor(
              { projectRoot, canvasId },
              targetTaskId,
              executorName
            );
            if (!result.ok) {
              throw new Error(
                result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              );
            }
          }
        });
        if (mode === "failed") return false;
        await loadTask();
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    },
    [canvasId, loadTask, projectRoot, sharedCanvas]
  );

  const taskAgentEndpointSelection = useTaskAgentEndpointSelection({
    agentEndpoints: agentEndpointCatalog.endpoints,
    canvasId: canvasId ?? "default",
    changeLogicalExecutor,
    preferences: settings.execution.agentEndpointPreferences,
    projectRoot: projectRoot || null,
    savePreference: agentEndpointCatalog.savePreference,
    setError
  });

  const saveSelectedTaskPrompt = useCallback(async () => {
    if (!projectRoot || !selectedTask) {
      return;
    }
    try {
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_task_prompt",
          taskId: selectedTask.taskId,
          promptMarkdown: selectedTask.promptMarkdown
        },
        onError: setError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateTaskPrompt(
            { projectRoot, canvasId },
            selectedTask.taskId,
            selectedTask.promptMarkdown,
            {
              baseGraphVersion: selectedTask.graphVersion,
              basePromptHash: selectedTask.promptHash
            }
          );
          if (!result.ok) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }
        }
      });
      if (mode === "failed") return;
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [canvasId, loadTask, projectRoot, selectedTask, sharedCanvas]);

  const selectedEndpointId = selectedTask
    ? taskAgentEndpointSelection.selectedEndpointId(
        selectedTask.taskId,
        selectedTask.executor ?? "manual"
      )
    : null;

  return (
    <TaskInspector
      agentEndpointCatalogErrorCode={agentEndpointCatalog.errorCode}
      agentEndpoints={agentEndpointCatalog.endpoints}
      canvasRef={{ projectRoot, canvasId }}
      className="inset-0 h-screen w-screen min-w-0 rounded-none border-0 shadow-none ring-0"
      error={error}
      graph={graph}
      onAgentEndpointChange={(endpointId) => {
        if (!selectedTask) return;
        void taskAgentEndpointSelection.changeEndpoint(selectedTask.taskId, endpointId);
      }}
      onClose={() => window.close()}
      onDraftDirtyChange={updateDraftDirty}
      onRefreshAgentEndpoints={agentEndpointCatalog.refresh}
      refreshingAgentEndpoints={agentEndpointCatalog.refreshing}
      saveSelectedTaskPrompt={saveSelectedTaskPrompt}
      saveSelectedTaskTitle={saveSelectedTaskTitle}
      selectedAgentEndpointId={selectedEndpointId}
      selectedTask={selectedTask}
      setSelectedTask={setSelectedTask}
      t={t}
    />
  );
}
