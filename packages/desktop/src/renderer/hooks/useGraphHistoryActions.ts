import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

type OpenProjectInSession = (project: DesktopProjectSummary, canvasId?: string | null, options?: { recordCanvasSelection?: boolean }) => Promise<void>;
type RefreshProjectDerivedState = (options?: { includeLayout?: boolean }) => Promise<void>;

export function useGraphHistoryActions({
  openProjectInSession,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedProject,
  setError
}: {
  openProjectInSession: OpenProjectInSession;
  refreshProjectDerivedState: RefreshProjectDerivedState;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
}) {
  const runGraphHistoryCommand = useCallback(
    async (command: "undo" | "redo") => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
        const result = command === "undo" ? await bridge.undoPlanGraphCommand(canvas) : await bridge.redoPlanGraphCommand(canvas);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        const overview = await bridge.getProjectOverview(selectedProject.rootPath);
        if ((overview.activeCanvasId ?? null) !== selectedCanvasId) {
          await openProjectInSession(overview, overview.activeCanvasId, { recordCanvasSelection: false });
          return;
        }
        await refreshProjectDerivedState({ includeLayout: true });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [openProjectInSession, refreshProjectDerivedState, selectedCanvasId, selectedProject, setError]
  );

  const handleUndoGraph = useCallback(() => runGraphHistoryCommand("undo"), [runGraphHistoryCommand]);
  const handleRedoGraph = useCallback(() => runGraphHistoryCommand("redo"), [runGraphHistoryCommand]);

  return { handleRedoGraph, handleUndoGraph };
}
