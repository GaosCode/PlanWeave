import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { resolvePlanweaveHome } from "../paths.js";
import {
  acpProfileCatalogSchema,
  acpProfileCanonicalKey,
  acpProfileDescriptorSchema,
  emptyAcpProfileCatalog,
  type AcpProfileCatalog,
  type AcpProfileDescriptor
} from "./schema.js";

const MAX_LOCK_TIMEOUT_MS = 60_000;
const MAX_STALE_LOCK_MS = 86_400_000;
const MAX_LOCK_RETRY_DELAY_MS = 1_000;
const MAX_PROCESS_ID = 2_147_483_647;

export const acpProfileStoreLockValuesSchema = z
  .object({
    timeoutMs: z.number().finite().int().positive().max(MAX_LOCK_TIMEOUT_MS).default(10_000),
    staleMs: z.number().finite().int().positive().max(MAX_STALE_LOCK_MS).default(60_000),
    retryDelayMs: z.number().finite().int().positive().max(MAX_LOCK_RETRY_DELAY_MS).default(25),
    pid: z.number().finite().int().positive().max(MAX_PROCESS_ID).default(process.pid)
  })
  .strict()
  .superRefine((options, context) => {
    if (options.retryDelayMs > options.timeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["retryDelayMs"],
        message: "ACP profile lock retryDelayMs must not exceed timeoutMs."
      });
    }
  });
export type AcpProfileStoreLockValues = z.infer<typeof acpProfileStoreLockValuesSchema>;

export type AcpProfileStoreLockOptions = z.input<typeof acpProfileStoreLockValuesSchema> & {
  isPidAlive?: (pid: number) => boolean;
};

type ResolvedAcpProfileStoreLockOptions = AcpProfileStoreLockValues & {
  isPidAlive?: (pid: number) => boolean;
};

type AcpProfileLockHolder = {
  pid: number;
  createdAt: string;
  ownerToken: string;
};

export type AcpProfileStoreOptions = {
  catalogPath?: string;
  lock?: AcpProfileStoreLockOptions;
};

export class AcpProfileRevisionConflictError extends Error {
  readonly code = "acp_profile_revision_conflict";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `ACP profile catalog revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}.`
    );
    this.name = "AcpProfileRevisionConflictError";
  }
}

export class AcpProfileAlreadyExistsError extends Error {
  readonly code = "acp_profile_already_exists";

  constructor(readonly profileId: string) {
    super(`ACP profile '${profileId}' is already registered.`);
    this.name = "AcpProfileAlreadyExistsError";
  }
}

export class AcpProfileNotFoundError extends Error {
  readonly code = "acp_profile_not_found";

  constructor(readonly profileId: string) {
    super(`ACP profile '${profileId}' is not registered.`);
    this.name = "AcpProfileNotFoundError";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code
  );
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function readLockHolder(path: string): Promise<AcpProfileLockHolder | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const holder = value as Partial<AcpProfileLockHolder>;
    if (
      !Number.isInteger(holder.pid) ||
      typeof holder.createdAt !== "string" ||
      !Number.isFinite(Date.parse(holder.createdAt)) ||
      typeof holder.ownerToken !== "string" ||
      holder.ownerToken.length === 0
    ) {
      return null;
    }
    return {
      pid: holder.pid as number,
      createdAt: holder.createdAt,
      ownerToken: holder.ownerToken
    };
  } catch {
    return null;
  }
}

async function removeLockOwnedBy(path: string, ownerToken: string): Promise<boolean> {
  const holder = await readLockHolder(path);
  if (holder?.ownerToken !== ownerToken) return false;
  const tombstonePath = `${path}.release-${randomUUID()}`;
  try {
    await rename(path, tombstonePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  const moved = await readLockHolder(tombstonePath);
  if (moved?.ownerToken !== ownerToken) {
    try {
      await rename(tombstonePath, path);
    } catch (restoreError) {
      throw new AggregateError(
        [restoreError],
        `ACP profile lock ownership changed during release; replacement remains at ${tombstonePath}.`
      );
    }
    return false;
  }
  await rm(tombstonePath, { force: true });
  return true;
}

async function tryReclaimExpiredLock(options: {
  path: string;
  staleMs: number;
  isPidAlive: (pid: number) => boolean;
}): Promise<boolean> {
  const holder = await readLockHolder(options.path);
  if (!holder) return false;
  const ageMs = Date.now() - Date.parse(holder.createdAt);
  if (ageMs < options.staleMs || options.isPidAlive(holder.pid)) return false;
  return removeLockOwnedBy(options.path, holder.ownerToken);
}

async function acquireProfileLock(
  path: string,
  options: ResolvedAcpProfileStoreLockOptions
): Promise<string> {
  const { timeoutMs, staleMs, retryDelayMs, pid } = options;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      const holder: AcpProfileLockHolder = {
        pid,
        createdAt: new Date().toISOString(),
        ownerToken
      };
      await handle.writeFile(`${JSON.stringify(holder)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return ownerToken;
    } catch (error) {
      await handle?.close();
      if (!isErrno(error, "EEXIST")) {
        if (handle) await rm(path, { force: true });
        throw error;
      }
      if (await tryReclaimExpiredLock({ path, staleMs, isPidAlive })) continue;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`Timed out acquiring ACP profile catalog lock at ${path} after ${timeoutMs}ms.`);
}

async function withAcpProfileLock<T>(
  path: string,
  options: ResolvedAcpProfileStoreLockOptions,
  action: () => Promise<T>
): Promise<T> {
  const ownerToken = await acquireProfileLock(path, options);
  const release = async () => {
    if (!(await removeLockOwnedBy(path, ownerToken))) {
      throw new Error(`ACP profile catalog lock ownership changed before release at ${path}.`);
    }
  };
  let result: T;
  try {
    result = await action();
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `ACP profile catalog operation failed and lock release also failed at ${path}.`
      );
    }
    throw error;
  }
  await release();
  return result;
}

export function defaultAcpProfileCatalogPath(planweaveHome = resolvePlanweaveHome()): string {
  return join(planweaveHome, "config", "acp-profiles.json");
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].some((code) => isErrno(error, code))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function writeCatalogAtomically(path: string, catalog: AcpProfileCatalog): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);

  const temporaryPath = join(directory, `.${randomUUID()}.acp-profiles.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close();
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `ACP profile catalog write failed and temporary file cleanup also failed at ${temporaryPath}.`
      );
    }
    throw error;
  }
}

