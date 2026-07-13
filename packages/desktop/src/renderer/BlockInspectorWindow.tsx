import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { autoRunEventMatchesCanvas } from "./autoRunEvents";
import { bridge } from "./bridge";
import { createTranslator, type Language } from "./i18n";
import { BlockInspector } from "./inspector/BlockInspector";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";

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
  const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [selectedRunRecord, setSelectedRunRecord] = useState<DesktopRunRecord | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
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
  const { settings } = useDesktopSettingsBridge({ setError });
  const { agentDetections } = useDetectedAgents();
  const draftDirtyRef = useRef(false);

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

  const updateDraftDirty = useCallback((nextDraftDirty: boolean) => {
    draftDirtyRef.current = nextDraftDirty;
    setDraftDirty(nextDraftDirty);
  }, []);

  const loadBlock = useCallback(
    async (
      ref: string,
      options: { resetSelectedRunRecord?: boolean; skipCommitWhenDirty?: boolean } = {}
    ) => {
      if (!bridge || !projectRoot || !ref) {
        return;
      }
      const canvas = { projectRoot, canvasId };
      try {
        const [nextGraph, block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
          bridge.getGraphViewModel(canvas),
          bridge.getBlockDetail(canvas, ref),
          bridge.listBlockRunRecords(canvas, ref),
          bridge.getReviewAttempts(canvas, ref),
          bridge.getFeedbackRecords(canvas, ref)
        ]);
        if (options.skipCommitWhenDirty && draftDirtyRef.current) {
          return;
        }
        setGraph(nextGraph);
        setSelectedBlock(block);
        setBlockRunRecords(runRecords);
        setBlockReviewAttempts(reviewAttempts);
        setBlockFeedbackRecords(feedbackRecords);
        if (options.resetSelectedRunRecord !== false) {
          setSelectedRunRecord(null);
        }
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [canvasId, projectRoot]
  );

  useEffect(() => {
    void loadBlock(blockRef);
  }, [blockRef, loadBlock]);

  const refreshBlock = useCallback(async () => {
    await loadBlock(blockRef);
  }, [blockRef, loadBlock]);

  const handleBlockSelect = useCallback(
    async (ref: string) => {
      setBlockRef(ref);
      await loadBlock(ref);
    },
    [loadBlock]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined) => {
      if (!bridge || !projectRoot || !recordId) {
        return;
      }
      try {
        setSelectedRunRecord(await bridge.getRunRecord({ projectRoot, canvasId }, recordId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [canvasId, projectRoot]
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
    return runtimeBridge.onAutoRunChanged((event) => {
      if (!autoRunEventMatchesCanvas(event, projectRoot, canvasId)) {
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
      if (latestRecordMatchesSelectedRecord && event.latestRecordId) {
        void runtimeBridge
          .getRunRecord({ projectRoot, canvasId }, event.latestRecordId)
          .then(setSelectedRunRecord)
          .catch((caught: unknown) =>
            setError(caught instanceof Error ? caught.message : String(caught))
          );
      }
      if (!draftDirty) {
        void loadBlock(blockRef, { resetSelectedRunRecord: false, skipCommitWhenDirty: true });
      }
    });
  }, [
    blockRef,
    blockRunRecords,
    canvasId,
    draftDirty,
    loadBlock,
    projectRoot,
    selectedRunRecord?.recordId
  ]);

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedBlock) {
      return;
    }
    const result = await bridge.updateBlockTitle(
      { projectRoot, canvasId },
      selectedBlock.ref,
      selectedBlock.title
    );
    if (!result.ok) {
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await refreshBlock();
  }, [canvasId, projectRoot, refreshBlock, selectedBlock]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !projectRoot || !selectedBlock) {
        return;
      }
      const result = await bridge.updateBlockExecutor(
        { projectRoot, canvasId },
        selectedBlock.ref,
        executorName
      );
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await refreshBlock();
    },
    [canvasId, projectRoot, refreshBlock, selectedBlock]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedBlock) {
      return;
    }
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
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await refreshBlock();
  }, [canvasId, projectRoot, refreshBlock, selectedBlock]);

  return (
    <BlockInspector
      blockFeedbackRecords={blockFeedbackRecords}
      blockReviewAttempts={blockReviewAttempts}
      blockRunRecords={blockRunRecords}
      agentDetections={agentDetections}
      canvasRef={{ projectRoot, canvasId }}
      className="inset-0 h-screen w-screen min-w-0 rounded-none border-0 shadow-none ring-0"
      error={error}
      executorOptions={graph?.executorOptions ?? []}
      agentTransport={settings.execution.agentTransport}
      graph={graph}
      handleOpenRunRecord={handleOpenRunRecord}
      onOpenTerminal={handleOpenTerminal}
      onOpenRunTerminal={handleOpenRunTerminal}
      onBlockSelect={handleBlockSelect}
      onClose={() => window.close()}
      onDraftDirtyChange={updateDraftDirty}
      onTerminalDefaultAppChange={handleTerminalDefaultAppChange}
      saveSelectedBlockExecutor={saveSelectedBlockExecutor}
      saveSelectedBlockPrompt={saveSelectedBlockPrompt}
      saveSelectedBlockTitle={saveSelectedBlockTitle}
      selectedBlock={selectedBlock}
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
