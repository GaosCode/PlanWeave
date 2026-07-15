import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  projectTaskWorkspaceClockSnapshot,
  projectTaskWorkspaceLiveSnapshot
} from "@planweave-ai/runtime/browser";
import type { DesktopBridgeApi, DesktopRunRecord, TaskWorkspace } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { AppViewHistoryController } from "../hooks/useAppViewHistory";
import { useRunnerRecordMonitor } from "../hooks/useRunnerRecordMonitor";
import {
  taskWorkspaceNavigationTargetSchema,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";
import type {
  TaskWorkspaceController,
  TaskWorkspaceLiveStatus,
  TaskWorkspaceSelectedRun
} from "./contracts";

type TaskWorkspaceApi = Pick<
  DesktopBridgeApi,
  | "getRunRecord"
  | "getBlockDetail"
  | "getTaskDetail"
  | "getTaskWorkspace"
  | "onAutoRunChanged"
  | "onRuntimeStateChanged"
  | "subscribeRunnerRecord"
  | "updateBlockPrompt"
  | "updateTaskPrompt"
>;

type WorkspaceLoad = {
  error: string | null;
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  workspace: TaskWorkspace | null;
};

type RecordLoad = {
  error: string | null;
  key: string;
  record: DesktopRunRecord | null;
  status: "idle" | "loading" | "ready" | "error";
};

const idleWorkspaceLoad: WorkspaceLoad = {
  error: null,
  key: "",
  status: "idle",
  workspace: null
};
const idleRecordLoad: RecordLoad = { error: null, key: "", record: null, status: "idle" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphEditError(result: Awaited<ReturnType<DesktopBridgeApi["updateTaskPrompt"]>>): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The prompt could not be saved."
  );
}

function navigationKey(navigation: TaskWorkspaceNavigationIdentity): string {
  return JSON.stringify([
    navigation.projectRoot,
    navigation.canvasId,
    navigation.taskId,
    navigation.blockRef ?? null,
    navigation.recordId ?? null
  ]);
}

function findRun(
  workspace: TaskWorkspace,
  blockRef: string,
  recordId: string
): TaskWorkspaceSelectedRun | null {
  const block = workspace.blocks.find((candidate) => candidate.ref === blockRef);
  const item = block?.runs.find((candidate) => candidate.run.record.recordId === recordId);
  return block && item ? { block, item } : null;
}

function initialRunForNavigation(
  workspace: TaskWorkspace,
  navigation: TaskWorkspaceNavigationIdentity
): TaskWorkspaceSelectedRun | null {
  if (navigation.recordId && navigation.blockRef) {
    return findRun(workspace, navigation.blockRef, navigation.recordId);
  }
  if (navigation.blockRef) {
    const block = workspace.blocks.find((candidate) => candidate.ref === navigation.blockRef);
    const item = block?.runs.find((candidate) => candidate.active) ?? block?.runs.at(-1);
    return block && item ? { block, item } : null;
  }
  if (!workspace.selectedRecordId) {
    return null;
  }
  for (const block of workspace.blocks) {
    const item = block.runs.find(
      (candidate) => candidate.run.record.recordId === workspace.selectedRecordId
    );
    if (item) {
      return { block, item };
    }
  }
  return null;
}

