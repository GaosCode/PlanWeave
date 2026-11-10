import { preparePromptLinkRestores } from "../graph/promptLinkRestorePlan.js";
import { preparePromptReferenceSideEffects } from "../graph/promptRemoval.js";
import type { PlanPackageGraphMutation } from "../graph/mutation.js";
import { capturePromptLink, indexPromptLinkRestores } from "../graph/promptLink.js";
import { promptEntryPath } from "../graph/promptIdentity.js";
import type { PromptLinkRestore } from "../graph/promptLinkSchema.js";
import type { PlanGraphCommand } from "./commands.js";

function canRestoreLinks(
  command: PlanGraphCommand
): command is Extract<
  PlanGraphCommand,
  { type: "restoreTask" | "restoreBlock" | "updateReviewPipeline" }
> {
  return (
    command.type === "restoreTask" ||
    command.type === "restoreBlock" ||
    command.type === "updateReviewPipeline"
  );
}

export async function captureRemovedPromptLinks(
  command: PlanGraphCommand | PlanGraphCommand[],
  packageDir: string,
  sideEffects: PlanPackageGraphMutation["sideEffects"]
): Promise<PlanGraphCommand | PlanGraphCommand[]> {
  const removed = sideEffects.filter((effect) => effect.kind === "removePrompt");
  if (!removed.length) return command;
  if (Array.isArray(command) || !canRestoreLinks(command))
    throw new Error("Prompt removal requires one restorable history command.");
  const links: PromptLinkRestore[] = [];
  for (const effect of removed) {
    const link = await capturePromptLink(packageDir, effect.packagePath);
    if (link) links.push(link);
  }
  return links.length ? { ...command, promptLinkRestores: links } : command;
}

export async function preparePromptLinkMutation(
  command: PlanGraphCommand,
  packageDir: string,
  mutation: PlanPackageGraphMutation
): Promise<PlanPackageGraphMutation> {
  if (!canRestoreLinks(command) || !command.promptLinkRestores?.length) return mutation;
  const links = await indexPromptLinkRestores(packageDir, command.promptLinkRestores);
  const restored = new Set<string>();
  const sideEffects: PlanPackageGraphMutation["sideEffects"] = [];
  for (const effect of mutation.sideEffects) {
    const path = await promptEntryPath(packageDir, effect.packagePath);
    const link = links.get(path);
    if (!link) {
      sideEffects.push(effect);
      continue;
    }
    if (effect.kind !== "writePrompt")
      throw new Error(`Conflicting prompt link restore '${effect.packagePath}'.`);
    sideEffects.push(effect);
    if (restored.has(path)) continue;
    restored.add(path);
    sideEffects.push({ kind: "restorePromptLink", ...link });
  }
  if (restored.size !== links.size)
    throw new Error("Prompt link restore has no matching prompt write.");
  const prepared = await preparePromptReferenceSideEffects(packageDir, {
    ...mutation,
    sideEffects
  });
  return { ...mutation, sideEffects: await preparePromptLinkRestores(packageDir, prepared) };
}
