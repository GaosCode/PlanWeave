import { readFile } from "node:fs/promises";
import {
  WorkspaceAuthoritativeSnapshotCache,
  workspaceAuthoritativeSnapshotCacheEntrySchema
} from "../../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";

const [directory, entryPath, mode] = process.argv.slice(2);
if (!directory || !entryPath) throw new Error("snapshot writer requires directory and entry path");
const entry = workspaceAuthoritativeSnapshotCacheEntrySchema.parse(
  JSON.parse(await readFile(entryPath, "utf8"))
);
const cache = new WorkspaceAuthoritativeSnapshotCache(directory);
const get = cache.get.bind(cache);
cache.get = async (key) => {
  const current = await get(key);
  if (mode === "hold") {
    const resumed = new Promise<void>((resolve) => process.once("message", () => resolve()));
    process.send?.({ type: "read" });
    await resumed;
  }
  return current;
};
process.send?.({ type: "started" });
try {
  await cache.put(entry);
  process.send?.({ type: "result", status: "written" });
} catch (error) {
  process.send?.({
    type: "result",
    status: "failed",
    message: error instanceof Error ? error.message : String(error)
  });
}
process.disconnect?.();
