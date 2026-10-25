import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observeActor } from "./support/advisoryProcessHarness.js";

it.each([
  "pending-lstat",
  "ready-read"
])("retries %s after another process reclaims an exited managed writer without changing its successor", async (stage) => {
  const root = await mkdtemp(join(tmpdir(), "planweave-writer-reclaim-"));
  const lockPath = join(root, "lock");
  const actors: ReturnType<typeof observeActor>[] = [];
  function launch(actor: string, oldName?: string) {
    const observed = observeActor(
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./support/advisoryWriterReclaimActor.mjs", import.meta.url)),
          JSON.stringify({
            actor,
            root,
            lockPath,
            stage,
            oldName,
            moduleUrl: new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href,
            ownerModuleUrl: new URL("../fs/advisoryLockOwner.ts", import.meta.url).href
          })
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] }
      )
    );
    actors.push(observed);
    return observed;
  }
  try {
    const owner = launch("owner");
    await owner.wait("writer-drained");
    const oldName = (await readdir(lockPath))[0];
    expect(
      JSON.parse(
        await readFile(
          join(lockPath, oldName, "external-writers-pending", "group-ready.json"),
          "utf8"
        )
      )
    ).toMatchObject({ version: 1 });
    owner.send("abandon");
    expect((await owner.done).code).toBe(0);
    const a = launch("A", oldName);
    await a.wait("before-observation");
    const b = launch("B");
    await b.wait("entered");
    const successor = (await readdir(lockPath))[0];
    expect(successor).not.toBe(oldName);
    const bytes = await readFile(join(lockPath, successor, "holder.json"), "utf8");
    a.send("resume");
    await a.wait("blocked-on-successor");
    expect(await readdir(lockPath)).toEqual([successor]);
    expect(await readFile(join(lockPath, successor, "holder.json"), "utf8")).toBe(bytes);
    expect(a.events.some((event) => event.event === "entered")).toBe(false);
    a.send("check-complete");
    b.send("release");
    expect((await b.done).code).toBe(0);
    await a.wait("entered");
    a.send("release");
    expect((await a.done).code).toBe(0);
    expect(await readdir(root)).toEqual([]);
    console.info(
      "WRITER_RECLAIM_PROCESS",
      JSON.stringify({ stage, pids: actors.map((item) => item.child.pid), successor })
    );
  } finally {
    await Promise.all(actors.map((actor) => actor.stop()));
    await rm(root, { recursive: true, force: true });
  }
});
