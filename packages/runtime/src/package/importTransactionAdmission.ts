import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { optionalReaddir } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";

export type ImportAdmissionMode = "shared" | "exclusive";
const heldAdmissions = new AsyncLocalStorage<ReadonlyMap<string, ImportAdmissionMode>>();
const readerSchema = z.object({ pid: z.number().int().positive() }).strict();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForReaders(root: string): Promise<void> {
  const started = performance.now();
  for (;;) {
    const readers = await optionalReaddir(root, { withFileTypes: true });
    let occupied = false;
    for (const entry of readers ?? []) {
      if (!entry.name.endsWith(".json")) continue;
      const path = join(root, entry.name);
      // A reader may finish while the writer owns the admission gate.
      let reader: z.infer<typeof readerSchema>;
      try {
        reader = readerSchema.parse(await readJsonFile<unknown>(path));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (alive(reader.pid)) occupied = true;
      else await rm(path, { force: true });
    }
    if (!occupied) return;
    if (performance.now() - started >= 10_000) {
      throw new Error(`Import transaction admission timed out waiting for readers at '${root}'.`);
    }
    await delay(25);
  }
}

/** Sorted acquisition prevents lifecycle journals from introducing admission inversions. */
export async function withImportAdmissions<T>(
  requests: readonly { path: string; mode: ImportAdmissionMode }[],
  action: () => Promise<T>
): Promise<T> {
  const held = heldAdmissions.getStore() ?? new Map<string, ImportAdmissionMode>();
  const modes = new Map<string, ImportAdmissionMode>();
  for (const { path, mode } of requests) {
    if (modes.get(path) !== "exclusive") modes.set(path, mode);
  }
  const sorted = [...modes.entries()].sort(([left], [right]) => left.localeCompare(right));
  const greatest = [...held.keys()].sort().at(-1);
  if (greatest && sorted.some(([path]) => !held.has(path) && path < greatest)) {
    throw new Error(
      "Import transaction admission lock order violation: acquire all scan roots together."
    );
  }
  for (const [path, mode] of sorted) {
    if (held.get(path) === "shared" && mode === "exclusive") {
      throw new Error("Import transaction admission cannot upgrade a held shared root.");
    }
  }
  async function acquire(index: number): Promise<T> {
    const request = sorted[index];
    if (!request) return action();
    const [path, mode] = request;
    if (held.has(path)) return acquire(index + 1);
    const readers = `${path}.readers`;
    const next = new Map(heldAdmissions.getStore() ?? held);
    next.set(path, mode);
    if (mode === "exclusive") {
      return withAdvisoryDirectoryLock(
        { lockPath: path, operation: "import-transaction-workspace" },
        async () => {
          await waitForReaders(readers);
          return heldAdmissions.run(next, () => acquire(index + 1));
        }
      );
    }
    const receipt = join(readers, `${randomUUID()}.json`);
    try {
      await withAdvisoryDirectoryLock(
        { lockPath: path, operation: "import-transaction-scan" },
        async () => {
          await mkdir(readers, { recursive: true, mode: 0o700 });
          await writeJsonFile(receipt, { pid: process.pid });
        }
      );
      return await heldAdmissions.run(next, () => acquire(index + 1));
    } finally {
      // Release without the gate so an exclusive waiter can drain existing readers.
      await rm(receipt, { force: true });
    }
  }
  return acquire(0);
}
