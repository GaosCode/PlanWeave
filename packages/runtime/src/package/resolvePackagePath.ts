import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";

export class PackagePathError extends Error {
  code = "package_path_outside" as const;
}

function assertContained(root: string, candidate: string, packagePath: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new PackagePathError(
    `Package path '${packagePath}' must stay inside the package directory.`
  );
}

async function realpathNearestExistingParent(
  candidate: string
): Promise<{ path: string; realPath: string }> {
  let current = dirname(candidate);
  while (true) {
    try {
      return { path: current, realPath: await realpath(current) };
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
  const candidate = packagePathCandidate(packageDir, packagePath);
  const realRoot = await realpath(resolve(packageDir));
  try {
    const realCandidate = await realpath(candidate);
    assertContained(realRoot, realCandidate, packagePath);
  } catch (error) {
    if (!isNodeFileNotFoundError(error) || options.requireExisting) {
      throw error;
    }
    if (options.forWrite) {
      const realParent = await realpathNearestExistingParent(candidate);
      assertContained(realRoot, realParent.realPath, packagePath);
    }
  }

  return candidate;
}

function packagePathCandidate(packageDir: string, packagePath: string): string {
  if (isAbsolute(packagePath)) {
    throw new PackagePathError(
      `Package path '${packagePath}' must be relative to the package directory.`
    );
  }

  const root = resolve(packageDir);
  const candidate = resolve(root, packagePath);
  assertContained(root, candidate, packagePath);

  return candidate;
}

async function resolvePackageLinkTarget(
  realRoot: string,
  parent: string,
  link: string,
  packagePath: string
): Promise<string> {
  const target = resolve(parent, link);
  const fromRoot = relative(realRoot, target);
  if (!fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return target;
  const ancestor = await realpathNearestExistingParent(target);
  assertContained(realRoot, ancestor.realPath, packagePath);
  return resolve(ancestor.realPath, relative(ancestor.path, target));
}

async function resolveMissingTarget(
  realRoot: string,
  candidate: string,
  packagePath: string,
  remainingLinks: number
): Promise<string> {
  try {
    const target = await realpath(candidate);
    assertContained(realRoot, target, packagePath);
    return target;
  } catch (error) {
    if (!isNodeFileNotFoundError(error)) {
      throw error;
    }
  }

  const missing: string[] = [];
  for (let current = candidate; ; current = dirname(current)) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        if (remainingLinks === 0) {
          throw new Error(`Package path '${packagePath}' contains too many symbolic links.`);
        }
        const link = await readlink(current);
        const parent = await realpath(dirname(current));
        assertContained(realRoot, parent, packagePath);
        const target = await resolvePackageLinkTarget(realRoot, parent, link, packagePath);
        return resolveMissingTarget(
          realRoot,
          resolve(target, ...missing),
          packagePath,
          remainingLinks - 1
        );
      }
      const target = resolve(await realpath(current), ...missing);
      assertContained(realRoot, target, packagePath);
      return target;
    } catch (error) {
      if (!isNodeFileNotFoundError(error) || dirname(current) === current) throw error;
    }
    missing.unshift(basename(current));
  }
}

export function createPackagePathTargetResolver(
  packageDir: string,
  realRoot: string
): (packagePath: string) => Promise<string> {
  return (packagePath) => {
    const candidate = packagePathCandidate(packageDir, packagePath);
    return resolveMissingTarget(realRoot, candidate, packagePath, 40);
  };
}

export async function packagePathLinkLocations(
  realRoot: string,
  packagePath: string
): Promise<string[]> {
  const links: string[] = [];
  const candidate = packagePathCandidate(realRoot, packagePath);
  let segments = relative(realRoot, candidate).split(sep);
  let current = realRoot;
  while (segments.length > 0 && links.length < 40) {
    current = join(current, segments[0]);
    segments = segments.slice(1);
    try {
      if (!(await lstat(current)).isSymbolicLink()) continue;
      links.push(current);
      const next = await resolvePackageLinkTarget(
        realRoot,
        dirname(current),
        await readlink(current),
        packagePath
      );
      const nextSegments = relative(realRoot, next);
      if (nextSegments.startsWith("..") || isAbsolute(nextSegments)) break;
      segments = [...nextSegments.split(sep), ...segments];
      current = realRoot;
    } catch (error) {
      if (!isNodeFileNotFoundError(error) && !(error instanceof PackagePathError)) throw error;
      break;
    }
  }
  return links;
}
