import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/** Filesystem identity as well as bytes distinguishes later identical writes and ABA edits. */
export async function importTransactionIdentityDigest(target: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relativePath: string): Promise<void> {
    const stat = await lstat(path, { bigint: true });
    hash.update(
      JSON.stringify([
        relativePath,
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.ctimeNs),
        String(stat.mtimeNs)
      ])
    );
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), `${relativePath}/${name}`);
      }
    } else if (stat.isFile()) {
      hash.update(await readFile(path));
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(await readlink(path)));
    } else {
      throw new Error(`Unsupported import transaction target type at '${path}'.`);
    }
  }
  await visit(target, "");
  return hash.digest("hex");
}
