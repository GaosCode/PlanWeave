import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

export async function snapshotDirectory(resultsDir: string) {
  const entries = (await readdir(resultsDir, { recursive: true })).sort();
  return Promise.all(
    entries.map(async (entry) => {
      const path = join(resultsDir, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) return [entry, "link", await readlink(path)];
      if (info.isDirectory()) return [entry, "directory"];
      return [
        entry,
        "file",
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      ];
    })
  );
}
