import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopProjectSummary,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "@planweave/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { AppView } from "../types";

type UseSelectedBlockArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
};

export function useSelectedBlock({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
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
    async (ref: string, canvasIdOverride?: string | null) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvasId = canvasIdOverride === undefined ? selectedCanvasId : canvasIdOverride;
      const canvas = desktopCanvasReference(selectedProject, canvasId);
      const [block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
        bridge.getBlockDetail(canvas, ref),
        bridge.listBlockRunRecords(canvas, ref),
        bridge.getReviewAttempts(canvas, ref),
        bridge.getFeedbackRecords(canvas, ref)
      ]);
      setSelectedBlock(block);
      setBlockRunRecords(runRecords);
      setBlockReviewAttempts(reviewAttempts);
      setBlockFeedbackRecords(feedbackRecords);
      setSelectedTaskPanelId(block.taskId);
      setSelectedRunRecord(null);
      setActiveView("graph");
    },
    [selectedCanvasId, selectedProject, setActiveView, setSelectedTaskPanelId]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined, canvasIdOverride?: string | null) => {
      if (!bridge || !selectedProject || !recordId) {
        return;
      }
      try {
        const canvasId = canvasIdOverride === undefined ? selectedCanvasId : canvasIdOverride;
        setSelectedRunRecord(await bridge.getRunRecord(desktopCanvasReference(selectedProject, canvasId), recordId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [selectedCanvasId, selectedProject, setError]
  );

  useEffect(() => {
    if (!bridge || !selectedProject || !selectedRunRecord || selectedRunRecord.finishedAt) {
      return undefined;
    }
    const runtimeBridge = bridge;
    const recordId = selectedRunRecord.recordId;
    const timer = window.setInterval(() => {
      void runtimeBridge
        .getRunRecord(desktopCanvasReference(selectedProject, selectedCanvasId), recordId)
        .then(setSelectedRunRecord)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedCanvasId, selectedProject, selectedRunRecord, setError]);

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockTitle(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref, selectedBlock.title);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedCanvasId, selectedProject, setError]);

  const saveSelectedBlockExecutor = useCallback(
    async (executorName: string | null) => {
      if (!bridge || !selectedProject || !selectedBlock) {
        return;
      }
      try {
        const result = await bridge.updateBlockExecutor(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref, executorName);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        setSelectedBlock(await bridge.getBlockDetail(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref));
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedBlock, selectedCanvasId, selectedProject, setError]
  );

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return;
    }
    try {
      await bridge.updateBlockPrompt(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref, selectedBlock.promptMarkdown);
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedCanvasId, selectedProject, setError]);

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
