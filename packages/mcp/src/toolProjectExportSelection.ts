import * as z from "zod/v4";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";

export const projectExportFileSelectionSchema = z.object({
  canvasId: z.string().trim().min(1).nullable().optional(),
  path: z.string().trim().min(1)
});

export const projectExportFilesInput = {
  includeProjectPrompt: z.boolean().optional(),
  packageFiles: z.array(projectExportFileSelectionSchema).optional()
};

export const projectExportFilesRequestSchema = z.object(projectExportFilesInput);
export type ProjectExportFilesRequest = z.infer<typeof projectExportFilesRequestSchema>;
export type ResolvedProjectExportFile = { canvasId: string; path: string };

export function resolveProjectExportSelection(
  project: DesktopProjectSummary,
  request: ProjectExportFilesRequest
): ResolvedProjectExportFile[] {
  const selectedCanvasId = project.activeCanvasId ?? project.taskCanvases[0]?.canvasId;
  return (request.packageFiles ?? []).map((file) => {
    const canvasId = file.canvasId ?? selectedCanvasId;
    if (!canvasId) {
      throw new Error("Project has no task canvas.");
    }
    if (!project.taskCanvases.some((canvas) => canvas.canvasId === canvasId)) {
      throw new Error(`Requested project export canvas not found: ${canvasId}`);
    }
    return { canvasId, path: file.path };
  });
}
