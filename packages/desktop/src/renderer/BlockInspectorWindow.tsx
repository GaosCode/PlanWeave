import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type {
  DesktopAutoRunEvent,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopGraphViewModel,
  DesktopReviewAttemptSummary,
  DesktopRunTerminalAvailability,
  DesktopRunRecord,
  DesktopTerminalAppDetection,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { autoRunEventMatchesInspectorCanvas } from "./autoRunEvents";
import { bridge, collaborationBridge } from "./bridge";
import { runDurablePackageWrite } from "./collaboration/packageWriteAdapter";
import {
  agentEndpointPreferenceKey,
  agentEndpointSelectionId,
  selectedAgentEndpointId
} from "./collaboration/agentEndpointPreferences";
import { applyAgentEndpointRequirements } from "./collaboration/agentEndpointViewModel";
import { inheritAgentEndpointValue } from "./collaboration/AgentEndpointSelect";
import { changeAgentEndpointSelection } from "./collaboration/changeAgentEndpoint";
import { createTranslator, type Language } from "./i18n";
import { BlockInspector } from "./inspector/BlockInspector";
import { useAutoRunSelectionGuard } from "./hooks/useAutoRunSelectionGuard";
import { useBlockInspectorRuntimeSubscription } from "./hooks/useBlockInspectorRuntimeSubscription";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useOwnerControlPlaneAvailability } from "./hooks/useOwnerControlPlaneAvailability";
import { useWorkspaceAgentEndpointCatalog } from "./hooks/useWorkspaceAgentEndpointCatalog";
import { useCollaborationStatus } from "./hooks/useCollaborationStatus";
import { resolveLocalCollaborationOperationScope } from "./collaboration/workspaceCollaborationScope";
import { useCollaborationReadModels } from "./hooks/useCollaborationReadModels";
import type { RemoteRunExecutionLocator } from "./hooks/useRemoteRunPanelController";

function supportedLanguage(value: string | null): Language {
  return value === "en" || value === "zh-CN" ? value : "zh-CN";
}

function latestRecordMatchesBlock(
  event: DesktopAutoRunEvent,
  blockRef: string,
  records: DesktopBlockRunRecordSummary[]
): boolean {
  return Boolean(
    event.latestRecordId &&
      (records.some((record) => record.recordId === event.latestRecordId) ||
        event.latestRecordId.startsWith(`${blockRef}::`))
  );
}

const maxTerminalAvailabilityCandidateRecords = 50;

