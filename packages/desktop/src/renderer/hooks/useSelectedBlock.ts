import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopProjectSummary,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "@planweave-ai/runtime";
import { autoRunEventMatchesProjectCanvas } from "../autoRunEvents";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { AppView } from "../types";
import { useAutoRunSelectionGuard } from "./useAutoRunSelectionGuard";
import type { DesktopSelectionReceipt } from "./useDesktopProjectSnapshot";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

export type SelectedBlockSelection = {
  block: DesktopBlockDetail;
  isCurrent: () => boolean;
};

type UseSelectedBlockArgs = {
  captureSelectionScope: () => DesktopSelectionReceipt;
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  /** When enabled, durable block field/prompt writes go through Workspace Canvas commands. */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

export function useSelectedBlock({
  captureSelectionScope,
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
  workspaceCanvas = null
}: UseSelectedBlockArgs) {
  const captureSelection = useAutoRunSelectionGuard(
    selectedProject?.rootPath ?? null,
    selectedCanvasId,
    null,
    selectedProject?.workspaceRoot ?? null
  );
  const [selectedBlock, publishSelectedBlock] = useState<DesktopBlockDetail | null>(null);
  const [blockRunRecords, setBlockRunRecords] = useState<DesktopBlockRunRecordSummary[]>([]);
  const [blockReviewAttempts, setBlockReviewAttempts] = useState<DesktopReviewAttemptSummary[]>([]);
  const [blockFeedbackRecords, setBlockFeedbackRecords] = useState<DesktopFeedbackRecord[]>([]);
  const [selectedRunRecord, publishSelectedRunRecord] = useState<DesktopRunRecord | null>(null);

  const selection = useRef({
    version: 0,
    ref: null as string | null,
    canvasId: selectedCanvasId,
    block: null as DesktopBlockDetail | null,
    record: null as DesktopRunRecord | null,
    recordsOperation: 0,
    runOperation: 0,
    promptOperation: 0,
    titleOperation: 0,
    runRefreshOperation: 0,
    editVersion: 0,
    owner: null as DesktopSelectionReceipt | null,
    desiredRecordId: null as string | null
  });

  const captureBlockRequest = useCallback(() => {
    const scope = captureSelectionScope();
    const lifecycle = captureSelection();
    const owner = selection.current.owner;
    const version = selection.current.version;
    const ref = selection.current.ref;
    return {
      isCurrent: () =>
        scope.isCurrent() &&
        lifecycle.isCurrent() &&
        (!owner || owner.isCurrent()) &&
        selection.current.version === version &&
        selection.current.ref === ref
    };
  }, [captureSelection, captureSelectionScope]);

  const setSelectedBlock = useCallback(
    (value: SetStateAction<DesktopBlockDetail | null>) => {
      const current = selection.current;
      const next = typeof value === "function" ? value(current.block) : value;
      if (!next || next.ref !== current.ref) {
        current.version += 1;
        current.runOperation += 1;
        current.recordsOperation += 1;
        current.ref = next?.ref ?? null;
        current.canvasId = selectedCanvasId;
        current.owner = captureSelectionScope();
      }
      current.editVersion += 1;
      current.block = next;
      publishSelectedBlock(next);
    },
    [captureSelectionScope, selectedCanvasId]
  );

  const setSelectedRunRecord = useCallback((value: SetStateAction<DesktopRunRecord | null>) => {
    selection.current.runOperation += 1;
    const next = typeof value === "function" ? value(selection.current.record) : value;
    selection.current.record = next;
    selection.current.desiredRecordId = next?.recordId ?? null;
    publishSelectedRunRecord(next);
  }, []);

  const clearSelectedBlockRecords = useCallback(() => {
    selection.current.recordsOperation += 1;
    setBlockRunRecords([]);
    setBlockReviewAttempts([]);
    setBlockFeedbackRecords([]);
  }, []);

  const refreshSelectedBlockRecords = useCallback(
    async (block: DesktopBlockDetail) => {
      if (!bridge || !selectedProject || selection.current.ref !== block.ref) return;
      const request = captureBlockRequest();
      const operation = ++selection.current.recordsOperation;
      const editVersion = selection.current.editVersion;
      const isCurrent = () =>
        request.isCurrent() && selection.current.recordsOperation === operation;
      const canvas = desktopCanvasReference(selectedProject, selection.current.canvasId);
      try {
        const [nextBlock, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
          bridge.getBlockDetail(canvas, block.ref),
          bridge.listBlockRunRecords(canvas, block.ref),
          bridge.getReviewAttempts(canvas, block.ref),
          bridge.getFeedbackRecords(canvas, block.ref)
        ]);
        if (!isCurrent()) return;
        if (selection.current.editVersion === editVersion) {
          selection.current.block = nextBlock;
          publishSelectedBlock(nextBlock);
        }
        setBlockRunRecords(runRecords);
        setBlockReviewAttempts(reviewAttempts);
        setBlockFeedbackRecords(feedbackRecords);
      } catch (caught) {
        if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [captureBlockRequest, selectedProject, setError]
  );

  const restoreBlockSelection = useCallback(
    async (
      ref: string,
      canvasIdOverride?: string | null
    ): Promise<SelectedBlockSelection | undefined> => {
      if (!bridge || !selectedProject) return;
      const canvasId = canvasIdOverride === undefined ? selectedCanvasId : canvasIdOverride;
      selection.current.owner = captureSelectionScope();
      selection.current.version += 1;
      selection.current.ref = ref;
      selection.current.canvasId = canvasId;
      selection.current.runOperation += 1;
      const recordsOperation = ++selection.current.recordsOperation;
      const request = captureBlockRequest();
      const canvas = desktopCanvasReference(selectedProject, canvasId);
      try {
        const [block, runRecords, reviewAttempts, feedbackRecords] = await Promise.all([
          bridge.getBlockDetail(canvas, ref),
          bridge.listBlockRunRecords(canvas, ref),
          bridge.getReviewAttempts(canvas, ref),
          bridge.getFeedbackRecords(canvas, ref)
        ]);
        if (!request.isCurrent()) return;
        selection.current.block = block;
        publishSelectedBlock(block);
        if (selection.current.recordsOperation === recordsOperation) {
          setBlockRunRecords(runRecords);
          setBlockReviewAttempts(reviewAttempts);
          setBlockFeedbackRecords(feedbackRecords);
        }
        setSelectedRunRecord(null);
        return { block, isCurrent: request.isCurrent };
      } catch (caught) {
        if (request.isCurrent())
          setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      captureBlockRequest,
      captureSelectionScope,
      selectedCanvasId,
      selectedProject,
      setError,
      setSelectedRunRecord
    ]
  );

  const handleBlockSelect = useCallback(
    async (ref: string, canvasIdOverride?: string | null) => {
      const accepted = await restoreBlockSelection(ref, canvasIdOverride);
      if (!accepted?.isCurrent()) return;
      setActiveView("graph");
      return accepted;
    },
    [restoreBlockSelection, setActiveView]
  );

  const handleOpenRunRecord = useCallback(
    async (recordId: string | null | undefined, canvasIdOverride?: string | null) => {
      if (!bridge || !selectedProject || !recordId) return;
      const request = captureBlockRequest();
      const operation = ++selection.current.runOperation;
      selection.current.desiredRecordId = recordId;
      const isCurrent = () => request.isCurrent() && selection.current.runOperation === operation;
      try {
        const canvasId =
          canvasIdOverride === undefined ? selection.current.canvasId : canvasIdOverride;
        const record = await bridge.getRunRecord(
          desktopCanvasReference(selectedProject, canvasId),
          recordId
        );
        if (!isCurrent()) return;
        selection.current.record = record;
        publishSelectedRunRecord(record);
      } catch (caught) {
        if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [captureBlockRequest, selectedProject, setError]
  );

  useEffect(() => {
    if (!bridge || !selectedProject || !selectedBlock) {
      return undefined;
    }
    const runtimeBridge = bridge;
    const request = captureBlockRequest();
    return runtimeBridge.onAutoRunChanged((event) => {
      if (!request.isCurrent()) return;
      if (
        !autoRunEventMatchesProjectCanvas(
          event,
          selectedProject.rootPath,
          selection.current.canvasId,
          selectedProject.workspaceRoot
        )
      ) {
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
        const recordId = event.latestRecordId;
        const operation = selection.current.runOperation;
        const refreshOperation = ++selection.current.runRefreshOperation;
        const isCurrent = () =>
          request.isCurrent() &&
          selection.current.runOperation === operation &&
          selection.current.runRefreshOperation === refreshOperation &&
          selection.current.desiredRecordId === recordId;
        void runtimeBridge
          .getRunRecord(
            desktopCanvasReference(selectedProject, selection.current.canvasId),
            recordId
          )
          .then((record) => {
            if (!isCurrent()) return;
            selection.current.record = record;
            publishSelectedRunRecord(record);
          })
          .catch((caught: unknown) => {
            if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
          });
      }
      void refreshSelectedBlockRecords(selectedBlock);
    });
  }, [
    blockRunRecords,
    captureBlockRequest,
    refreshSelectedBlockRecords,
    selectedBlock,
    selectedProject,
    selectedRunRecord?.recordId,
    setError
  ]);

  const saveSelectedBlockTitle = useCallback(async () => {
    if (!selectedProject || !selectedBlock || selection.current.ref !== selectedBlock.ref) {
      return;
    }
    const request = captureBlockRequest();
    const operation = ++selection.current.titleOperation;
    const isCurrent = () => request.isCurrent() && selection.current.titleOperation === operation;
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
          await bridge.updateBlockTitle(
            desktopCanvasReference(selectedProject, selection.current.canvasId),
            selectedBlock.ref,
            selectedBlock.title
          );
        }
      });
      if (mode === "failed" || mode === "retired" || !isCurrent()) return;
      await refreshGraph();
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [
    captureBlockRequest,
    refreshGraph,
    selectedBlock,
    selectedProject,
    setError,
    workspaceCanvas
  ]);

  const saveSelectedBlockPrompt = useCallback(async () => {
    if (!selectedProject || !selectedBlock || selection.current.ref !== selectedBlock.ref) {
      return;
    }
    const request = captureBlockRequest();
    const operation = ++selection.current.promptOperation;
    const isCurrent = () => request.isCurrent() && selection.current.promptOperation === operation;
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
            desktopCanvasReference(selectedProject, selection.current.canvasId),
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
      if (bridge && mode === "local") {
        const nextBlock = await bridge.getBlockDetail(
          desktopCanvasReference(selectedProject, selection.current.canvasId),
          selectedBlock.ref
        );
        if (!isCurrent()) return;
        const current = selection.current.block;
        const merged = {
          ...nextBlock,
          title: current && current.title !== selectedBlock.title ? current.title : nextBlock.title,
          promptMarkdown:
            current && current.promptMarkdown !== selectedBlock.promptMarkdown
              ? current.promptMarkdown
              : nextBlock.promptMarkdown
        };
        selection.current.editVersion += 1;
        selection.current.block = merged;
        publishSelectedBlock(merged);
      }
      await refreshGraph();
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [
    captureBlockRequest,
    refreshGraph,
    selectedBlock,
    selectedProject,
    setError,
    workspaceCanvas
  ]);

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
