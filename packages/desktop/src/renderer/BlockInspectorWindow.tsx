import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopGraphViewModel,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "@planweave/runtime";
import { bridge } from "./bridge";
import { createTranslator, type Language } from "./i18n";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { BlockInspector } from "./inspector/BlockInspector";

function supportedLanguage(value: string | null): Language {
  return value === "en" || value === "zh-CN" ? value : "zh-CN";
}

export function BlockInspectorWindow() {
  const search = window.location.search;
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const projectRoot = params.get("projectRoot") ?? "";
  const initialBlockRef = params.get("blockRef") ?? "";
  const language = supportedLanguage(params.get("language"));
  const t = useMemo(() => createTranslator(language), [language]);
  const { executorOptions } = useDetectedAgents();
  const [blockRef, setBlockRef] = useState(initialBlockRef);
  const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [selectedRunRecord, setSelectedRunRecord] = useState<DesktopRunRecord | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [error, setError] = useState<string | null>(bridge ? null : t("bridgeUnavailable"));

  const loadBlock = useCallback(
    async (ref: string) => {
      if (!bridge || !projectRoot || !ref) {
        return;
      }
      try {
        const [nextGraph, block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
          bridge.getGraphViewModel(projectRoot),
          bridge.getBlockDetail(projectRoot, ref),
          bridge.listBlockRunRecords(projectRoot, ref),
          bridge.getReviewAttempts(projectRoot, ref),
          bridge.getFeedbackRecords(projectRoot, ref)
        ]);
        setGraph(nextGraph);
        setSelectedBlock(block);
        setBlockRunRecords(runRecords);
        setBlockReviewAttempts(reviewAttempts);
        setBlockFeedbackRecords(feedbackRecords);
        setSelectedRunRecord(null);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [projectRoot]
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
        setSelectedRunRecord(await bridge.getRunRecord(projectRoot, recordId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [projectRoot]
  );

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedBlock) {
      return;
    }
    const result = await bridge.updateBlockTitle(projectRoot, selectedBlock.ref, selectedBlock.title);
    if (!result.ok) {
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await refreshBlock();
  }, [projectRoot, refreshBlock, selectedBlock]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !projectRoot || !selectedBlock) {
        return;
      }
      const result = await bridge.updateBlockExecutor(projectRoot, selectedBlock.ref, executorName);
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await refreshBlock();
    },
    [projectRoot, refreshBlock, selectedBlock]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!bridge || !projectRoot || !selectedBlock) {
      return;
    }
    const result = await bridge.updateBlockPrompt(projectRoot, selectedBlock.ref, selectedBlock.promptMarkdown);
    if (!result.ok) {
      setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      return;
    }
    await refreshBlock();
  }, [projectRoot, refreshBlock, selectedBlock]);

  return (
    <BlockInspector
      blockFeedbackRecords={blockFeedbackRecords}
      blockReviewAttempts={blockReviewAttempts}
      blockRunRecords={blockRunRecords}
      className="inset-0 h-screen w-screen min-w-0 rounded-none border-0 shadow-none"
      error={error}
      executorOptions={executorOptions}
      graph={graph}
      handleOpenRunRecord={handleOpenRunRecord}
      onBlockSelect={handleBlockSelect}
      onClose={() => window.close()}
      saveSelectedBlockExecutor={saveSelectedBlockExecutor}
      saveSelectedBlockPrompt={saveSelectedBlockPrompt}
      saveSelectedBlockTitle={saveSelectedBlockTitle}
      selectedBlock={selectedBlock}
      selectedRunRecord={selectedRunRecord}
      setSelectedBlock={setSelectedBlock}
      setSelectedRunRecord={setSelectedRunRecord}
      t={t}
    />
  );
}
