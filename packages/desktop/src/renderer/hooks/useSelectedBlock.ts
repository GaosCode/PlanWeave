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
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { AppView } from "../types";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

type UseSelectedBlockArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  /** When enabled, durable block field/prompt writes go through Workspace Canvas commands. */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

export function useSelectedBlock({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
  workspaceCanvas = null
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

  const restoreBlockSelection = useCallback(
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
      return block;
    },
    [selectedCanvasId, selectedProject]
  );

  const handleBlockSelect = useCallback(
    async (ref: string, canvasIdOverride?: string | null) => {
      const block = await restoreBlockSelection(ref, canvasIdOverride);
      if (block) {
        setActiveView("graph");
      }
      return block;
    },
    [restoreBlockSelection, setActiveView]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined, canvasIdOverride?: string | null) => {
      if (!bridge || !selectedProject || !recordId) {
        return;
      }
      try {
        const canvasId = canvasIdOverride === undefined ? selectedCanvasId : canvasIdOverride;
        setSelectedRunRecord(
          await bridge.getRunRecord(desktopCanvasReference(selectedProject, canvasId), recordId)
        );
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
      const latestRecordMatchesSelectedRecord = Boolean(
        event.latestRecordId && event.latestRecordId === selectedRecordId
      );
      const latestRecordMatchesSelectedBlock = Boolean(
        event.latestRecordId &&
          (blockRunRecords.some((record) => record.recordId === event.latestRecordId) ||
            event.latestRecordId.startsWith(`${selectedBlock.ref}::`))
      );
      const currentRefMatchesSelectedBlock = event.currentRef === selectedBlock.ref;
      if (
        !latestRecordMatchesSelectedRecord &&
        !latestRecordMatchesSelectedBlock &&
        !currentRefMatchesSelectedBlock
      ) {
        return;
      }
      if (latestRecordMatchesSelectedRecord && event.latestRecordId) {
        void runtimeBridge
          .getRunRecord(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            event.latestRecordId
          )
          .then(setSelectedRunRecord)
          .catch((caught: unknown) =>
            setError(caught instanceof Error ? caught.message : String(caught))
          );
      }
      void refreshSelectedBlockRecords(selectedBlock).catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught))
      );
    });
  }, [
    blockRunRecords,
    refreshSelectedBlockRecords,
    selectedBlock,
    selectedCanvasId,
    selectedProject,
    selectedRunRecord?.recordId,
    setError
  ]);

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!selectedProject || !selectedBlock) {
      return;
    }
    try {
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_block_fields",
          blockRef: selectedBlock.ref,
          fields: { title: selectedBlock.title }
        },
        onError: setError,
        localWrite: async () => {
          if (!bridge) return;
          await bridge.updateBlockTitle(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            selectedBlock.ref,
            selectedBlock.title
          );
        }
      });
      if (mode === "failed") return;
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedCanvasId, selectedProject, setError, workspaceCanvas]);

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!selectedProject || !selectedBlock) {
      return;
    }
    try {
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_block_prompt",
          blockRef: selectedBlock.ref,
          promptMarkdown: selectedBlock.promptMarkdown
        },
        onError: setError,
        localWrite: async () => {
          if (!bridge) return;
          const result = await bridge.updateBlockPrompt(
            desktopCanvasReference(selectedProject, selectedCanvasId),
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
      if (mode === "failed") return;
      if (bridge && mode === "local") {
        setSelectedBlock(
          await bridge.getBlockDetail(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            selectedBlock.ref
          )
        );
      }
      await refreshGraph();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshGraph, selectedBlock, selectedCanvasId, selectedProject, setError, workspaceCanvas]);

  return {
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    clearSelectedBlockRecords,
    handleBlockSelect,
    handleOpenRunRecord,
    restoreBlockSelection,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    selectedBlock,
    selectedRunRecord,
    setSelectedBlock,
    setSelectedRunRecord
  };
}
