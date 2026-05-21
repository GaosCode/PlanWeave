import { renderPrompt } from "../taskManager/index.js";

export async function getPrompt(options: { projectRoot: string; ref: string }): Promise<string> {
  return renderPrompt(options);
}
