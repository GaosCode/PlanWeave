import type { createTranslator, TranslationKey } from "./i18n";

type RendererNavigator = {
  platform?: string;
  userAgent?: string;
  userAgentData?: {
    platform?: string;
  };
};

type FileManagerPlatform = "darwin" | "win32" | "generic";
type FileManagerLabelTarget = "open" | "planWorkspace" | "sourceRoot" | "taskCanvas" | "task";

const labelKeys: Record<FileManagerPlatform, Record<FileManagerLabelTarget, TranslationKey>> = {
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

export function detectRendererFileManagerPlatform(
  navigatorLike: RendererNavigator | undefined = globalThis.navigator
): FileManagerPlatform {
  const platformText = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (platformText.includes("mac") || platformText.includes("darwin")) {
    return "darwin";
  }
  if (platformText.includes("win")) {
    return "win32";
  }
  return "generic";
}

export function fileManagerLabelKey(
  target: FileManagerLabelTarget,
  platform = detectRendererFileManagerPlatform()
): TranslationKey {
  return labelKeys[platform][target];
}

export function fileManagerLabel(
  t: ReturnType<typeof createTranslator>,
  target: FileManagerLabelTarget
): string {
  return t(fileManagerLabelKey(target));
}
