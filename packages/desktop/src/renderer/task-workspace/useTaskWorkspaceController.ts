import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  composeTaskWorkspaceRuns,
  projectTaskWorkspaceLiveSnapshot
} from "@planweave-ai/runtime/browser";
import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  TaskWorkspace,
  TaskWorkspaceRunListItem,
  TaskWorkspaceRunsCursor
} from "@planweave-ai/runtime";
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
import { useTaskWorkspaceExecutorActions } from "./useTaskWorkspaceExecutorActions";

type TaskWorkspaceApi = Pick<
  DesktopBridgeApi,
  | "getBlockDetail"
  | "getGraphViewModel"
  | "getTaskDetail"
  | "getTaskWorkspace"
  | "getTaskWorkspaceRunDetail"
  | "listTaskWorkspaceRuns"
  | "onAutoRunChanged"
  | "onRuntimeStateChanged"
  | "subscribeRunnerRecord"
  | "updateBlockExecutor"
  | "updateBlockPrompt"
  | "updateTaskExecutor"
  | "updateTaskPrompt"
>;

type WorkspaceLoad = {
  error: string | null;
  executorOptions: string[];
  key: string;
  packageExecutorNames: string[];
  status: "idle" | "loading" | "ready" | "error";
  workspace: TaskWorkspace | null;
};

type RecordLoad = {
  blockRef: string | null;
  error: string | null;
  item: TaskWorkspaceSelectedRun["item"] | null;
  key: string;
  record: DesktopRunRecord | null;
  status: "idle" | "loading" | "ready" | "error";
};

const idleWorkspaceLoad: WorkspaceLoad = {
  error: null,
  executorOptions: [],
  key: "",
  packageExecutorNames: [],
  status: "idle",
  workspace: null
};
const idleRecordLoad: RecordLoad = {
  blockRef: null,
  error: null,
  item: null,
  key: "",
  record: null,
  status: "idle"
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphEditError(result: Awaited<ReturnType<DesktopBridgeApi["updateTaskPrompt"]>>): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The graph edit could not be saved."
  );
}

function taskWorkspaceAuthorityKey(navigation: TaskWorkspaceNavigationIdentity): string {
  return JSON.stringify([
    navigation.projectRoot,
    navigation.canvasId,
    navigation.taskId
  ]);
}

