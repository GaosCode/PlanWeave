import type { createTranslator, TranslationKey } from "./i18n";
import { detectRendererPlatform, type RendererPlatform } from "./rendererPlatform";

type FileManagerLabelTarget = "open" | "planWorkspace" | "sourceRoot" | "taskCanvas" | "task";

const labelKeys: Record<RendererPlatform, Record<FileManagerLabelTarget, TranslationKey>> = {
  darwin: {
    open: "openInFinder",
    planWorkspace: "openPlanWorkspaceInFinder",
    sourceRoot: "openSourceRootInFinder",
    taskCanvas: "openTaskCanvasInFinder",
    task: "openTaskInFinder"
  },
  win32: {
    open: "openInFileExplorer",
    planWorkspace: "openPlanWorkspaceInFileExplorer",
    sourceRoot: "openSourceRootInFileExplorer",
    taskCanvas: "openTaskCanvasInFileExplorer",
    task: "openTaskInFileExplorer"
  },
  generic: {
    open: "openInFileManager",
    planWorkspace: "openPlanWorkspaceInFileManager",
    sourceRoot: "openSourceRootInFileManager",
    taskCanvas: "openTaskCanvasInFileManager",
    task: "openTaskInFileManager"
  }
};

export function fileManagerLabelKey(
  target: FileManagerLabelTarget,
  platform = detectRendererPlatform()
): TranslationKey {
  return labelKeys[platform][target];
}

export function fileManagerLabel(
  t: ReturnType<typeof createTranslator>,
  target: FileManagerLabelTarget
): string {
  return t(fileManagerLabelKey(target));
}
