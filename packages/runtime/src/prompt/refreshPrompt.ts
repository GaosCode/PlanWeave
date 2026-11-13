import { renderPrompt } from "../taskManager/index.js";
import { renderPromptSurfaceFromContext } from "../taskManager/promptRenderer.js";
import type { PromptRenderContext } from "../taskManager/promptRenderContext.js";
import type { PackageWorkspaceRef, PromptSurface } from "../types.js";

export async function refreshPrompt(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  context?: () => Promise<PromptRenderContext>;
}): Promise<PromptSurface> {
  return {
    ref: options.ref,
    path: "",
    markdown: options.context
      ? (await renderPromptSurfaceFromContext(await options.context(), options.ref)).markdown
      : await renderPrompt(options)
  };
}
