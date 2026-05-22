import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { renderPrompt } from "../taskManager/index.js";
import type { PackageWorkspaceRef, RefreshPromptsResult } from "../types.js";

export async function refreshPrompts(options: { projectRoot: PackageWorkspaceRef }): Promise<RefreshPromptsResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const prompts = [];
  for (const ref of graph.blockRefsInManifestOrder) {
    prompts.push({
      ref,
      path: "",
      markdown: await renderPrompt({ projectRoot: options.projectRoot, ref })
    });
  }
  return { prompts };
}
