import { cp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareIsolatedWorkspaceBuild(root: string) {
  const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
  const sources = [
    "scripts/run-workspace-consumer-build.ts",
    "packages/runtime/src/fs/advisoryDirectoryLock.ts",
    "packages/runtime/src/fs/advisoryLockLease.ts",
    "packages/runtime/src/fs/advisoryLockOwner.ts",
    "packages/runtime/src/fs/optionalFile.ts",
    "packages/runtime/src/process/lockWriterGroup.ts",
    "packages/runtime/src/process/managedProcessTree.ts",
    "packages/runtime/src/process/windowsManagedProcess.ts",
    "packages/runtime/src/process/windowsJobProcess.ps1"
  ];
  for (const source of sources) {
    const target = join(root, source);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repositoryRoot, source), target);
  }
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await symlink(
    join(repositoryRoot, "packages/runtime/node_modules"),
    join(root, "packages/runtime/node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module", packageManager: "pnpm@10.32.1" })
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/cli\n  - packages/desktop\n"
  );
  const target = fileURLToPath(new URL("./advisoryBuildTarget.mjs", import.meta.url));
  for (const [name, script] of [
    ["cli", "build:workspace"],
    ["desktop", "build:standalone"]
  ]) {
    const directory = join(root, "packages", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `isolated-${name}`,
        private: true,
        scripts: { [script]: `node ${JSON.stringify(target)}` }
      })
    );
  }
  return { wrapper: join(root, "scripts/run-workspace-consumer-build.ts"), repositoryRoot };
}

export async function readIsolatedBuildGroup(root: string): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const lock = join(root, ".planweave-workspace-consumer-build.lock");
    const owner = (await readdir(lock))[0];
    const descriptor: unknown = JSON.parse(
      await readFile(join(lock, owner, "external-writers-pending", "group-ready.json"), "utf8")
    );
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      !("kind" in descriptor) ||
      descriptor.kind !== "posix" ||
      !("pgid" in descriptor) ||
      typeof descriptor.pgid !== "number" ||
      !Number.isSafeInteger(descriptor.pgid) ||
      descriptor.pgid < 2
    )
      throw new Error("Invalid isolated build group");
    return descriptor.pgid;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
