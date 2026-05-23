import { listTaskCanvases, resolveTaskCanvasWorkspace } from "../canvasApi.js";
import type { DesktopTaskCanvasSummary } from "../types.js";
import type { ProjectWorkspace } from "../../types.js";

export type ProjectTaskCanvasContext = {
  canvasId: string;
  canvasName: string;
  canvas: DesktopTaskCanvasSummary;
  workspace: ProjectWorkspace;
};

export async function mapProjectTaskCanvases<T>(
  projectRoot: string,
  mapper: (context: ProjectTaskCanvasContext) => Promise<T>
): Promise<T[]> {
  const canvases = await listTaskCanvases(projectRoot);
  const results: T[] = [];
  for (const canvas of canvases) {
    results.push(
      await mapper({
        canvas,
        canvasId: canvas.canvasId,
        canvasName: canvas.name,
        workspace: await resolveTaskCanvasWorkspace(projectRoot, canvas.canvasId)
      })
    );
  }
  return results;
}
