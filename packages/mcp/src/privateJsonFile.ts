import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let tempFileCounter = 0;

export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await ensurePrivateDirectory(dir);
  const tempPath = join(
    dir,
    `.${basename(path)}-${process.pid}-${Date.now()}-${tempFileCounter++}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tempPath, path);
  const written = await stat(path);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(path, 0o600);
  }
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  });
}
