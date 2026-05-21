import { useCallback, useEffect, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary, DesktopReviewPipeline, DesktopReviewPipelineStepInput } from "@planweave/runtime";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";

type UseReviewPipelineArgs = {
  graph: DesktopGraphViewModel | null;
  loadProject: (project: DesktopProjectSummary) => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function useReviewPipeline({ graph, loadProject, selectedProject, setError, t }: UseReviewPipelineArgs) {
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [reviewPipeline, setReviewPipeline] = useState<DesktopReviewPipeline | null>(null);
  const [reviewDraft, setReviewDraft] = useState<DesktopReviewPipelineStepInput[]>([]);
  const [reviewDefaultCyclesDraft, setReviewDefaultCyclesDraft] = useState(1);

  useEffect(() => {
    if (!graph) {
      setReviewTaskId(null);
      setReviewPipeline(null);
      setReviewDraft([]);
      return;
    }
    setReviewTaskId((current) => current ?? graph.tasks[0]?.taskId ?? null);
  }, [graph]);

  useEffect(() => {
    if (!bridge || !selectedProject || !reviewTaskId) {
      setReviewPipeline(null);
      setReviewDraft([]);
      return;
    }
    let cancelled = false;
    bridge
      .getReviewPipeline(selectedProject.rootPath, reviewTaskId)
      .then((pipeline) => {
        if (cancelled) {
          return;
        }
        setReviewPipeline(pipeline);
        setReviewDraft(pipeline.steps);
        setReviewDefaultCyclesDraft(pipeline.packageDefaults.maxFeedbackCycles);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reviewTaskId, selectedProject, setError]);

  const updateReviewStep = useCallback((index: number, patch: Partial<DesktopReviewPipelineStepInput>) => {
    setReviewDraft((current) => current.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)));
  }, []);

  const addReviewStep = useCallback(() => {
    setReviewDraft((current) => [
      ...current,
      {
        blockId: "",
        title: t("defaultReviewStepTitle"),
        enabled: true,
        preset: t("defaultReviewStepPreset"),
        triggerCondition: "after_required_work_completed",
        inputContext: t("defaultReviewInputContext"),
        passCriteria: t("defaultReviewPassCriteria"),
        feedbackFormat: t("defaultReviewFeedbackFormat"),
        maxFeedbackCycles: reviewPipeline?.packageDefaults.maxFeedbackCycles ?? 1,
        hook: null,
        promptMarkdown: t("defaultReviewPrompt")
      }
    ]);
  }, [reviewPipeline, t]);

  const moveReviewStep = useCallback((index: number, direction: -1 | 1) => {
    setReviewDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const removeReviewStep = useCallback((index: number) => {
    setReviewDraft((current) => current.filter((_, stepIndex) => stepIndex !== index));
  }, []);

  const saveReviewPipeline = useCallback(async () => {
    if (!bridge || !selectedProject || !reviewTaskId) {
      return;
    }
    try {
      const result = await bridge.updateReviewPipeline(selectedProject.rootPath, reviewTaskId, {
        packageDefaults: {
          maxFeedbackCycles: reviewDefaultCyclesDraft,
          completionPolicy: "strict"
        },
        steps: reviewDraft
      });
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      const pipeline = await bridge.getReviewPipeline(selectedProject.rootPath, reviewTaskId);
      setReviewPipeline(pipeline);
      setReviewDraft(pipeline.steps);
      await loadProject(selectedProject);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, reviewDefaultCyclesDraft, reviewDraft, reviewTaskId, selectedProject, setError]);

  return {
    addReviewStep,
    moveReviewStep,
    removeReviewStep,
    reviewDefaultCyclesDraft,
    reviewDraft,
    reviewPipeline,
    reviewTaskId,
    saveReviewPipeline,
    setReviewDefaultCyclesDraft,
    setReviewTaskId,
    updateReviewStep
  };
}