export class AcpProfileStore {
  readonly catalogPath: string;
  readonly lockPath: string;
  private readonly lockOptions: ResolvedAcpProfileStoreLockOptions;

  constructor(options: AcpProfileStoreOptions = {}) {
    this.catalogPath = options.catalogPath ?? defaultAcpProfileCatalogPath();
    this.lockPath = `${this.catalogPath}.lock`;
    if (options.lock?.isPidAlive !== undefined && typeof options.lock.isPidAlive !== "function") {
      throw new Error("ACP profile lock isPidAlive must be a function when provided.");
    }
    const { isPidAlive, ...lockValues } = options.lock ?? {};
    this.lockOptions = {
      ...acpProfileStoreLockValuesSchema.parse(lockValues),
      ...(isPidAlive ? { isPidAlive } : {})
    };
  }

  async read(): Promise<AcpProfileCatalog> {
    let raw: string;
    try {
      raw = await readFile(this.catalogPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyAcpProfileCatalog();
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new Error(`ACP profile catalog contains invalid JSON at ${this.catalogPath}.`);
    }
    return acpProfileCatalogSchema.parse(decoded);
  }

  register(input: {
    expectedRevision: number;
    profile: AcpProfileDescriptor;
  }): Promise<AcpProfileCatalog> {
    const profile = acpProfileDescriptorSchema.parse(input.profile);
    return this.updateCatalog(input.expectedRevision, (catalog) => {
      if (
        catalog.profiles.some(
          (current) => acpProfileCanonicalKey(current.id) === acpProfileCanonicalKey(profile.id)
        )
      ) {
        throw new AcpProfileAlreadyExistsError(profile.id);
      }
      return [...catalog.profiles, profile];
    });
  }

  update(input: {
    expectedRevision: number;
    profileId: string;
    profile: AcpProfileDescriptor;
  }): Promise<AcpProfileCatalog> {
    const profile = acpProfileDescriptorSchema.parse(input.profile);
    const profileId = acpProfileCanonicalKey(input.profileId);
    return this.updateCatalog(input.expectedRevision, (catalog) => {
      const index = catalog.profiles.findIndex(
        (current) => acpProfileCanonicalKey(current.id) === profileId
      );
      if (index < 0) throw new AcpProfileNotFoundError(input.profileId);
      if (acpProfileCanonicalKey(profile.id) !== profileId) {
        throw new Error("ACP profile update cannot change the profile id.");
      }
      return catalog.profiles.map((current, currentIndex) =>
        currentIndex === index ? profile : current
      );
    });
  }

  remove(input: { expectedRevision: number; profileId: string }): Promise<AcpProfileCatalog> {
    const profileId = acpProfileCanonicalKey(input.profileId);
    return this.updateCatalog(input.expectedRevision, (catalog) => {
      const profiles = catalog.profiles.filter(
        (profile) => acpProfileCanonicalKey(profile.id) !== profileId
      );
      if (profiles.length === catalog.profiles.length) {
        throw new AcpProfileNotFoundError(input.profileId);
      }
      return profiles;
    });
  }

  private async updateCatalog(
    expectedRevision: number,
    mutate: (catalog: AcpProfileCatalog) => readonly AcpProfileDescriptor[]
  ): Promise<AcpProfileCatalog> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer.");
    }
    await ensurePrivateDirectory(dirname(this.catalogPath));
    return withAcpProfileLock(this.lockPath, this.lockOptions, async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        throw new AcpProfileRevisionConflictError(expectedRevision, current.revision);
      }
      const next = acpProfileCatalogSchema.parse({
        version: "planweave.acp-profile-catalog/v1",
        revision: current.revision + 1,
        profiles: mutate(current)
      });
      await writeCatalogAtomically(this.catalogPath, next);
      return next;
    });
  }
}
