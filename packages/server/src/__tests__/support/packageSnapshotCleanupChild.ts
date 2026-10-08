import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../../canvas/localFilesystemRuntimeAdapter.js";
import { PackageSnapshotRepository } from "../../packageSnapshotRepository.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { openServerDatabase } from "../../sqlite.js";
import { recoveryAt, recoveryScope } from "./packageSnapshotRecoveryFixture.js";

const input = z
  .object({
    file: z.string(),
    data: z.string(),
    canvas: z.string(),
    id: z.string(),
    mode: z.enum(["cleanup", "hold-cleanup", "hold-restore"]),
    location: z.object({
      workspaceId: z.string(),
      projectId: z.string(),
      canvasId: z.string(),
      projectRoot: z.string(),
      packageDir: z.string()
    })
  })
  .parse(JSON.parse(process.argv[2]!));
let release!: () => void;
const released = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message: unknown) => {
  if (z.object({ command: z.literal("release") }).safeParse(message).success) release();
});
const send = (event: string, result?: unknown) => process.send?.({ event, result });
const database = await openServerDatabase(input.file, 5_000);
try {
  if (input.mode === "hold-cleanup") {
    const remove = fs.rm;
    let first = true;
    fs.rm = async (path, options) => {
      if (first && String(path).endsWith(input.id)) {
        first = false;
        send("held");
        await released;
      }
      await remove(path, options);
    };
    syncBuiltinESMExports();
  }
  const runtime = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation: () => input.location
  });
  const snapshots = new PackageSnapshotRepository(
    database,
    new ProjectAccessRepository(database, () => new Date(recoveryAt)),
    input.data,
    {
      ...runtime,
      async restoreSnapshot(value) {
        send("held");
        await released;
        await runtime.restoreSnapshot(value);
      }
    },
    () => new Date(recoveryAt)
  );
  if (input.mode === "hold-restore")
    send("done", await snapshots.restore({ ...recoveryScope, snapshotId: input.id }));
  else {
    await snapshots.recoverBackingCleanup();
    send("done");
  }
} catch (error) {
  process.send?.({ event: "error", message: error instanceof Error ? error.stack : String(error) });
} finally {
  database.close();
  process.disconnect();
}
