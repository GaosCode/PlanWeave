import { realpath } from "node:fs/promises";
import { resolvePackagePath } from "../package/resolvePackagePath.js";

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
