import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { manifestPromptPaths, type PlanPackageGraphMutation } from "./mutation.js";

async function promptIdentity(
  packageDir: string,
  packagePath: string
): Promise<{ path: string; exists: boolean }> {
  const target = await resolvePackagePath(packageDir, packagePath, { forWrite: true });
  try {
    return { path: await realpath(target), exists: true };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { path: target, exists: false };
    }
    throw error;
  }
}

export async function preparePromptReferenceSideEffects(
  packageDir: string,
  mutation: PlanPackageGraphMutation
): Promise<PlanPackageGraphMutation["sideEffects"]> {
  const removesPrompt = mutation.sideEffects.some((effect) => effect.kind === "removePrompt");
  const restoresPrompt = mutation.sideEffects.some(
    (effect) => effect.kind === "writePrompt" && effect.preserveReferenced
  );
  if (!removesPrompt && !restoresPrompt) {
    return mutation.sideEffects;
  }
  const previousPrompts = new Set(manifestPromptPaths(mutation.baseManifest));
  const survivingReferences = restoresPrompt
    ? mutation.baseManifest.nodes.flatMap((node) => {
        if (node.type !== "task") return [];
        const nextTask = mutation.nextManifest.nodes.find(
          (next) => next.type === "task" && next.id === node.id
        );
        if (nextTask?.type !== "task") return [];
        const existingBlocks = new Map(node.blocks.map((block) => [block.id, block]));
        return [
          { before: node.prompt, after: nextTask.prompt },
          ...nextTask.blocks.flatMap((block) => {
            const previous = existingBlocks.get(block.id);
            return previous ? [{ before: previous.prompt, after: block.prompt }] : [];
          })
        ];
      })
    : [];
  const existingPrompts = new Set<string>();
  await Promise.all(
    survivingReferences.map(async ({ before, after }) => {
      const [previousIdentity, nextIdentity] = await Promise.all([
        promptIdentity(packageDir, before),
        promptIdentity(packageDir, after)
      ]);
      if (
        previousIdentity.exists &&
        nextIdentity.exists &&
        previousIdentity.path === nextIdentity.path
      ) {
        existingPrompts.add(previousIdentity.path);
      }
    })
  );
  const remainingPrompts = new Set(
    await Promise.all(
      (removesPrompt ? manifestPromptPaths(mutation.nextManifest) : []).map((path) =>
        promptIdentity(packageDir, path).then((identity) => identity.path)
      )
    )
  );
  const realRoot = await realpath(packageDir);
  const removedPaths = new Set<string>();
  const sideEffects: PlanPackageGraphMutation["sideEffects"] = [];
  for (const effect of mutation.sideEffects) {
    if (effect.kind !== "removePrompt") {
      if (effect.preserveReferenced) {
        const identity = await promptIdentity(packageDir, effect.packagePath);
        if (identity.exists && existingPrompts.has(identity.path)) continue;
      }
      sideEffects.push(effect);
      continue;
    }
    if (!previousPrompts.has(effect.packagePath)) {
      throw new Error(`Cannot remove unreferenced prompt '${effect.packagePath}'.`);
    }
    const identity = (await promptIdentity(packageDir, effect.packagePath)).path;
    if (remainingPrompts.has(identity)) continue;
    const target = resolve(packageDir, effect.packagePath);
    if (target === resolve(packageDir) || identity === realRoot) {
      throw new Error(`Cannot remove the package directory as prompt '${effect.packagePath}'.`);
    }
    if (!removedPaths.has(target)) {
      sideEffects.push(effect);
      removedPaths.add(target);
    }
  }
  return sideEffects;
}
