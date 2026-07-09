import { renderPrompt } from "../taskManager/index.js";
import type { PackageWorkspaceRef, PromptSurface } from "../types.js";

export async function refreshPrompt(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
}): Promise<PromptSurface> {
  return {
    ref: options.ref,
    path: "",
    markdown: await renderPrompt(options)
  };
}
