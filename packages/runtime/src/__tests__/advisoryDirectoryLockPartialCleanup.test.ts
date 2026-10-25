import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observeActor } from "./support/advisoryProcessHarness.js";

it.skipIf(process.platform === "win32")(
  "recovers after real partial cleanup fails and the owner and writer have exited",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-partial-release-"));
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
          { stdio: ["ignore", "ignore", "pipe", "ipc"] }
        )
      );
    let readonly = "";
    try {
      const owner = launch("readonly");
      const failure = await owner.wait("failed");
      expect(failure.message).toContain("EACCES");
      expect((await owner.done).code).toBe(1);
      const lock = join(root, "lock");
      const name = (await readdir(lock))[0];
      readonly = join(lock, name, "writer-work/pnpm-store/readonly");
      expect(await readFile(join(readonly, "file"), "utf8")).toBe("owned");
      await expect(access(join(lock, name, "writer-work/disposable"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      const stillFaulted = launch("retry-before-repair");
      expect((await stillFaulted.wait("failed")).message).toContain("EACCES");
      expect((await stillFaulted.done).code).toBe(1);
      await chmod(readonly, 0o700);
      const retry = launch("retry-after-repair");
      await retry.wait("entered");
      expect((await retry.done).code).toBe(0);
      await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (readonly)
        await chmod(readonly, 0o700).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      await rm(root, { recursive: true, force: true });
    }
  }
);
