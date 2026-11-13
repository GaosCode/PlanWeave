import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import {
  createPromptRenderContext,
  type PromptRenderContext
} from "../taskManager/promptRenderContext.js";
import { renderPromptSurfaceFromContext } from "../taskManager/promptRenderer.js";
import type { PackageWorkspaceRef, RefreshPromptsResult } from "../types.js";

export async function refreshPrompts(options: {
  projectRoot: PackageWorkspaceRef;
  context?: PromptRenderContext;
}): Promise<RefreshPromptsResult> {
  if (!options.context) {
    const { manifest } = await loadPackage(options.projectRoot);
    if (compileTaskGraph(manifest).blockRefsInManifestOrder.length === 0) return { prompts: [] };
  }
  const context = options.context ?? (await createPromptRenderContext(options));
  const prompts = [];
  for (const ref of context.runtime.graph.blockRefsInManifestOrder) {
    prompts.push({
      ref,
      path: "",
      markdown: (await renderPromptSurfaceFromContext(context, ref)).markdown
    });
  }
  return { prompts };
}
