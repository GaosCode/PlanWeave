import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class PackagePathError extends Error {
  code = "package_path_outside" as const;
}

function assertContained(root: string, candidate: string, packagePath: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new PackagePathError(`Package path '${packagePath}' must stay inside the package directory.`);
}

async function realpathNearestExistingParent(candidate: string): Promise<string> {
  let current = dirname(candidate);
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

export async function resolvePackagePath(
  packageDir: string,
  packagePath: string,
  options: { requireExisting?: boolean; forWrite?: boolean } = {}
): Promise<string> {
  if (isAbsolute(packagePath)) {
    throw new PackagePathError(`Package path '${packagePath}' must be relative to the package directory.`);
  }

  const root = resolve(packageDir);
  const candidate = resolve(root, packagePath);
  assertContained(root, candidate, packagePath);

  const realRoot = await realpath(root);
  try {
    const realCandidate = await realpath(candidate);
    assertContained(realRoot, realCandidate, packagePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== "ENOENT" && code !== "ENOTDIR") || options.requireExisting) {
      throw error;
    }
    if (options.forWrite) {
      const realParent = await realpathNearestExistingParent(candidate);
      assertContained(realRoot, realParent, packagePath);
    }
  }

  return candidate;
}
