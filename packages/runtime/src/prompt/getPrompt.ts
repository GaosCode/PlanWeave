import { renderPrompt } from "../taskManager/index.js";
import type { PackageWorkspaceRef } from "../types.js";

export async function getPrompt(options: { projectRoot: PackageWorkspaceRef; ref: string }): Promise<string> {
  return renderPrompt(options);
}
