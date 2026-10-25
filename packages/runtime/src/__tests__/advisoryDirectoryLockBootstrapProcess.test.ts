import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observeActor } from "./support/advisoryProcessHarness.js";

it("allows the next process to enter immediately after an unstarted writer owner exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-bootstrap-process-"));
  const actors: ReturnType<typeof observeActor>[] = [];
  function launch(actor: string) {
    const client = observeActor(
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./support/advisoryBootstrapActor.mjs", import.meta.url)),
          new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href,
          JSON.stringify({ actor, lockPath: join(root, "lock"), missing: join(root, "missing") })
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] }
      )
    );
    actors.push(client);
    return client;
  }
  try {
    const first = launch("first");
    await first.wait("entered");
    const failure = await first.wait("failed");
    expect((await first.done).code).toBe(0);
    const second = launch("second");
    await second.wait("entered");
    await second.wait("success");
    expect((await second.done).code).toBe(0);
    expect(failure.code).toBe("ENOENT");
    expect(first.child.pid).not.toBe(second.child.pid);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await Promise.all(actors.map((actor) => actor.stop()));
    await rm(root, { recursive: true, force: true });
  }
});
