import { createHash } from "node:crypto";
import { join } from "node:path";
import { optionalReadFile, optionalStat } from "../fs/optionalFile.js";

/** Fence directory replacement and changes to a session's eligibility snapshot. */
export async function pruneArtifactIdentity(
  path: string,
  session: boolean
): Promise<string | null> {
  const stat = await optionalStat(path);
  if (!stat) return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        device: stat.dev,
        inode: stat.ino,
        createdAt: stat.birthtimeMs,
        summary: session ? await optionalReadFile(join(path, "session.json"), "utf8") : null
      })
    )
    .digest("hex");
}
