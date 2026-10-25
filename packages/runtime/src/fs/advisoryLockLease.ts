import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inspectWriterGroup } from "../process/lockWriterGroup.js";
import {
  type AdvisoryLockFs,
  inspectLockOwner,
  isErrno,
  type LockOwner,
  removeEmptyLockRoot,
  removeExactLockOwner
} from "./advisoryLockOwner.js";

export type AdvisoryLockClock = {
  nowMs(): number;
  performanceNow(): number;
  delay(ms: number): Promise<void>;
};
export type DirectoryLockLease = { lockPath: string; name: string; ownerPath: string };

function age(ms: number): string {
  return Number.isFinite(ms) ? `${Math.max(0, Math.round(ms))}ms` : "unknown";
}
function timeoutError(
  lockPath: string,
  operation: string,
  waited: number,
  owner: LockOwner | "empty" | null,
  now: number,
  pidAlive: (pid: number) => boolean,
  lastError: unknown,
  lockAge: number
): Error {
  const holder = owner && owner !== "empty" ? owner.holder : null;
  const details = holder
    ? `holder pid=${holder.pid}; holder operation=${holder.operation}; holder acquiredAt=${holder.acquiredAt}; holder age=${age(now - Date.parse(holder.acquiredAt))}; holder pidAlive=${pidAlive(holder.pid)}`
    : `holder unreadable (${owner && owner !== "empty" ? owner.detail : String(owner)})`;
  return new Error(
    `Timed out acquiring directory lock at ${lockPath}; after ${Math.round(waited)}ms; requested operation=${operation}; ${details}; lock age=${age(lockAge)}${lastError ? `; last filesystem error=${String(lastError)}` : ""}`
  );
}

export async function acquireDirectoryLockLease(options: {
  lockPath: string;
  operation: string;
  timeoutMs: number;
  retryDelayMs: number;
  pid: number;
  isPidAlive(pid: number): boolean;
  fs: AdvisoryLockFs;
  clock: AdvisoryLockClock;
}): Promise<DirectoryLockLease> {
  const { lockPath, operation, timeoutMs, retryDelayMs, pid, isPidAlive, fs, clock } = options;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid lock owner pid: ${pid}`);
  const token = randomUUID();
  const name = `lease-v2-${pid}-${token}`;
  const privatePath = `${lockPath}.prepare-${token}`;
  const lease = { lockPath, name, ownerPath: join(lockPath, name) };
  const started = clock.performanceNow();
  let prepared = false;
  let published = false;
  let uncertainPublish = false;
  let lastError: unknown;
  let owner: LockOwner | "empty" | null = null;
  try {
    await fs.mkdir(privatePath);
    prepared = true;
    await fs.mkdir(join(privatePath, name));
    await fs.writeFile(
      join(privatePath, name, "holder.json"),
      `${JSON.stringify({ version: 2, pid, acquiredAt: new Date(clock.nowMs()).toISOString(), operation, ownerToken: token }, null, 2)}\n`,
      "utf8"
    );
    while (clock.performanceNow() - started < timeoutMs) {
      try {
        uncertainPublish = true;
        await fs.rename(privatePath, lockPath);
        published = true;
        return lease;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY", "ENOTDIR"].some((code) => isErrno(error, code))
        )
          throw error;
        uncertainPublish = false;
        lastError = error;
      }
      owner = await inspectLockOwner(lockPath, fs);
      if (owner === null) continue;
      if (owner === "empty") {
        await removeEmptyLockRoot(lockPath, fs);
        continue;
      }
      if (owner.writersDrained || !isPidAlive(owner.pid)) {
        const ownerPath = join(lockPath, owner.name);
        let writersAlive: boolean;
        try {
          writersAlive = !owner.writersDrained && (await inspectWriterGroup(ownerPath, fs));
        } catch (error) {
          // A competing reclaimer may remove this UUID while its descriptor is being read.
          try {
            await fs.lstat(ownerPath);
          } catch (identityError) {
            if (isErrno(identityError, "ENOENT")) continue;
            throw new AggregateError(
              [error, identityError],
              `Failed to inspect writer group and recheck lock identity at ${ownerPath}`
            );
          }
          throw error;
        }
        if (!writersAlive) {
          await removeExactLockOwner(lockPath, owner.name, fs);
          continue;
        }
      }
      await clock.delay(retryDelayMs);
    }
    throw timeoutError(
      lockPath,
      operation,
      clock.performanceNow() - started,
      owner,
      clock.nowMs(),
      isPidAlive,
      lastError,
      await fs
        .optionalStat(lockPath)
        .then((stats) => (stats ? clock.nowMs() - stats.mtimeMs : Number.NaN))
    );
  } catch (error) {
    // Even a rename reporting an uncertain error can only have published our unique token.
    const failures = [error];
    if (prepared && !published) {
      try {
        await fs.rm(privatePath, { recursive: true, force: true });
        if (uncertainPublish) await removeExactLockOwner(lockPath, name, fs);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        `Failed to publish lock holder at ${lockPath}; cleanup of newly created lock also failed`
      );
    throw error;
  }
}