export function BlockInspectorWindow() {
  const search = window.location.search;
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const projectRoot = params.get("projectRoot") ?? "";
  const initialBlockRef = params.get("blockRef") ?? "";
  const canvasId = params.get("canvasId");
  const language = supportedLanguage(params.get("language"));
  const t = useMemo(() => createTranslator(language), [language]);
  const [blockRef, setBlockRef] = useState(initialBlockRef);
  const [selectedBlock, publishSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [selectedRunRecord, publishSelectedRunRecord] = useState<DesktopRunRecord | null>(null);
  const graphScopeKey = JSON.stringify([projectRoot, canvasId]);
  const [loadedGraph, setLoadedGraph] = useState<{
    scopeKey: string;
    value: DesktopGraphViewModel;
  } | null>(null);
  const graph = loadedGraph?.scopeKey === graphScopeKey ? loadedGraph.value : null;
  const loadRequestRef = useRef({
    sequence: 0,
    foreground: null as number | null,
    pendingRuntime: null as { isCurrent: () => boolean; retry: () => void } | null
  });
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [terminalDefaultAppId, setTerminalDefaultAppId] = useState<DesktopTerminalAppId | null>(
    null
  );
  const [terminalApps, setTerminalApps] = useState<DesktopTerminalAppDetection[]>([]);
  const [terminalAvailabilityByRecordId, setTerminalAvailabilityByRecordId] = useState<
    Record<string, DesktopRunTerminalAvailability>
  >({});
  const [terminalAvailabilityRefreshKey, setTerminalAvailabilityRefreshKey] = useState(0);
  const [tmuxAvailable, setTmuxAvailable] = useState(false);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));
  const [draftDirty, setDraftDirty] = useState(false);
  const { settings, updateSettingsAndWait } = useDesktopSettingsBridge({ setError });
  const { agentDetections } = useDetectedAgents();
  const draftDirtyRef = useRef(false);

  const captureScope = useAutoRunSelectionGuard(projectRoot, canvasId);
  const selection = useRef({
    version: 0,
    ref: initialBlockRef,
    block: null as DesktopBlockDetail | null,
    record: null as DesktopRunRecord | null,
    desiredRecordId: null as string | null,
    runOperation: 0,
    runRefreshOperation: 0,
    promptSave: 0,
    titleSave: 0,
    executorSave: 0,
    editVersion: 0
  });
  const captureBlockSelection = useCallback(() => {
    const scope = captureScope();
    const { version, ref } = selection.current;
    return {
      isCurrent: () =>
        scope.isCurrent() && selection.current.version === version && selection.current.ref === ref
    };
  }, [captureScope]);
  const setSelectedRunRecord = useCallback((value: SetStateAction<DesktopRunRecord | null>) => {
    const current = selection.current;
    const next = typeof value === "function" ? value(current.record) : value;
    current.runOperation += 1;
    current.record = next;
    current.desiredRecordId = next?.recordId ?? null;
    publishSelectedRunRecord(next);
  }, []);
  const beginBlockSelection = useCallback(
    (ref: string) => {
      selection.current.version += 1;
      selection.current.ref = ref;
      setBlockRef(ref);
      setSelectedRunRecord(null);
      draftDirtyRef.current = false;
      setDraftDirty(false);
    },
    [setSelectedRunRecord]
  );
  const setSelectedBlock = useCallback(
    (value: SetStateAction<DesktopBlockDetail | null>) => {
      const current = selection.current;
      const next = typeof value === "function" ? value(current.block) : value;
      if (!next || next.ref !== current.ref) beginBlockSelection(next?.ref ?? "");
      current.editVersion += 1;
      current.block = next;
      publishSelectedBlock(next);
    },
    [beginBlockSelection]
  );

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const runtimeBridge = bridge;
    void Promise.all([
      runtimeBridge.detectTerminalApps(),
      runtimeBridge.getTerminalPreferences(),
      runtimeBridge.detectRuntimeTools()
    ])
      .then(([apps, preferences, runtimeTools]) => {
        setTerminalApps(Array.isArray(apps) ? apps : []);
        setTmuxAvailable(Boolean(runtimeTools?.tmux?.available));
        setTerminalDefaultAppId(preferences?.defaultTerminalAppId ?? null);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught))
      );
  }, []);

  useEffect(() => {
    void terminalAvailabilityRefreshKey;
    if (!bridge || !projectRoot) {
      setTerminalAvailabilityByRecordId({});
      return undefined;
    }
    const candidateRecordIds = blockRunRecords
      .filter((record) => record.tmuxSessionId)
      .slice(0, maxTerminalAvailabilityCandidateRecords)
      .map((record) => record.recordId);
    const recordIds = [
      ...new Set(
        [selectedRunRecord?.recordId, ...candidateRecordIds].filter(
          (recordId): recordId is string => typeof recordId === "string" && recordId.length > 0
        )
      )
    ];
    if (recordIds.length === 0) {
      setTerminalAvailabilityByRecordId({});
      return undefined;
    }
    let cancelled = false;
    void bridge
      .getRunTerminalAvailability({ ref: { projectRoot, canvasId }, recordIds })
      .then((availability) => {
        if (cancelled) {
          return;
        }
        setTerminalAvailabilityByRecordId(
          Object.fromEntries(availability.map((item) => [item.recordId, item]))
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    blockRunRecords,
    canvasId,
    projectRoot,
    selectedRunRecord?.recordId,
    terminalAvailabilityRefreshKey
  ]);

  const editVersion = selection.current.editVersion;
  const selectionVersion = selection.current.version;
  const updateDraftDirty = useCallback(
    (nextDraftDirty: boolean) => {
      if (
        selection.current.version !== selectionVersion ||
        (!nextDraftDirty && selection.current.editVersion !== editVersion)
      )
        return;
      draftDirtyRef.current = nextDraftDirty;
      setDraftDirty(nextDraftDirty);
    },
    [editVersion, selectionVersion]
  );

  const loadBlock = useCallback(
    async (
      ref: string,
      options: {
        resetSelectedRunRecord?: boolean;
        skipCommitWhenDirty?: boolean;
        preserveDirtyDraft?: boolean;
        propagateReadError?: boolean;
        preserveEditsSince?: DesktopBlockDetail;
        isOwnerCurrent?: () => boolean;
      } = {}
    ): Promise<DesktopBlockDetail | undefined> => {
      if (!bridge || !projectRoot || !ref) {
        return;
      }
      const owner = captureBlockSelection();
      if (
        selection.current.ref !== ref ||
        !owner.isCurrent() ||
        options.isOwnerCurrent?.() === false
      )
        return;
      if (options.skipCommitWhenDirty && loadRequestRef.current.foreground !== null) {
        if (options.preserveDirtyDraft)
          loadRequestRef.current.pendingRuntime = {
            isCurrent: owner.isCurrent,
            retry: () => {
              void loadBlock(ref, options);
            }
          };
        return;
      }
      const request = ++loadRequestRef.current.sequence;
      if (!options.skipCommitWhenDirty) loadRequestRef.current.foreground = request;
      const runOperation = selection.current.runOperation;
      const draftBefore = options.preserveEditsSince ?? selection.current.block;
      const isCurrent = () =>
        owner.isCurrent() &&
        request === loadRequestRef.current.sequence &&
        options.isOwnerCurrent?.() !== false;
      const canvas = { projectRoot, canvasId };
      try {
        const [nextGraph, block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
          bridge.getGraphViewModel(canvas),
          bridge.getBlockDetail(canvas, ref),
          bridge.listBlockRunRecords(canvas, ref),
          bridge.getReviewAttempts(canvas, ref),
          bridge.getFeedbackRecords(canvas, ref)
        ]);
        if (!isCurrent()) return;
        if (options.skipCommitWhenDirty && draftDirtyRef.current && !options.preserveDirtyDraft) {
          return;
        }
        setLoadedGraph({ scopeKey: graphScopeKey, value: nextGraph });
        const current = selection.current.block;
        const nextBlock =
          current?.ref === ref && draftBefore?.ref === ref
            ? {
                ...block,
                graphVersion:
                  options.preserveDirtyDraft && draftDirtyRef.current
                    ? current.graphVersion
                    : block.graphVersion,
                promptHash:
                  options.preserveDirtyDraft && draftDirtyRef.current
                    ? current.promptHash
                    : block.promptHash,
                title:
                  (options.preserveDirtyDraft && draftDirtyRef.current) ||
                  current.title !== draftBefore.title
                    ? current.title
                    : block.title,
                promptMarkdown:
                  (options.preserveDirtyDraft && draftDirtyRef.current) ||
                  current.promptMarkdown !== draftBefore.promptMarkdown
                    ? current.promptMarkdown
                    : block.promptMarkdown
              }
            : block;
        selection.current.block = nextBlock;
        publishSelectedBlock(nextBlock);
        setBlockRunRecords(runRecords);
        setBlockReviewAttempts(reviewAttempts);
        setBlockFeedbackRecords(feedbackRecords);
        if (
          options.resetSelectedRunRecord !== false &&
          selection.current.runOperation === runOperation
        ) {
          setSelectedRunRecord(null);
        }
        setError(null);
        return nextBlock;
      } catch (caught) {
        if (!isCurrent()) return;
        setLoadedGraph(null);
        setError(caught instanceof Error ? caught.message : String(caught));
        if (options.propagateReadError) throw caught;
      } finally {
        if (loadRequestRef.current.foreground === request) {
          loadRequestRef.current.foreground = null;
          const pending = loadRequestRef.current.pendingRuntime;
          loadRequestRef.current.pendingRuntime = null;
          if (pending?.isCurrent()) pending.retry();
        }
      }
    },
    [canvasId, captureBlockSelection, graphScopeKey, projectRoot, setSelectedRunRecord]
  );

  useEffect(() => {
    beginBlockSelection(initialBlockRef);
    void loadBlock(initialBlockRef);
  }, [beginBlockSelection, initialBlockRef, loadBlock]);

  const refreshExternalRuntime = useCallback(async () => {
    await loadBlock(blockRef, {
      resetSelectedRunRecord: false,
      skipCommitWhenDirty: true,
      preserveDirtyDraft: true
    });
  }, [blockRef, loadBlock]);
  const retryRuntimeSubscription = useBlockInspectorRuntimeSubscription({
    projectRoot,
    canvasId,
    refresh: refreshExternalRuntime,
    setError
  });

  const refreshRuntimeRemoteExecution = useCallback(async () => {
    const owner = captureBlockSelection();
    await loadBlock(blockRef, {
      resetSelectedRunRecord: false,
      preserveDirtyDraft: true,
      propagateReadError: true
    });
    if (!owner.isCurrent()) return null;
    await retryRuntimeSubscription();
    return owner.isCurrent() ? (selection.current.block?.remoteExecution ?? null) : null;
  }, [blockRef, captureBlockSelection, loadBlock, retryRuntimeSubscription]);

  const workspaceCanvas = null;
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const { status: collaborationStatus } = useCollaborationStatus();
  const operationScope = resolveLocalCollaborationOperationScope(
    collaborationStatus,
    graph?.projectId ?? null
  );
  useCollaborationReadModels({
    operationScope,
    profileId: operationScope?.profileId ?? null,
    projectId: operationScope?.projectId ?? null,
    manageActiveProject: true
  });
  const catalogLocator = useMemo(() => {
    if (!graph?.projectId || !canvasId) return null;
    return { projectId: graph.projectId, canvasId };
  }, [canvasId, graph?.projectId]);
  const executionLocator = useMemo<RemoteRunExecutionLocator | null>(() => {
    if (
      !ownerControlPlane.operatorProfileId ||
      !ownerControlPlane.humanPrincipalId ||
      !graph?.projectId ||
      !projectRoot
    ) {
      return null;
    }
    return {
      kind: "owner_canvas",
      operatorProfileId: ownerControlPlane.operatorProfileId,
      humanPrincipalId: ownerControlPlane.humanPrincipalId,
      projectRoot,
      projectId: graph.projectId,
      canvasId: canvasId ?? "default"
    };
  }, [
    canvasId,
    graph?.projectId,
    ownerControlPlane.humanPrincipalId,
    ownerControlPlane.operatorProfileId,
    projectRoot
  ]);
  const agentEndpointCatalog = useWorkspaceAgentEndpointCatalog({
    agentDetections,
    agentTransport: settings.execution.agentTransport,
    enabled: ownerControlPlane.fleetCatalogEnabled,
    fleetCatalogBlockedCode: ownerControlPlane.fleetCatalogBlockedCode,
    graph,
    operatorProfileId: ownerControlPlane.operatorProfileId,
    humanPrincipalId: ownerControlPlane.humanPrincipalId,
    locator: catalogLocator,
    collaborationApi: collaborationBridge,
    sessionConnected: collaborationStatus?.session.phase === "connected",
    updateSettingsAndWait
  });
  const graphBlock = graph?.tasks
    .find((task) => task.taskId === selectedBlock?.taskId)
    ?.blocks.find((block) => block.ref === selectedBlock?.ref);
  const availableAgentEndpoints = useMemo(
    () =>
      applyAgentEndpointRequirements(
        agentEndpointCatalog.endpoints,
        graphBlock?.requiredCapabilities ?? []
      ),
    [agentEndpointCatalog.endpoints, graphBlock?.requiredCapabilities]
  );
  const endpointPreferenceKey = selectedBlock
    ? agentEndpointPreferenceKey({
        projectRoot,
        canvasId: canvasId ?? "default",
        scope: { kind: "block", blockRef: selectedBlock.ref }
      })
    : null;
  const selectedBlockAgentEndpointId = !selectedBlock
    ? null
    : !selectedBlock.executor
      ? inheritAgentEndpointValue
      : agentEndpointSelectionId(
          selectedAgentEndpointId({
            executorName: selectedBlock.executor,
            preference: endpointPreferenceKey
              ? settings.execution.agentEndpointPreferences[endpointPreferenceKey]
              : undefined,
            endpoints: availableAgentEndpoints
          })
        );

  const handleBlockSelect = useCallback(
    async (ref: string) => {
      beginBlockSelection(ref);
      await loadBlock(ref);
    },
    [beginBlockSelection, loadBlock]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined) => {
      if (!bridge || !projectRoot || !recordId) {
        return;
      }
      const owner = captureBlockSelection();
      const operation = ++selection.current.runOperation;
      selection.current.desiredRecordId = recordId;
      const isCurrent = () => owner.isCurrent() && selection.current.runOperation === operation;
      try {
        const record = await bridge.getRunRecord({ projectRoot, canvasId }, recordId);
        if (!isCurrent()) return;
        selection.current.record = record;
        publishSelectedRunRecord(record);
      } catch (caught) {
        if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [canvasId, captureBlockSelection, projectRoot]
  );

  const handleTerminalDefaultAppChange = useCallback(async (appId: DesktopTerminalAppId) => {
    setTerminalDefaultAppId(appId);
    if (!bridge) {
      return;
    }
    try {
      await bridge.updateTerminalPreferences({ defaultTerminalAppId: appId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const handleOpenRunTerminal = useCallback(
    async (recordId: string, appId: DesktopTerminalAppId) => {
      if (!bridge || !projectRoot) {
        return;
      }
      try {
        await bridge.openRunTerminal({
          ref: { projectRoot, canvasId },
          recordId,
          appId,
          mode: "interactive"
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [canvasId, projectRoot]
  );

  const handleOpenTerminal = useCallback(
    async (recordId: string | null, appId: DesktopTerminalAppId) => {
      if (!bridge || !projectRoot) {
        return;
      }
      try {
        await bridge.openTerminal({
          ref: { projectRoot, canvasId },
          recordId,
          appId
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [canvasId, projectRoot]
  );

  useEffect(() => {
    if (!bridge || !projectRoot || !blockRef) {
      return undefined;
    }
    const runtimeBridge = bridge;
    const owner = captureBlockSelection();
    return runtimeBridge.onAutoRunChanged((event) => {
      if (!owner.isCurrent()) return;
      if (!autoRunEventMatchesInspectorCanvas(event, projectRoot, canvasId)) {
        return;
      }
      const selectedRecordId = selectedRunRecord?.recordId ?? null;
      const latestRecordMatchesSelectedRecord = Boolean(
        event.latestRecordId && event.latestRecordId === selectedRecordId
      );
      const blockMatched =
        event.currentRef === blockRef ||
        latestRecordMatchesBlock(event, blockRef, blockRunRecords) ||
        latestRecordMatchesSelectedRecord;
      if (!blockMatched) {
        return;
      }
      setTerminalAvailabilityRefreshKey((refreshKey) => refreshKey + 1);
      if (
        latestRecordMatchesSelectedRecord &&
        event.latestRecordId &&
        selection.current.desiredRecordId === event.latestRecordId
      ) {
        const recordId = event.latestRecordId;
        const operation = selection.current.runOperation;
        const refreshOperation = ++selection.current.runRefreshOperation;
        const isCurrent = () =>
          owner.isCurrent() &&
          selection.current.runOperation === operation &&
          selection.current.runRefreshOperation === refreshOperation &&
          selection.current.desiredRecordId === recordId;
        void runtimeBridge
          .getRunRecord({ projectRoot, canvasId }, recordId)
          .then((record) => {
            if (!isCurrent()) return;
            selection.current.record = record;
            publishSelectedRunRecord(record);
          })
          .catch((caught: unknown) => {
            if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
          });
      }
      if (!draftDirty) {
        void loadBlock(blockRef, { resetSelectedRunRecord: false, skipCommitWhenDirty: true });
      }
    });
  }, [
    blockRef,
    blockRunRecords,
    canvasId,
    captureBlockSelection,
    draftDirty,
    loadBlock,
    projectRoot,
    selectedRunRecord?.recordId
  ]);

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!projectRoot || !selectedBlock) {
      return;
    }
    const owner = captureBlockSelection();
    const operation = ++selection.current.titleSave;
    const isCurrent = () =>
      owner.isCurrent() &&
      selection.current.titleSave === operation &&
      selection.current.ref === selectedBlock.ref;
    if (!isCurrent()) return;
    const reportError = (message: string | null) => {
      if (isCurrent()) setError(message);
    };
    try {
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_block_fields",
          blockRef: selectedBlock.ref,
          fields: { title: selectedBlock.title }
        },
        onError: reportError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateBlockTitle(
            { projectRoot, canvasId },
            selectedBlock.ref,
            selectedBlock.title
          );
          if (!result.ok) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }
        }
      });
      if (mode === "failed" || mode === "retired" || !isCurrent()) return;
      await loadBlock(selectedBlock.ref, {
        preserveEditsSince: selectedBlock,
        isOwnerCurrent: isCurrent
      });
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [canvasId, captureBlockSelection, projectRoot, loadBlock, selectedBlock]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!projectRoot || !selectedBlock) {
        return false;
      }
      const owner = captureBlockSelection();
      const operation = ++selection.current.executorSave;
      const isCurrent = () =>
        owner.isCurrent() &&
        selection.current.executorSave === operation &&
        selection.current.ref === selectedBlock.ref;
      if (!isCurrent()) return false;
      const reportError = (message: string | null) => {
        if (isCurrent()) setError(message);
      };
      try {
        const mode = await runDurablePackageWrite({
          workspaceCanvas,
          intent: {
            kind: "update_block_fields",
            blockRef: selectedBlock.ref,
            fields: { executor: executorName }
          },
          onError: reportError,
          localWrite: async () => {
            if (!bridge) return;
            const result = await bridge.updateBlockExecutor(
              { projectRoot, canvasId },
              selectedBlock.ref,
              executorName
            );
            if (!result.ok) {
              throw new Error(
                result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              );
            }
          }
        });
        if (mode === "failed" || mode === "retired" || !isCurrent()) return false;
        await loadBlock(selectedBlock.ref, {
          preserveEditsSince: selectedBlock,
          isOwnerCurrent: isCurrent
        });
        return isCurrent();
      } catch (caught) {
        reportError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    },
    [canvasId, captureBlockSelection, projectRoot, loadBlock, selectedBlock]
  );

  const changeEndpoint = useCallback(
    async (endpointId: string) => {
      await changeAgentEndpointSelection({
        endpointId,
        endpoints: availableAgentEndpoints,
        preferenceKey: endpointPreferenceKey,
        allowInherit: true,
        changeLogicalExecutor: saveSelectedBlockExecutor,
        savePreference: agentEndpointCatalog.savePreference,
        setError
      });
    },
    [
      availableAgentEndpoints,
      agentEndpointCatalog.savePreference,
      endpointPreferenceKey,
      saveSelectedBlockExecutor
    ]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!projectRoot || !selectedBlock) {
      return;
    }
    const owner = captureBlockSelection();
    const operation = ++selection.current.promptSave;
    const isCurrent = () =>
      owner.isCurrent() &&
      selection.current.promptSave === operation &&
      selection.current.ref === selectedBlock.ref;
    if (!isCurrent()) return;
    const reportError = (message: string | null) => {
      if (isCurrent()) setError(message);
    };
    try {
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_block_prompt",
          blockRef: selectedBlock.ref,
          promptMarkdown: selectedBlock.promptMarkdown
        },
        onError: reportError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateBlockPrompt(
            { projectRoot, canvasId },
            selectedBlock.ref,
            selectedBlock.promptMarkdown,
            {
              baseGraphVersion: selectedBlock.graphVersion,
              basePromptHash: selectedBlock.promptHash
            }
          );
          if (!result.ok) {
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          }
        }
      });
      if (mode === "failed" || mode === "retired" || !isCurrent()) return;
      await loadBlock(selectedBlock.ref, {
        preserveEditsSince: selectedBlock,
        isOwnerCurrent: isCurrent
      });
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [canvasId, captureBlockSelection, projectRoot, loadBlock, selectedBlock]);

  return (
    <BlockInspector
      agentEndpointCatalogErrorCode={agentEndpointCatalog.errorCode}
      agentEndpoints={agentEndpointCatalog.endpoints}
      blockFeedbackRecords={blockFeedbackRecords}
      blockReviewAttempts={blockReviewAttempts}
      blockRunRecords={blockRunRecords}
      agentDetections={agentDetections}
      canvasRef={{ projectRoot, canvasId }}
      executionLocator={executionLocator}
      refreshRuntimeRemoteExecution={refreshRuntimeRemoteExecution}
      className="inset-0 h-screen w-screen min-w-0 rounded-none border-0 shadow-none ring-0"
      error={error}
      executorOptions={graph?.executorOptions ?? []}
      agentTransport={settings.execution.agentTransport}
      graph={graph}
      handleOpenRunRecord={handleOpenRunRecord}
      onOpenTerminal={handleOpenTerminal}
      onOpenRunTerminal={handleOpenRunTerminal}
      onBlockSelect={handleBlockSelect}
      onAgentEndpointChange={(endpointId) => void changeEndpoint(endpointId)}
      onClose={() => window.close()}
      onDraftDirtyChange={updateDraftDirty}
      onTerminalDefaultAppChange={handleTerminalDefaultAppChange}
      onRefreshAgentEndpoints={agentEndpointCatalog.refresh}
      refreshingAgentEndpoints={agentEndpointCatalog.refreshing}
      saveSelectedBlockPrompt={saveSelectedBlockPrompt}
      saveSelectedBlockTitle={saveSelectedBlockTitle}
      selectedBlock={selectedBlock}
      selectedAgentEndpointId={selectedBlockAgentEndpointId}
      selectedRunRecord={selectedRunRecord}
      setSelectedBlock={setSelectedBlock}
      setSelectedRunRecord={setSelectedRunRecord}
      terminalApps={terminalApps}
      terminalAvailabilityByRecordId={terminalAvailabilityByRecordId}
      terminalDefaultAppId={terminalDefaultAppId}
      tmuxAvailable={tmuxAvailable}
      t={t}
    />
  );
}