function taskWorkspaceRecordKey(authorityKey: string, recordId: string): string {
  return `${authorityKey}\u0000${recordId}`;
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
  const refresh = useCallback(() => setRefreshVersion((current) => current + 1), []);
  const [workspaceLoad, setWorkspaceLoad] = useState<WorkspaceLoad>(idleWorkspaceLoad);
  const [recordLoad, setRecordLoad] = useState<RecordLoad>(idleRecordLoad);
  const [overviewSelected, setOverviewSelected] = useState(false);
  const [selectedAnnotationIdentity, setSelectedAnnotationIdentity] = useState<{
    annotationId: string;
    blockRef: string;
  } | null>(null);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [loadMoreRunsError, setLoadMoreRunsError] = useState<string | null>(null);
  const workspaceRequest = useRef(0);
  const recordRequest = useRef(0);
  const recordLoads = useRef(new Map<string, RecordLoad>());
  const overviewSelectedRef = useRef(false);
  const runScrollPositions = useRef(new Map<string, number>());
  const runItemsRef = useRef<TaskWorkspaceRunListItem[]>([]);
  const nextCursorRef = useRef<TaskWorkspaceRunsCursor | null>(null);
  const loadingMoreRef = useRef(false);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const key = navigation ? taskWorkspaceAuthorityKey(navigation) : "";

  useEffect(() => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(null);
  }, [key]);

  useEffect(() => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(null);
  }, [navigation?.blockRef, navigation?.recordId]);

  useEffect(() => {
    const request = ++workspaceRequest.current;
    const requestedNavigation = navigationRef.current;
    if (!requestedNavigation) {
      return;
    }
    if (!api) {
      setWorkspaceLoad({
        error: "Task Workspace bridge is unavailable.",
        executorOptions: [],
        key,
        packageExecutorNames: [],
        status: "error",
        workspace: null
      });
      return;
    }
    setWorkspaceLoad((current) => {
      if (current.key === key && current.workspace) {
        return { ...current, error: null };
      }
      return {
        error: null,
        executorOptions: [],
        key,
        packageExecutorNames: [],
        status: "loading",
        workspace: null
      };
    });
    const canvasRef = {
      projectRoot: requestedNavigation.projectRoot,
      canvasId: requestedNavigation.canvasId
    };
    void Promise.all([
      api.getTaskWorkspace({
        ...canvasRef,
        taskId: requestedNavigation.taskId,
        selectedRecordId: requestedNavigation.recordId ?? null
      }),
      api.listTaskWorkspaceRuns({
        ...canvasRef,
        taskId: requestedNavigation.taskId
      }),
      api.getGraphViewModel(canvasRef)
    ])
      .then(([header, runsPage, graph]) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        const currentNavigation = navigationRef.current;
        if (
          !currentNavigation ||
          taskWorkspaceAuthorityKey(currentNavigation) !== key
        ) {
          return;
        }
        if (!graph.tasks.some((task) => task.taskId === currentNavigation.taskId)) {
          setWorkspaceLoad({
            error: `Task '${currentNavigation.taskId}' is unavailable in the current graph view.`,
            executorOptions: [],
            key,
            packageExecutorNames: [],
            status: "error",
            workspace: null
          });
          return;
        }
        if (
          currentNavigation.blockRef &&
          !header.blocks.some((block) => block.ref === currentNavigation.blockRef)
        ) {
          setWorkspaceLoad({
            error: `Block '${currentNavigation.blockRef}' is unavailable for task '${currentNavigation.taskId}'.`,
            executorOptions: [],
            key,
            packageExecutorNames: [],
            status: "error",
            workspace: null
          });
          return;
        }
        const selectedHint = currentNavigation.recordId ?? header.selectedRecordId;
        const pageItems: TaskWorkspaceRunListItem[] = runsPage.items.map((item) => ({
          ...item,
          selected: selectedHint !== null && item.run.record.recordId === selectedHint
        }));
        const workspace = composeTaskWorkspaceRuns(header, pageItems);
        runItemsRef.current = pageItems;
        nextCursorRef.current = runsPage.nextCursor;
        setHasMoreRuns(runsPage.nextCursor !== null);
        setLoadMoreRunsError(null);
        setLoadingMoreRuns(false);
        loadingMoreRef.current = false;
        const selected = initialRunForNavigation(workspace, currentNavigation);
        // Missing selection on the first page is OK when navigating to an older record;
        // getTaskWorkspaceRunDetail validates ownership when the record is selected.
        if (!currentNavigation.recordId && selected && !overviewSelectedRef.current) {
          history.replaceTaskWorkspaceTarget(
            taskWorkspaceNavigationTargetSchema.parse({
              projectRoot: currentNavigation.projectRoot,
              canvasId: currentNavigation.canvasId,
              taskId: currentNavigation.taskId,
              blockRef: selected.block.ref,
              recordId: selected.item.run.record.recordId
            })
          );
        }
        setWorkspaceLoad({
          error: null,
          executorOptions: graph.executorOptions,
          key,
          packageExecutorNames: graph.packageExecutorNames ?? [],
          status: "ready",
          workspace
        });
      })
      .catch((error: unknown) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        setWorkspaceLoad({
          error: errorMessage(error),
          executorOptions: [],
          key,
          packageExecutorNames: [],
          status: "error",
          workspace: null
        });
      });
  }, [api, history.replaceTaskWorkspaceTarget, key, refreshVersion]);

  const workspace = workspaceLoad.key === key ? workspaceLoad.workspace : null;
  const executorOptions = workspaceLoad.key === key ? workspaceLoad.executorOptions : [];
  const packageExecutorNames = workspaceLoad.key === key ? workspaceLoad.packageExecutorNames : [];
  const routedSelectedRun = useMemo(() => {
    if (!workspace || !navigation?.blockRef || !navigation.recordId) {
      return null;
    }
    return findRun(workspace, navigation.blockRef, navigation.recordId);
  }, [navigation?.blockRef, navigation?.recordId, workspace]);
  const visibleRecordLoad = navigation?.recordId
    ? recordLoad.key === navigation.recordId
      ? recordLoad
      : (recordLoads.current.get(taskWorkspaceRecordKey(key, navigation.recordId)) ??
        idleRecordLoad)
    : idleRecordLoad;
  const detailSelectedRun = useMemo(() => {
    if (
      !workspace ||
      visibleRecordLoad.key !== navigation?.recordId ||
      !visibleRecordLoad.blockRef ||
      !visibleRecordLoad.item
    ) {
      return null;
    }
    const block = workspace.blocks.find((candidate) => candidate.ref === visibleRecordLoad.blockRef);
    return block ? { block, item: visibleRecordLoad.item } : null;
  }, [navigation?.recordId, visibleRecordLoad, workspace]);
  const selectedAnnotation = useMemo(() => {
    if (!workspace || !selectedAnnotationIdentity) return null;
    const block = workspace.blocks.find(
      (candidate) => candidate.ref === selectedAnnotationIdentity.blockRef
    );
    const annotation = block?.annotations.find(
      (candidate) => candidate.annotationId === selectedAnnotationIdentity.annotationId
    );
    return block && annotation ? { annotation, block } : null;
  }, [selectedAnnotationIdentity, workspace]);
  const selectedRun =
    overviewSelected || selectedAnnotation ? null : (routedSelectedRun ?? detailSelectedRun);
  const selectedRecordKey = selectedAnnotation
    ? ""
    : (navigation?.recordId ?? selectedRun?.item.run.record.recordId ?? "");
  const selectedBlockRef =
    selectedAnnotation?.block.ref ?? navigation?.blockRef ?? selectedRun?.block.ref ?? "";

  useEffect(() => {
    const request = ++recordRequest.current;
    if (!api || !navigation || !selectedRecordKey || overviewSelected) {
      setRecordLoad(idleRecordLoad);
      return;
    }
    const cacheKey = taskWorkspaceRecordKey(key, selectedRecordKey);
    const cachedLoad = recordLoads.current.get(cacheKey) ?? null;
    setRecordLoad(
      cachedLoad ?? {
        blockRef: null,
        error: null,
        item: null,
        key: selectedRecordKey,
        record: null,
        status: "loading"
      }
    );
    void api
      .getTaskWorkspaceRunDetail({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        taskId: navigation.taskId,
        recordId: selectedRecordKey
      })
      .then((detail) => {
        if (recordRequest.current !== request) {
          return;
        }
        const record: DesktopRunRecord = detail.record;
        if (
          record.recordId !== selectedRecordKey ||
          record.ref !== (selectedBlockRef || record.ref) ||
          record.taskId !== navigation.taskId ||
          detail.taskId !== navigation.taskId
        ) {
          recordLoads.current.delete(cacheKey);
          setRecordLoad({
            blockRef: null,
            error: "Selected run record does not match its Task Workspace navigation identity.",
            item: null,
            key: selectedRecordKey,
            record: null,
            status: "error"
          });
          return;
        }
        if (detail.item.run.kind === "block") {
          // Block details refine the paged summary. Feedback details remain a selected
          // annotation and must not be inserted into the Block run pagination model.
          const listItem: TaskWorkspaceRunListItem = {
            blockRef: detail.blockRef,
            ...detail.item
          };
          const without = runItemsRef.current.filter(
            (item) => item.run.record.recordId !== listItem.run.record.recordId
          );
          runItemsRef.current = [...without, listItem];
          setWorkspaceLoad((current) => {
            if (!current.workspace || current.key !== key) {
              return current;
            }
            return {
              ...current,
              workspace: composeTaskWorkspaceRuns(current.workspace, runItemsRef.current)
            };
          });
        }
        const loadedRecord: RecordLoad = {
          blockRef: detail.blockRef,
          error: null,
          item: detail.item,
          key: selectedRecordKey,
          record,
          status: "ready"
        };
        recordLoads.current.set(cacheKey, loadedRecord);
        setRecordLoad(loadedRecord);
      })
      .catch((error: unknown) => {
        if (recordRequest.current !== request) {
          return;
        }
        setRecordLoad({
          blockRef: cachedLoad?.blockRef ?? null,
          error: errorMessage(error),
          item: cachedLoad?.item ?? null,
          key: selectedRecordKey,
          record: cachedLoad?.record ?? null,
          status: "error"
        });
      });
  }, [
    api,
    key,
    navigation?.canvasId,
    navigation?.projectRoot,
    navigation?.taskId,
    overviewSelected,
    selectedBlockRef,
    selectedRecordKey
  ]);

  const selectedRecord =
    visibleRecordLoad.key === selectedRecordKey ? visibleRecordLoad.record : null;
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

  // Clock ticks must not rebuild the Task Workspace aggregate. Live duration/relative
  // labels subscribe via useTaskWorkspaceClock in leaf components only.
  // Live runner model merges still re-project when monitor.model changes (data, not clock).
  const liveProjection = useMemo(() => {
    if (!workspace) {
      return {
        error: null as string | null,
        runnerModel: null,
        selectedRun: null,
        workspace: null
      };
    }
    if (!selectedRun || !monitor.model) {
      return {
        error: null as string | null,
        runnerModel: null,
        selectedRun,
        workspace
      };
    }
    if (selectedRun.item.run.kind === "feedback") {
      return {
        error: null,
        runnerModel: monitor.model,
        selectedRun,
        workspace
      };
    }
    try {
      const projectedWorkspace = projectTaskWorkspaceLiveSnapshot({
        workspace,
        recordId: selectedRun.item.run.record.recordId,
        model: monitor.model,
        now: new Date()
      });
      const projectedSelectedRun = findRun(
        projectedWorkspace,
        selectedRun.block.ref,
        selectedRun.item.run.record.recordId
      );
      if (!projectedSelectedRun) {
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
  }, [monitor.model, selectedRun, workspace]);

  useEffect(() => {
    if (!api || !canvasRef) {
      return;
    }
    const matchesCanvas = (event: { projectRoot: string; canvasId: string | null }) =>
      event.projectRoot === canvasRef.projectRoot && event.canvasId === canvasRef.canvasId;
    const refreshFromEvent = () => setRefreshVersion((current) => current + 1);
    const removeRuntimeListener = api.onRuntimeStateChanged((event) => {
      if (matchesCanvas(event)) refreshFromEvent();
    });
    const removeAutoRunListener = api.onAutoRunChanged((event) => {
      if (matchesCanvas(event)) refreshFromEvent();
    });
    return () => {
      removeRuntimeListener();
      removeAutoRunListener();
    };
  }, [api, canvasRef]);

  const selectRun = useCallback<TaskWorkspaceController["selectRun"]>(
    (selection) => {
      if (!navigation) {
        throw new Error("Cannot select a run without a Task Workspace navigation identity.");
      }
      if (selection === null) {
        setSelectedAnnotationIdentity(null);
        overviewSelectedRef.current = true;
        setOverviewSelected(true);
        return;
      }
      overviewSelectedRef.current = false;
      setOverviewSelected(false);
      setSelectedAnnotationIdentity(null);
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

  const selectAnnotation = useCallback<TaskWorkspaceController["selectAnnotation"]>((selection) => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(selection);
  }, []);

  const loadMoreRuns = useCallback(async () => {
    if (!api || !navigation || !nextCursorRef.current || loadingMoreRef.current) {
      return;
    }
    const cursor = nextCursorRef.current;
    const request = workspaceRequest.current;
    loadingMoreRef.current = true;
    setLoadingMoreRuns(true);
    setLoadMoreRunsError(null);
    try {
      const page = await api.listTaskWorkspaceRuns({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        taskId: navigation.taskId,
        cursor
      });
      if (workspaceRequest.current !== request) {
        return;
      }
      const selectedHint = navigation.recordId ?? null;
      const existingIds = new Set(runItemsRef.current.map((item) => item.run.record.recordId));
      const appended: TaskWorkspaceRunListItem[] = page.items
        .filter((item) => !existingIds.has(item.run.record.recordId))
        .map((item) => ({
          ...item,
          selected: selectedHint !== null && item.run.record.recordId === selectedHint
        }));
      runItemsRef.current = [...runItemsRef.current, ...appended];
      nextCursorRef.current = page.nextCursor;
      setHasMoreRuns(page.nextCursor !== null);
      setWorkspaceLoad((current) => {
        if (!current.workspace || current.key !== key) {
          return current;
        }
        return {
          ...current,
          workspace: composeTaskWorkspaceRuns(current.workspace, runItemsRef.current)
        };
      });
    } catch (error: unknown) {
      if (workspaceRequest.current !== request) {
        return;
      }
      setLoadMoreRunsError(errorMessage(error));
    } finally {
      if (workspaceRequest.current === request) {
        loadingMoreRef.current = false;
        setLoadingMoreRuns(false);
      }
    }
  }, [api, key, navigation]);

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
      refresh();
    },
    [api, navigation, refresh]
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
      refresh();
    },
    [api, navigation, refresh]
  );

  const { saveBlockExecutor, saveTaskExecutor } = useTaskWorkspaceExecutorActions({
    api,
    navigation,
    onSaved: refresh
  });

  const liveStatus = useMemo<TaskWorkspaceLiveStatus>(() => {
    if (overviewSelected || !selectedRecordKey) return "idle";
    if (visibleRecordLoad.status === "loading") return "loading";
    if (visibleRecordLoad.status === "error") {
      return "error";
    }
    if (!liveProjection.selectedRun) {
      return "loading";
    }
    if (monitor.subscriptionError || liveProjection.error) return "error";
    if (selectedRecord && !selectedRecord.runnerReadModel) return "unavailable";
    return liveProjection.runnerModel ? "live" : "loading";
  }, [
    liveProjection,
    monitor.subscriptionError,
    overviewSelected,
    visibleRecordLoad.status,
    selectedRecord,
    selectedRecordKey
  ]);
  const liveUnavailableReason =
    liveStatus === "unavailable"
      ? (liveProjection.selectedRun?.item.run.capabilities.prompt.reason ??
        "This run has no live RunnerRecordReadModel.")
      : null;
  const status = workspaceLoad.key === key ? workspaceLoad.status : navigation ? "loading" : "idle";
  const recordError =
    visibleRecordLoad.key === selectedRecordKey ? visibleRecordLoad.error : null;
  const error =
    history.historyError ??
    (workspaceLoad.key === key ? workspaceLoad.error : null) ??
    recordError ??
    liveProjection.error;

  return useMemo<TaskWorkspaceController>(
    () => ({
      error,
      executorOptions,
      getRunScrollTop: (recordId) => runScrollPositions.current.get(recordId) ?? 0,
      hasMoreRuns,
      liveStatus,
      liveUnavailableReason,
      loadMoreRuns,
      loadMoreRunsError,
      loadingMoreRuns,
      navigation,
      onRunScrollTopChange: (recordId, scrollTop) => {
        runScrollPositions.current.set(recordId, Math.max(0, scrollTop));
      },
      packageExecutorNames,
      recordError,
      refresh,
      returnToCanvas: history.returnToTaskWorkspaceSource,
      runnerModel: liveProjection.runnerModel,
      saveBlockExecutor,
      saveBlockPrompt,
      saveTaskExecutor,
      saveTaskPrompt,
      selectAnnotation,
      selectRun,
      selectedAnnotation,
      selectedRecord,
      selectedRun: liveProjection.selectedRun,
      status,
      subscriptionError: monitor.subscriptionError,
      workspace: liveProjection.workspace
    }),
    [
      error,
      executorOptions,
      hasMoreRuns,
      history.returnToTaskWorkspaceSource,
      liveStatus,
      liveUnavailableReason,
      loadMoreRuns,
      loadMoreRunsError,
      loadingMoreRuns,
      monitor.subscriptionError,
      liveProjection,
      navigation,
      packageExecutorNames,
      recordError,
      refresh,
      saveBlockExecutor,
      saveBlockPrompt,
      saveTaskExecutor,
      saveTaskPrompt,
      selectAnnotation,
      selectRun,
      selectedAnnotation,
      selectedRecord,
      status
    ]
  );
}
