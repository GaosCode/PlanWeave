import { chmodSync, lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

export function createPrivateOutputTarget() {
  const directory = mkdtempSync(join(tmpdir(), "planweave-acp-gate-output-"));
  chmodSync(directory, 0o700);
  return { directory, filePath: join(directory, "result.json") };
}

export function writePrivateResult(target, serialized) {
  const temporaryRoot = realpathSync(tmpdir());
  const directoryStat = lstatSync(target.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Private output directory is no longer a real directory.");
  }
  const realDirectory = realpathSync(target.directory);
  const fromTemporaryRoot = relative(temporaryRoot, realDirectory);
  if (
    fromTemporaryRoot.startsWith("..") ||
    realpathSync(dirname(target.filePath)) !== realDirectory
  ) {
    throw new Error("Private output target escaped the system temporary directory.");
  }
  if (basename(target.filePath) !== "result.json") {
    throw new Error("Private output filename is not tool-generated.");
  }
  try {
    lstatSync(target.filePath);
    throw new Error("Private output file already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  writeFileSync(target.filePath, serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}
