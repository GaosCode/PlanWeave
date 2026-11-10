import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { resolvePackagePath } from "../package/resolvePackagePath.js";

export async function promptEntryPath(packageDir: string, packagePath: string): Promise<string> {
  const path = await resolvePackagePath(packageDir, packagePath, { forWrite: true });
  let parent = dirname(path);
  while (true) {
    try {
      return resolve(await realpath(parent), relative(parent, path));
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      )
        throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

export async function promptIdentity(
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
