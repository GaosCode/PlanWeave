import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopProjectSummary,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "@planweave-ai/runtime";
import { autoRunEventMatchesCanvas } from "../autoRunEvents";
import { bridge, desktopCanvasReference } from "../bridge";
import type { AppView } from "../types";

type UseSelectedBlockArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
};

export function useSelectedBlock({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError
}: UseSelectedBlockArgs) {
  const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [selectedRunRecord, setSelectedRunRecord] = useState<DesktopRunRecord | null>(null);

  const refreshSelectedBlockRecords = useCallback(
    async (block: DesktopBlockDetail) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      const [nextBlock, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
        bridge.getBlockDetail(canvas, block.ref),
        bridge.listBlockRunRecords(canvas, block.ref),
        bridge.getReviewAttempts(canvas, block.ref),
        bridge.getFeedbackRecords(canvas, block.ref)
      ]);
      setSelectedBlock(nextBlock);
      setBlockRunRecords(runRecords);
      setBlockReviewAttempts(reviewAttempts);
      setBlockFeedbackRecords(feedbackRecords);
    },
    [selectedCanvasId, selectedProject]
  );

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
      setSelectedRunRecord(null);
      setActiveView("graph");
      return block;
    },
    [selectedCanvasId, selectedProject, setActiveView]
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
    if (!bridge || !selectedProject || !selectedBlock) {
      return undefined;
    }
    const runtimeBridge = bridge;
    return runtimeBridge.onAutoRunChanged((event) => {
      if (!autoRunEventMatchesCanvas(event, selectedProject.rootPath, selectedCanvasId)) {
        return;
      }
      const selectedRecordId = selectedRunRecord?.recordId ?? null;
      const latestRecordMatchesSelectedRecord = Boolean(event.latestRecordId && event.latestRecordId === selectedRecordId);
      const latestRecordMatchesSelectedBlock = Boolean(
        event.latestRecordId && (blockRunRecords.some((record) => record.recordId === event.latestRecordId) || event.latestRecordId.startsWith(`${selectedBlock.ref}::`))
      );
      const currentRefMatchesSelectedBlock = event.currentRef === selectedBlock.ref;
      if (!latestRecordMatchesSelectedRecord && !latestRecordMatchesSelectedBlock && !currentRefMatchesSelectedBlock) {
        return;
      }
      if (latestRecordMatchesSelectedRecord && event.latestRecordId) {
        void runtimeBridge
          .getRunRecord(desktopCanvasReference(selectedProject, selectedCanvasId), event.latestRecordId)
          .then(setSelectedRunRecord)
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
      }
      void refreshSelectedBlockRecords(selectedBlock).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    });
  }, [blockRunRecords, refreshSelectedBlockRecords, selectedBlock, selectedCanvasId, selectedProject, selectedRunRecord?.recordId, setError]);


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
      const result = await bridge.updateBlockPrompt(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref, selectedBlock.promptMarkdown, {
        baseGraphVersion: selectedBlock.graphVersion,
        basePromptHash: selectedBlock.promptHash
      });
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      setSelectedBlock(await bridge.getBlockDetail(desktopCanvasReference(selectedProject, selectedCanvasId), selectedBlock.ref));
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
