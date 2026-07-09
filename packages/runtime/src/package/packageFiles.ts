import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const packageFileEntrySchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8")
  })
  .strict();

export type PackageFileEntry = z.infer<typeof packageFileEntrySchema>;

export function toArchivePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid package file path '${value}'.`);
  }
  return normalized;
}

export function safePackageFilePath(root: string, archivePath: string): string {
  const target = resolve(root, archivePath.split("/").join(sep));
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Package file path '${archivePath}' resolves outside the package directory.`);
  }
  return target;
}

async function visitPackageFile(
  root: string,
  dir: string,
  files: PackageFileEntry[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await visitPackageFile(root, path, files);
    } else if (entry.isFile()) {
      files.push({
        path: toArchivePath(relative(root, path)),
        content: await readFile(path, "utf8"),
        encoding: "utf8"
      });
    }
  }
}

export async function readPackageFiles(root: string): Promise<PackageFileEntry[]> {
  const files: PackageFileEntry[] = [];
  await visitPackageFile(root, root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function replacePackageFiles(root: string, files: PackageFileEntry[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    if (file.encoding !== "utf8") {
      throw new Error(`Unsupported file encoding '${file.encoding}' for '${file.path}'.`);
    }
    const path = safePackageFilePath(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
}

/**
 * Read every file under a package workspace directory into archive entries.
 * Runtime state (`state.json`, `results/`) lives outside the package and is never included.
 */
export async function exportCanvasPackageFiles(workspace: {
  packageDir: string;
}): Promise<PackageFileEntry[]> {
  return readPackageFiles(workspace.packageDir);
}
