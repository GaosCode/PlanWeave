import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observeActor } from "./support/advisoryProcessHarness.js";

async function file(path: string) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        Date.now() > deadline
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
it.skipIf(process.platform === "win32")(
  "bounds writer drainage from root exit even while a real descendant inherits both output pipes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-lock-pipe-"));
    const launch = (mode: string) =>
      observeActor(
        spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("./support/advisoryCleanupActor.mjs", import.meta.url)),
            JSON.stringify({
              root,
              mode,
              moduleUrl: new URL("../fs/advisoryDirectoryLock.ts", import.meta.url).href
            })
          ],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] }
        )
      );
    const actor = launch("pipe");
    let stdout = "";
    actor.child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = once(actor.child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const writerPid = Number(await file(join(root, "writer-ready")));
      const result = await Promise.race([
        exited.then(([code]) => ({ code })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 32500);
        })
      ]);
      expect(result, "owner must settle and exit before the inherited pipes close").toEqual({
        code: 1
      });
      expect(stdout).toContain("PIPE_STDOUT_BEFORE_EXIT");
      expect((await actor.done).stderr).toContain("PIPE_STDERR_BEFORE_EXIT");
      expect(actor.events.find((event) => event.event === "failed")?.message).toContain(
        "WRITER_GROUP_UNDRAINED"
      );
      expect(() => process.kill(writerPid, 0)).not.toThrow();
      const lease = (await readdir(join(root, "lock")))[0];
      const store = join(root, "lock", lease, "writer-work/pnpm-store");
      expect(await readFile(join(store, "pipe-live"), "utf8")).toBe("owned");
      await writeFile(join(root, "release"), "");
      await file(join(root, "writer-terminal"));
      expect(await readFile(join(store, "last-byte"), "utf8")).toBe("writer completed");
      const retry = launch("retry");
      await retry.wait("entered");
      expect((await retry.done).code).toBe(0);
    } finally {
      clearTimeout(timer);
      await writeFile(join(root, "release"), "");
      await actor.done;
      await rm(root, { recursive: true, force: true });
    }
  },
  40000
);
