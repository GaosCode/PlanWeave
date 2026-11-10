import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { promptIdentity } from "./promptIdentity.js";
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
  const path = await resolvePackagePath(packageDir, packagePath, { requireExisting: true });
  if (!(await lstat(path)).isSymbolicLink()) return null;
  const identity = await promptIdentity(packageDir, packagePath);
  return {
    packagePath,
    linkTarget: await readlink(path),
    targetPackagePath: relative(await realpath(packageDir), identity.path),
    targetContentHash: await contentHash(identity.path)
  };
}

export async function validatePromptLinkRestore(
  packageDir: string,
  link: PromptLinkRestore
): Promise<{ path: string; exists: boolean }> {
  const path = await resolvePackagePath(packageDir, link.packagePath, { forWrite: true });
  const root = await realpath(packageDir);
  const anchoredTarget = resolve(await realpath(dirname(path)), link.linkTarget);
  const target = await resolvePackagePath(root, relative(root, anchoredTarget), {
    requireExisting: true
  });
  const identity = await promptIdentity(root, relative(root, target));
  const expected = await resolvePackagePath(root, link.targetPackagePath, {
    requireExisting: true
  });
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
