import { renderPrompt } from "../taskManager/index.js";
import type { PromptSurface } from "../types.js";

export async function refreshPrompt(options: { projectRoot: string; ref: string }): Promise<PromptSurface> {
  return {
    ref: options.ref,
    path: "",
    markdown: await renderPrompt(options)
  };
}
