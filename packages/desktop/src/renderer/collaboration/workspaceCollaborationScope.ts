import type { AppView } from "../types";

export function collaborationSurfaceCanvasIdForView(
  activeView: AppView,
  selectedCanvasId: string | null
): string | null {
  return activeView === "people" ? null : selectedCanvasId;
}
