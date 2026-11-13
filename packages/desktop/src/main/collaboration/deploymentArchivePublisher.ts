import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, open, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { WindowsPrivateStorageSecurity } from "@planweave-ai/agent-host";
import { deploymentArchiveFailureCodes as failureCodes } from "../../shared/deploymentArchiveFailureCodes.js";

const runFile = promisify(execFile);
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function archiveError(code: string, options?: ErrorOptions) {
  return Object.assign(new Error(code, options), { code });
}

async function assertFileDestination(destination: string): Promise<void> {
  if (process.platform === "win32" && basename(destination).includes(":")) {
    throw archiveError(failureCodes.destinationNotFile);
  }
  const entry = await lstat(destination).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (entry && !entry.isFile()) throw archiveError(failureCodes.destinationNotFile);
}

export async function publishDeploymentArchive(
  destination: string,
  archive: Uint8Array
): Promise<void> {
  await assertFileDestination(destination);
  const staging = await mkdtemp(join(dirname(destination), ".planweave-deployment-"));
  const temporaryPath = join(staging, "bundle.tmp");
  const windowsSecurity = process.platform === "win32" ? new WindowsPrivateStorageSecurity() : null;
  let ownsTemporaryFile = false;

  try {
    try {
      if (windowsSecurity) {
        await windowsSecurity.prepareDirectory(staging);
      } else {
        if (process.platform === "darwin") await runFile("/bin/chmod", ["-N", resolve(staging)]);
        await chmod(staging, privateDirectoryMode);
        if (((await stat(staging)).mode & 0o777) !== privateDirectoryMode) {
          throw new Error("deployment_archive_directory_mode_mismatch");
        }
      }
    } catch (cause) {
      throw archiveError(failureCodes.permissionsUnavailable, { cause });
    }

    {
      await using handle = await open(temporaryPath, "wx", privateFileMode);
      ownsTemporaryFile = true;
      try {
        if (windowsSecurity) {
          await windowsSecurity.secureFile(temporaryPath);
        } else {
          await handle.chmod(privateFileMode);
          if (((await handle.stat()).mode & 0o777) !== privateFileMode) {
            throw new Error("deployment_archive_file_mode_mismatch");
          }
        }
      } catch (cause) {
        throw archiveError(failureCodes.permissionsUnavailable, { cause });
      }
      await handle.writeFile(archive);
      await handle.sync();
    }

    await assertFileDestination(destination);
    await rename(temporaryPath, destination);
  } catch (error) {
    try {
      if (ownsTemporaryFile) await unlink(temporaryPath);
      await rmdir(staging);
    } catch (cleanupError) {
      throw Object.assign(
        new AggregateError([error, cleanupError], failureCodes.cleanupFailed, {
          cause: cleanupError
        }),
        { code: failureCodes.cleanupFailed }
      );
    }
    throw error;
  }

  try {
    await rmdir(staging);
  } catch (cause) {
    throw archiveError(failureCodes.committedCleanupFailed, { cause });
  }
}