export function useTaskWorkspaceController(options: {
  api?: TaskWorkspaceApi | null;
  history: AppViewHistoryController;
}): TaskWorkspaceController {
  const { api = bridge, history } = options;
  const navigation = history.taskWorkspaceNavigation;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [workspaceLoad, setWorkspaceLoad] = useState<WorkspaceLoad>(idleWorkspaceLoad);
  const [recordLoad, setRecordLoad] = useState<RecordLoad>(idleRecordLoad);
  const [overviewSelected, setOverviewSelected] = useState(false);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const workspaceRequest = useRef(0);
  const recordRequest = useRef(0);
  const overviewSelectedRef = useRef(false);
  const runScrollPositions = useRef(new Map<string, number>());
  const key = navigation ? navigationKey(navigation) : "";
  const taskAuthorityKey = navigation
    ? JSON.stringify([navigation.projectRoot, navigation.canvasId, navigation.taskId])
    : "";

  useEffect(() => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
  }, [taskAuthorityKey]);

  useEffect(() => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
  }, [navigation?.blockRef, navigation?.recordId]);

  useEffect(() => {
    const request = ++workspaceRequest.current;
    if (!navigation) {
      setWorkspaceLoad(idleWorkspaceLoad);
      return;
    }
    if (!api) {
      setWorkspaceLoad({
        error: "Task Workspace bridge is unavailable.",
        key,
        status: "error",
        workspace: null
      });
      return;
    }
    setWorkspaceLoad({ error: null, key, status: "loading", workspace: null });
    void api
      .getTaskWorkspace({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        taskId: navigation.taskId,
        selectedRecordId: navigation.recordId ?? null
      })
      .then((workspace) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        const selected = initialRunForNavigation(workspace, navigation);
        if (
          navigation.blockRef &&
          !workspace.blocks.some((block) => block.ref === navigation.blockRef)
        ) {
          setWorkspaceLoad({
            error: `Block '${navigation.blockRef}' is unavailable for task '${navigation.taskId}'.`,
            key,
            status: "error",
            workspace: null
          });
          return;
        }
        if (navigation.recordId && !selected) {
          setWorkspaceLoad({
            error: `Run record '${navigation.recordId}' does not belong to block '${navigation.blockRef}'.`,
            key,
            status: "error",
            workspace: null
          });
          return;
        }
        if (!navigation.recordId && selected && !overviewSelectedRef.current) {
          history.replaceTaskWorkspaceTarget(
            taskWorkspaceNavigationTargetSchema.parse({
              projectRoot: navigation.projectRoot,
              canvasId: navigation.canvasId,
              taskId: navigation.taskId,
              blockRef: selected.block.ref,
              recordId: selected.item.run.record.recordId
            })
          );
          return;
        }
        setWorkspaceLoad({ error: null, key, status: "ready", workspace });
      })
      .catch((error: unknown) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        setWorkspaceLoad({ error: errorMessage(error), key, status: "error", workspace: null });
      });
  }, [api, history.replaceTaskWorkspaceTarget, key, navigation, refreshVersion]);

  const workspace = workspaceLoad.key === key ? workspaceLoad.workspace : null;
  const routedSelectedRun = useMemo(() => {
    if (!workspace || !navigation?.blockRef || !navigation.recordId) {
      return null;
    }
    return findRun(workspace, navigation.blockRef, navigation.recordId);
  }, [navigation?.blockRef, navigation?.recordId, workspace]);
  const selectedRun = overviewSelected ? null : routedSelectedRun;
  const selectedRecordKey = selectedRun?.item.run.record.recordId ?? "";
  const selectedBlockRef = selectedRun?.block.ref ?? "";

  useEffect(() => {
    const request = ++recordRequest.current;
    if (!api || !navigation || !selectedRun) {
      setRecordLoad(idleRecordLoad);
      return;
    }
    setRecordLoad({ error: null, key: selectedRecordKey, record: null, status: "loading" });
    void api
      .getRunRecord(
        { projectRoot: navigation.projectRoot, canvasId: navigation.canvasId },
        selectedRecordKey
      )
      .then((record) => {
        if (recordRequest.current !== request) {
          return;
        }
        if (
          record.recordId !== selectedRecordKey ||
          record.ref !== selectedBlockRef ||
          record.taskId !== navigation.taskId
        ) {
          setRecordLoad({
            error: "Selected run record does not match its Task Workspace navigation identity.",
            key: selectedRecordKey,
            record: null,
            status: "error"
          });
          return;
        }
        setRecordLoad({
          error: null,
          key: selectedRecordKey,
          record,
          status: "ready"
        });
      })
      .catch((error: unknown) => {
        if (recordRequest.current !== request) {
          return;
        }
        setRecordLoad({
          error: errorMessage(error),
          key: selectedRecordKey,
          record: null,
          status: "error"
        });
      });
  }, [
    api,
    navigation?.canvasId,
    navigation?.projectRoot,
    navigation?.taskId,
    selectedBlockRef,
    selectedRecordKey
  ]);

  const selectedRecord = recordLoad.key === selectedRecordKey ? recordLoad.record : null;
  const initialModel = selectedRecord?.runnerReadModel ?? null;
  const canvasRef = useMemo(
    () =>
      navigation ? { projectRoot: navigation.projectRoot, canvasId: navigation.canvasId } : null,
    [navigation?.canvasId, navigation?.projectRoot]
  );
  const monitor = useRunnerRecordMonitor({
    api,
    canvasRef,
    initialModel,
    recordId: selectedRecord?.recordId ?? null
  });

  useEffect(() => {
    setClockNowMs(Date.now());
    if (!workspace || workspace.activeRecordIds.length === 0) {
      return;
    }
    const timer = window.setInterval(() => setClockNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [workspace?.activeRecordIds.join("\0")]);

  const liveProjection = useMemo(() => {
    if (!workspace) {
      return {
        error: null as string | null,
        runnerModel: null,
        selectedRun: null,
        workspace: null
      };
    }
    try {
      const now = new Date(clockNowMs);
      const projectedWorkspace =
        selectedRun && monitor.model
          ? projectTaskWorkspaceLiveSnapshot({
              workspace,
              recordId: selectedRun.item.run.record.recordId,
              model: monitor.model,
              now
            })
          : projectTaskWorkspaceClockSnapshot(workspace, now);
      const projectedSelectedRun = selectedRun
        ? findRun(projectedWorkspace, selectedRun.block.ref, selectedRun.item.run.record.recordId)
        : null;
      if (selectedRun && !projectedSelectedRun) {
        throw new Error(
          `Projected Task Workspace record '${selectedRun.item.run.record.recordId}' is unavailable.`
        );
      }
      return {
        error: null,
        runnerModel: monitor.model,
        selectedRun: projectedSelectedRun,
        workspace: projectedWorkspace
      };
    } catch (error: unknown) {
      return {
        error: errorMessage(error),
        runnerModel: null,
        selectedRun,
        workspace
      };
    }
  }, [clockNowMs, monitor.model, selectedRun, workspace]);

  useEffect(() => {
    if (!api || !navigation) {
      return;
    }
    const matchesCanvas = (event: { projectRoot: string; canvasId: string | null }) =>
      event.projectRoot === navigation.projectRoot && event.canvasId === navigation.canvasId;
    const refresh = () => setRefreshVersion((current) => current + 1);
    const removeRuntimeListener = api.onRuntimeStateChanged((event) => {
      if (matchesCanvas(event)) refresh();
    });
    const removeAutoRunListener = api.onAutoRunChanged((event) => {
      if (matchesCanvas(event)) refresh();
    });
    return () => {
      removeRuntimeListener();
      removeAutoRunListener();
    };
  }, [api, navigation]);

  const selectRun = useCallback<TaskWorkspaceController["selectRun"]>(
    (selection) => {
      if (!navigation) {
        throw new Error("Cannot select a run without a Task Workspace navigation identity.");
      }
      if (selection === null) {
        overviewSelectedRef.current = true;
        setOverviewSelected(true);
        return;
      }
      overviewSelectedRef.current = false;
      setOverviewSelected(false);
      history.replaceTaskWorkspaceTarget(
        taskWorkspaceNavigationTargetSchema.parse({
          projectRoot: navigation.projectRoot,
          canvasId: navigation.canvasId,
          taskId: navigation.taskId,
          blockRef: selection.blockRef,
          recordId: selection.recordId
        })
      );
    },
    [history.replaceTaskWorkspaceTarget, navigation]
  );

  const saveTaskPrompt = useCallback<TaskWorkspaceController["saveTaskPrompt"]>(
    async ({ baseMarkdown, markdown }) => {
      if (!api || !navigation) {
        throw new Error("Cannot save a Task prompt without a Task Workspace bridge and identity.");
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const current = await api.getTaskDetail(canvasRef, navigation.taskId);
      if (current.taskId !== navigation.taskId) {
        throw new Error("The loaded Task prompt does not match this Task Workspace.");
      }
      if (current.promptMarkdown !== baseMarkdown) {
        throw new Error(
          "The Task prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current.graphVersion === undefined || current.promptHash === undefined) {
        throw new Error(
          "The Task prompt cannot be saved safely because its revision is unavailable."
        );
      }
      const result = await api.updateTaskPrompt(canvasRef, navigation.taskId, markdown, {
        baseGraphVersion: current.graphVersion,
        basePromptHash: current.promptHash
      });
      if (!result.ok) {
        throw new Error(graphEditError(result));
      }
      setRefreshVersion((value) => value + 1);
    },
    [api, navigation]
  );

  const saveBlockPrompt = useCallback<TaskWorkspaceController["saveBlockPrompt"]>(
    async (blockRef, { baseMarkdown, markdown }) => {
      if (!api || !navigation) {
        throw new Error("Cannot save a Block prompt without a Task Workspace bridge and identity.");
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const current = await api.getBlockDetail(canvasRef, blockRef);
      if (current.ref !== blockRef || current.taskId !== navigation.taskId) {
        throw new Error("The loaded Block prompt does not belong to this Task Workspace.");
      }
      if (current.promptMarkdown !== baseMarkdown) {
        throw new Error(
          "The Block prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current.graphVersion === undefined || current.promptHash === undefined) {
        throw new Error(
          "The Block prompt cannot be saved safely because its revision is unavailable."
        );
      }
      const result = await api.updateBlockPrompt(canvasRef, blockRef, markdown, {
        baseGraphVersion: current.graphVersion,
        basePromptHash: current.promptHash
      });
      if (!result.ok) {
        throw new Error(graphEditError(result));
      }
      setRefreshVersion((value) => value + 1);
    },
    [api, navigation]
  );

  const liveStatus = useMemo<TaskWorkspaceLiveStatus>(() => {
    if (!liveProjection.selectedRun) return "idle";
    if (recordLoad.status === "loading") return "loading";
    if (recordLoad.status === "error" || monitor.subscriptionError || liveProjection.error) {
      return "error";
    }
    if (selectedRecord && !selectedRecord.runnerReadModel) return "unavailable";
    return liveProjection.runnerModel ? "live" : "loading";
  }, [liveProjection, monitor.subscriptionError, recordLoad.status, selectedRecord]);
  const liveUnavailableReason =
    liveStatus === "unavailable"
      ? (liveProjection.selectedRun?.item.run.capabilities.prompt.reason ??
        "This run has no live RunnerRecordReadModel.")
      : null;
  const status = workspaceLoad.key === key ? workspaceLoad.status : navigation ? "loading" : "idle";
  const recordError = recordLoad.key === selectedRecordKey ? recordLoad.error : null;
  const error =
    history.historyError ??
    (workspaceLoad.key === key ? workspaceLoad.error : null) ??
    recordError ??
    liveProjection.error;

  return useMemo<TaskWorkspaceController>(
    () => ({
      error,
      getRunScrollTop: (recordId) => runScrollPositions.current.get(recordId) ?? 0,
      liveStatus,
      liveUnavailableReason,
      navigation,
      onRunScrollTopChange: (recordId, scrollTop) => {
        runScrollPositions.current.set(recordId, Math.max(0, scrollTop));
      },
      recordError,
      refresh: () => setRefreshVersion((current) => current + 1),
      returnToCanvas: history.returnToTaskWorkspaceSource,
      runnerModel: liveProjection.runnerModel,
      saveBlockPrompt,
      saveTaskPrompt,
      selectRun,
      selectedRecord,
      selectedRun: liveProjection.selectedRun,
      status,
      subscriptionError: monitor.subscriptionError,
      workspace: liveProjection.workspace
    }),
    [
      error,
      history.returnToTaskWorkspaceSource,
      liveStatus,
      liveUnavailableReason,
      monitor.subscriptionError,
      liveProjection,
      navigation,
      recordError,
      saveBlockPrompt,
      saveTaskPrompt,
      selectRun,
      selectedRecord,
      status
    ]
  );
}
