import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { promptEntryPath, promptIdentity } from "./promptIdentity.js";
import type { PromptLinkRestore } from "./promptLinkSchema.js";

async function contentHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function capturePromptLink(
  packageDir: string,
  packagePath: string
): Promise<PromptLinkRestore | null> {
  const path = await promptEntryPath(packageDir, packagePath);
  if (!(await lstat(path)).isSymbolicLink()) return null;
  const identity = await promptIdentity(packageDir, packagePath);
  return {
    packagePath,
    linkTarget: await readlink(path),
    targetPackagePath: relative(await realpath(packageDir), identity.path),
    targetContentHash: await contentHash(identity.path)
  };
}

export async function indexPromptLinkRestores(
  packageDir: string,
  links: PromptLinkRestore[]
): Promise<Map<string, PromptLinkRestore>> {
  const indexed = new Map<string, PromptLinkRestore>();
  for (const link of links) {
    const path = await promptEntryPath(packageDir, link.packagePath);
    const previous = indexed.get(path);
    if (previous) {
      if (
        previous.linkTarget !== link.linkTarget ||
        previous.targetContentHash !== link.targetContentHash ||
        (await promptEntryPath(packageDir, previous.targetPackagePath)) !==
          (await promptEntryPath(packageDir, link.targetPackagePath))
      )
        throw new Error(`Conflicting prompt link restore '${link.packagePath}'.`);
    } else indexed.set(path, link);
  }
  return indexed;
}

export async function validatePromptLinkRestore(
  packageDir: string,
  link: PromptLinkRestore
): Promise<{ path: string; exists: boolean }> {
  const path = await promptEntryPath(packageDir, link.packagePath);
  const root = await realpath(packageDir);
  const anchoredTarget = resolve(await realpath(dirname(path)), link.linkTarget);
  const target = await resolvePackagePath(root, relative(root, anchoredTarget), {
    requireExisting: true
  });
  const identity = await promptIdentity(root, relative(root, target));
  const expected = await promptEntryPath(root, link.targetPackagePath);
  if (identity.path !== expected || (await contentHash(identity.path)) !== link.targetContentHash) {
    throw new Error(
      `Prompt link restore conflict for '${link.packagePath}': target identity or content changed.`
    );
  }
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink() || (await readlink(path)) !== link.linkTarget) {
      throw new Error(`Prompt link restore conflict for '${link.packagePath}': path was replaced.`);
    }
    return { path, exists: true };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { path, exists: false };
    throw error;
  }
}
