import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import type { PlanPackageGraphMutationSideEffect } from "./mutation.js";

type LinkEffect = Extract<PlanPackageGraphMutationSideEffect, { kind: "restorePromptLink" }>;
type Target = { path: string; hash: string };

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function preparePromptLinkRestores(
  packageDir: string,
  sideEffects: PlanPackageGraphMutationSideEffect[]
): Promise<PlanPackageGraphMutationSideEffect[]> {
  if (!sideEffects.some((effect) => effect.kind === "restorePromptLink")) return sideEffects;
  const root = await realpath(packageDir);
  const entryPath = async (packagePath: string): Promise<string> => {
    const path = await resolvePackagePath(root, packagePath, { forWrite: true });
    return join(await realpath(dirname(path)), basename(path));
  };
  const links = new Map<string, LinkEffect>();
  for (const effect of sideEffects) {
    if (effect.kind !== "restorePromptLink") continue;
    const path = await entryPath(effect.packagePath);
    if (links.has(path)) throw new Error(`Duplicate prompt link restore '${effect.packagePath}'.`);
    links.set(path, effect);
  }
  const writes = new Map<string, PlanPackageGraphMutationSideEffect>();
  const ordinary: PlanPackageGraphMutationSideEffect[] = [];
  for (const effect of sideEffects) {
    if (effect.kind === "restorePromptLink") continue;
    const path = await entryPath(effect.packagePath);
    const link = links.get(path);
    if (link) {
      if (effect.kind !== "writePrompt" || hash(effect.markdown) !== link.targetContentHash) {
        throw new Error(`Conflicting prompt link restore '${effect.packagePath}'.`);
      }
      continue;
    }
    ordinary.push(effect);
    writes.set(path, effect);
  }
  const ordered: LinkEffect[] = [];
  const resolved = new Map<string, Target>();
  const visiting = new Set<string>();
  const resolveTarget = async (path: string): Promise<Target> => {
    if (visiting.has(path)) throw new Error("Prompt link restore dependency cycle.");
    const known = resolved.get(path);
    if (known) return known;
    visiting.add(path);
    try {
      const link = links.get(path);
      const stats = await existing(path);
      if (link) {
        if (stats && (!stats.isSymbolicLink() || (await readlink(path)) !== link.linkTarget)) {
          throw new Error(
            `Prompt link restore conflict for '${link.packagePath}': path was replaced.`
          );
        }
        const target = await resolveTarget(
          await entryPath(relative(root, resolve(dirname(path), link.linkTarget)))
        );
        const expected = await entryPath(link.targetPackagePath);
        if (target.path !== expected || target.hash !== link.targetContentHash) {
          throw new Error(
            `Prompt link restore conflict for '${link.packagePath}': target identity or content changed.`
          );
        }
        resolved.set(path, target);
        ordered.push(link);
        return target;
      }
      const planned = writes.get(path);
      if (planned) {
        if (planned.kind !== "writePrompt")
          throw new Error(
            `Prompt link restore target '${planned.packagePath}' is removed by its transaction.`
          );
        const plannedHash = hash(planned.markdown);
        if (stats && (!stats.isFile() || hash(await readFile(path)) !== plannedHash)) {
          throw new Error(
            `Prompt link restore conflict for '${planned.packagePath}': planned target was replaced.`
          );
        }
        return { path, hash: plannedHash };
      }
      if (!stats)
        throw new Error(`Prompt link restore target '${relative(root, path)}' is missing.`);
      if (stats.isSymbolicLink())
        return resolveTarget(
          await entryPath(relative(root, resolve(dirname(path), await readlink(path))))
        );
      return { path, hash: hash(await readFile(path)) };
    } finally {
      visiting.delete(path);
    }
  };
  for (const path of links.keys()) await resolveTarget(path);
  return [...ordinary, ...ordered];
}
