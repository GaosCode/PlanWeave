import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";

export const trustedCommandsSchema = z
  .object({
    version: z.literal("hook-trust/v1"),
    entries: z.array(
      z
        .object({
          id: z.string().min(1),
          command: z.string().min(1),
          args: z.array(z.string()),
          approvedAt: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

export type TrustedCommandsFile = z.infer<typeof trustedCommandsSchema>;
export type TrustedCommand = TrustedCommandsFile["entries"][number];

const emptyTrustedCommands = (): TrustedCommandsFile => ({
  version: "hook-trust/v1",
  entries: []
});

export function commandFingerprint(command: string, args: string[]): string {
  return createHash("sha256").update(JSON.stringify([command, ...args])).digest("hex");
}

/**
 * Trust store is project-scoped under ~/.planweave/projects/<id>/policy/,
 * not under a canvas package root. Canvas workspaces may rewrite workspaceRoot
 * to canvases/<id>; always key off planweaveHome + project id.
 */
export function trustedCommandsPath(workspace: Pick<ProjectWorkspace, "planweaveHome" | "id">): string {
  return join(workspace.planweaveHome, "projects", workspace.id, "policy", "trusted-commands.json");
}

async function resolveTrustWorkspace(projectRoot: PackageWorkspaceRef): Promise<ProjectWorkspace> {
  return resolvePackageWorkspace(projectRoot);
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
}

async function writePrivateTrustedCommands(path: string, value: TrustedCommandsFile): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    const written = await stat(path);
    if ((written.mode & 0o777) !== 0o600) {
      await chmod(path, 0o600);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readTrustedCommandsFile(path: string): Promise<TrustedCommandsFile> {
  if ((await optionalStat(path)) === null) {
    return emptyTrustedCommands();
  }
  const raw = await readJsonFile<unknown>(path);
  return trustedCommandsSchema.parse(raw);
}

export async function listTrustedCommands(projectRoot: PackageWorkspaceRef): Promise<TrustedCommand[]> {
  const workspace = await resolveTrustWorkspace(projectRoot);
  const file = await readTrustedCommandsFile(trustedCommandsPath(workspace));
  return file.entries;
}

export async function isCommandTrusted(
  projectRoot: PackageWorkspaceRef,
  command: string,
  args: string[]
): Promise<boolean> {
  const fingerprint = commandFingerprint(command, args);
  const entries = await listTrustedCommands(projectRoot);
  return entries.some((entry) => entry.id === fingerprint);
}

export async function trustCommand(
  projectRoot: PackageWorkspaceRef,
  command: string,
  args: string[]
): Promise<TrustedCommand> {
  const workspace = await resolveTrustWorkspace(projectRoot);
  const path = trustedCommandsPath(workspace);
  const file = await readTrustedCommandsFile(path);
  const id = commandFingerprint(command, args);
  const existing = file.entries.find((entry) => entry.id === id);
  if (existing) {
    return existing;
  }
  const entry: TrustedCommand = {
    id,
    command,
    args: [...args],
    approvedAt: new Date().toISOString()
  };
  await writePrivateTrustedCommands(path, {
    version: "hook-trust/v1",
    entries: [...file.entries, entry]
  });
  return entry;
}

export function untrustedHookCommandError(command: string, reviewBlockRef: string): Error {
  return new Error(
    `Review hook command is not trusted on this machine: "${command}". Approve it with: planweave trust hook ${reviewBlockRef}`
  );
}

export function untrustedExecutorCommandError(command: string, executorName: string): Error {
  return new Error(
    `Executor command is not trusted on this machine: "${command}". Approve it with: planweave trust executor ${executorName}`
  );
}
