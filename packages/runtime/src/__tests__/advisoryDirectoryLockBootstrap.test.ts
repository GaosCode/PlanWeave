import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { defaultLockFs } from "../fs/advisoryLockOwner.js";
import * as managedProcess from "../process/managedProcessTree.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "planweave-bootstrap-"));
  roots.push(root);
  return { root, lockPath: join(root, "lock"), operation: "bootstrap" };
}
const request = { command: process.execPath, args: ["-e", "process.exit(0)"] };

it("preserves the real no-spawn ENOENT and releases its lease after a caught failure", async () => {
  const f = await fixture();
  let startupError: unknown;
  const result = withAdvisoryDirectoryLock(f, async (scope) => {
    try {
      await scope.runManagedCommand({ ...request, cwd: join(f.root, "missing") });
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toMatchObject({
      code: "ENOENT",
      syscall: expect.stringContaining("spawn")
    });
    const owner = (await fs.readdir(f.lockPath))[0];
    expect(await fs.readdir(join(f.lockPath, owner))).toEqual(["holder.json"]);
    await expect(scope.runManagedCommand(request)).rejects.toThrow("one managed command");
  });
  const failure = await result.catch((error: unknown) => error);
  expect(startupError).toMatchObject({ code: "ENOENT" });
  expect(failure).toBe(startupError);
  expect(await fs.readdir(f.root)).toEqual([]);
  await expect(withAdvisoryDirectoryLock(f, async () => "retry")).resolves.toBe("retry");
});

it("releases registration after a synchronous managed startup preflight rejection", async () => {
  const f = await fixture();
  const error = new Error("managed command resolution failed before spawn");
  vi.spyOn(managedProcess, "spawnManagedProcess").mockImplementationOnce(() => {
    throw error;
  });
  await expect(
    withAdvisoryDirectoryLock(f, (scope) => scope.runManagedCommand(request))
  ).rejects.toBe(error);
  expect(await fs.readdir(f.root)).toEqual([]);
});

it("keeps uncertain registration when native spawn throws without returning a child", async () => {
  const f = await fixture();
  await expect(
    withAdvisoryDirectoryLock(f, (scope) =>
      scope.runManagedCommand({ ...request, cwd: "invalid\0cwd" })
    )
  ).rejects.toMatchObject({
    errors: [expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }), expect.anything()]
  });
  const owner = (await fs.readdir(f.lockPath))[0];
  expect((await fs.readdir(join(f.lockPath, owner))).sort()).toEqual([
    "external-writers-pending",
    "holder.json",
    "writer-work"
  ]);
});

it.each([
  "external-writers-pending",
  "writer-work",
  "pnpm-store"
])("rolls back only successfully created registration directories after mkdir %s fails", async (stage) => {
  const f = await fixture();
  const error = Object.assign(new Error(`mkdir ${stage} EIO`), { code: "EIO" });
  await expect(
    withAdvisoryDirectoryLock(
      {
        ...f,
        fs: {
          ...defaultLockFs,
          async mkdir(path) {
            if (basename(path) === stage) throw error;
            await defaultLockFs.mkdir(path);
          }
        }
      },
      (scope) => scope.runManagedCommand(request)
    )
  ).rejects.toBe(error);
  expect(await fs.readdir(f.root)).toEqual([]);
});

it("preserves the startup and rollback diagnostics when owned registration cleanup fails", async () => {
  const f = await fixture();
  const startup = new Error("store mkdir EIO");
  const cleanup = new Error("work rmdir EIO");
  let original: unknown;
  await expect(
    withAdvisoryDirectoryLock(
      {
        ...f,
        fs: {
          ...defaultLockFs,
          async mkdir(path) {
            if (basename(path) === "pnpm-store") throw startup;
            await defaultLockFs.mkdir(path);
          },
          async rmdir(path) {
            if (basename(path) === "writer-work") throw cleanup;
            await defaultLockFs.rmdir(path);
          }
        }
      },
      async (scope) => {
        try {
          await scope.runManagedCommand(request);
        } catch (error) {
          original = error;
          throw error;
        }
      }
    )
  ).rejects.toMatchObject({ errors: [expect.anything(), expect.anything()] });
  expect(original).toMatchObject({ errors: [startup, cleanup] });
  expect(await fs.readdir(f.lockPath)).toHaveLength(1);
});

it.skipIf(process.platform === "win32")(
  "retains registration when the bootstrap started but failed before publishing ready",
  async () => {
    const f = await fixture();
    await expect(
      withAdvisoryDirectoryLock(f, (scope) =>
        scope.runManagedCommand({
          ...request,
          env: { NODE_OPTIONS: `--require=${join(f.root, "missing.cjs")}` }
        })
      )
    ).rejects.toThrow("writer drain failed");
    const owner = (await fs.readdir(f.lockPath))[0];
    expect((await fs.readdir(join(f.lockPath, owner))).sort()).toEqual([
      "external-writers-pending",
      "holder.json",
      "writer-work"
    ]);
    await expect(
      withAdvisoryDirectoryLock({ ...f, isPidAlive: () => false }, async () => "entered")
    ).rejects.toThrow("WRITER_GROUP_UNREGISTERED");
  }
);
