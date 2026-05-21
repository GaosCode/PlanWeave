import { useCallback, useState } from "react";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopProjectSummary,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "@planweave/runtime";
import { bridge } from "../bridge";
import type { AppView } from "../types";

type UseSelectedBlockArgs = {
  refreshGraph: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  setSelectedContextNodeId: (nodeId: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
};

export function useSelectedBlock({
  refreshGraph,
  selectedProject,
  setActiveView,
  setError,
  setSelectedContextNodeId,
  setSelectedTaskPanelId
}: UseSelectedBlockArgs) {
  const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [selectedRunRecord, setSelectedRunRecord] = useState<DesktopRunRecord | null>(null);

  const clearSelectedBlockRecords = useCallback(() => {
    setBlockRunRecords([]);
    setBlockReviewAttempts([]);
    setBlockFeedbackRecords([]);
  }, []);

  const handleBlockSelect = useCallback(
    async (ref: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const [block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
        bridge.getBlockDetail(selectedProject.rootPath, ref),
        bridge.listBlockRunRecords(selectedProject.rootPath, ref),
        bridge.getReviewAttempts(selectedProject.rootPath, ref),
        bridge.getFeedbackRecords(selectedProject.rootPath, ref)
      ]);
      setSelectedBlock(block);
      setBlockRunRecords(runRecords);
      setBlockReviewAttempts(reviewAttempts);
      setBlockFeedbackRecords(feedbackRecords);
      setSelectedTaskPanelId(block.taskId);
      setSelectedContextNodeId(null);
      setSelectedRunRecord(null);
      setActiveView("graph");
    },
    [selectedProject, setActiveView, setSelectedContextNodeId, setSelectedTaskPanelId]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined) => {
      if (!bridge || !selectedProject || !recordId) {
        return;
      }
      try {
        setSelectedRunRecord(await bridge.getRunRecord(selectedProject.rootPath, recordId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [selectedProject, setError]
  );

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockTitle(selectedProject.rootPath, selectedBlock.ref, selectedBlock.title);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedProject, setError]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !selectedProject || !selectedBlock) {
        return;
      }
      try {
        const result = await bridge.updateBlockExecutor(selectedProject.rootPath, selectedBlock.ref, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        setSelectedBlock(await bridge.getBlockDetail(selectedProject.rootPath, selectedBlock.ref));
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedBlock, selectedProject, setError]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockPrompt(selectedProject.rootPath, selectedBlock.ref, selectedBlock.promptMarkdown);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedProject, setError]);

  return {
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    clearSelectedBlockRecords,
    handleBlockSelect,
    handleOpenRunRecord,
    saveSelectedBlockExecutor,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    selectedBlock,
    selectedRunRecord,
    setSelectedBlock,
    setSelectedRunRecord
  };
}
