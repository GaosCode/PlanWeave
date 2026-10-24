import { join } from "node:path";
import { z } from "zod";
import type { AdvisoryLockFs } from "../fs/advisoryLockOwner.js";
import { isErrno } from "../fs/advisoryLockOwner.js";
import { createPosixProcessTreeAdapter, spawnManagedProcess } from "./managedProcessTree.js";
import { createWindowsBuildJobOwnership, probeWindowsBuildJob } from "./windowsManagedProcess.js";

const descriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("posix"),
      pgid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("windows"),
      name: z
        .string()
        .regex(
          /^Global\\PlanWeaveBuild-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        )
    })
    .strict()
]);
const pendingName = "external-writers-pending";
const readyName = "group-ready.json";

/** null ready is never interpreted as an empty group: the launcher may still be starting. */
export async function inspectWriterGroup(ownerPath: string, fs: AdvisoryLockFs): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(ownerPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (entries.some((entry) => !["holder.json", pendingName, "writer-work"].includes(entry))) {
    throw new Error(`WRITER_GROUP_INVALID at ${ownerPath}: unknown lease entry`);
  }
  if (!entries.includes(pendingName)) {
    if (entries.includes("writer-work"))
      throw new Error(`WRITER_GROUP_UNREGISTERED at ${ownerPath}`);
    return false;
  }
  const pendingPath = join(ownerPath, pendingName);
  const metadata = await fs.lstat(pendingPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`WRITER_GROUP_INVALID at ${pendingPath}`);
  const readyPath = join(pendingPath, readyName);
  let descriptor: z.infer<typeof descriptorSchema>;
  try {
    const ready = await fs.lstat(readyPath);
    if (!ready.isFile() || ready.isSymbolicLink()) throw new Error("ready must be a regular file");
    descriptor = descriptorSchema.parse(JSON.parse(await fs.readFile(readyPath, "utf8")));
  } catch (error) {
    throw new Error(`WRITER_GROUP_UNREGISTERED at ${pendingPath}: ${String(error)}`, {
      cause: error
    });
  }
  if (descriptor.kind === "windows") {
    if (process.platform !== "win32")
      throw new Error(`WRITER_GROUP_INVALID: Windows Job on ${process.platform}`);
    return probeWindowsBuildJob(descriptor.name);
  }
  if (process.platform === "win32") throw new Error("WRITER_GROUP_INVALID: POSIX group on Windows");
  return createPosixProcessTreeAdapter().isTreeAlive(descriptor.pgid);
}

export type LockManagedCommand = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type AdvisoryLockScope = { runManagedCommand(command: LockManagedCommand): Promise<void> };

// This trusted bootstrap starts in its own session before JavaScript executes. It publishes
// immutable group ownership before any writer starts; all spawned tools inherit this group.
const posixBootstrap = `
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
(async () => {
  const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
  if (!Number.isSafeInteger(process.pid) || process.pid <= 1) throw new Error('Invalid writer pgid');
  await fs.writeFile(request.readyPath + '.tmp', JSON.stringify({version:1,kind:'posix',pgid:process.pid}), {flag:'wx'});
  await fs.rename(request.readyPath + '.tmp', request.readyPath);
  const child = spawn(request.command, request.args, {stdio:'inherit',shell:false});
  child.once('error', error => { console.error(error); process.exitCode=1; });
  child.once('close', (code,signal) => { process.exitCode=code===0?0:1; if(signal)console.error('Build terminated: '+signal); });
})().catch(error => { console.error(error); process.exitCode=1; });
`;

export function createLockWriterScope(
  ownerPath: string,
  fs: AdvisoryLockFs
): { scope: AdvisoryLockScope; drain(): Promise<{ commandError: unknown } | null> } {
  let command: Promise<void> | undefined;
  let active = true;
  async function run(request: LockManagedCommand): Promise<void> {
    const pendingPath = join(ownerPath, pendingName);
    await fs.mkdir(pendingPath);
    const workPath = join(ownerPath, "writer-work");
    await fs.mkdir(workPath);
    const storePath = join(workPath, "pnpm-store");
    await fs.mkdir(storePath);
    const readyPath = join(pendingPath, readyName);
    const env = { ...process.env, ...request.env, PLANWEAVE_BUILD_STORE_DIR: storePath };
    const managed =
      process.platform === "win32"
        ? spawnManagedProcess({
            ...request,
            env,
            windowsBuildJob: createWindowsBuildJobOwnership(readyPath)
          })
        : spawnManagedProcess({
            command: process.execPath,
            args: [
              "-e",
              posixBootstrap,
              Buffer.from(
                JSON.stringify({ command: request.command, args: request.args, readyPath })
              ).toString("base64")
            ],
            cwd: request.cwd,
            env
          });
    const closed = new Promise<void>((resolve, reject) => {
      managed.child.once("error", reject);
      managed.child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Managed lock command failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`
            )
          );
      });
    });
    managed.child.stdout.pipe(process.stdout, { end: false });
    managed.child.stderr.pipe(process.stderr, { end: false });
    managed.child.stdin.end();
    let result: { ok: true } | { ok: false; error: unknown };
    try {
      await closed;
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error };
    }
    try {
      if (!(await managed.tree.awaitTreeExit(30_000)))
        throw new Error(`WRITER_GROUP_UNDRAINED at ${ownerPath}`);
      if (await inspectWriterGroup(ownerPath, fs))
        throw new Error(`WRITER_GROUP_UNDRAINED at ${ownerPath}`);
    } catch (error) {
      if (!result.ok)
        throw new AggregateError([result.error, error], "Managed command and writer drain failed");
      throw error;
    }
    if (!result.ok) throw result.error;
  }
  return {
    scope: {
      runManagedCommand(request) {
        if (!active || command)
          return Promise.reject(
            new Error("A lock lease permits one managed command before release")
          );
        command = run(request);
        // drain also owns this promise when a caller neglects to await its writer.
        void command.catch(() => undefined);
        return command;
      }
    },
    async drain() {
      active = false;
      let failure: { commandError: unknown } | null = null;
      if (command) {
        try {
          await command;
        } catch (error) {
          failure = { commandError: error };
        }
      }
      if (await inspectWriterGroup(ownerPath, fs))
        throw new Error(`WRITER_GROUP_UNDRAINED at ${ownerPath}`);
      return failure;
    }
  };
}
