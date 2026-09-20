import { hostname } from "node:os";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createGzip } from "node:zlib";
import { randomUUID } from "node:crypto";
import { readServerDataArchive } from "./serverDataArchiveReader.js";
import {
  ArchivePaths,
  assertArchivePath,
  shouldSkipArchivePath,
  RESTORE_STAGING_PREFIX,
  SERVER_DATA_ARCHIVE_LIMITS,
  assertArchiveLimit,
  serverDataArchiveManifestSchema,
  SERVER_DATA_ARCHIVE_SCHEMA_VERSION,
  type ServerDataArchiveManifest
} from "./serverDataArchivePolicy.js";
export {
  SERVER_DATA_ARCHIVE_SCHEMA_VERSION,
  serverDataArchiveManifestSchema,
  type ServerDataArchiveManifest
} from "./serverDataArchivePolicy.js";
import { openServerDatabase } from "./sqlite.js";
import {
  normalizeServerDataRestoreHostBindings,
  ServerDataRestoreHostBindingError
} from "./serverDataRestoreHostBindings.js";
import { ServerDataArchiveError } from "./serverDataArchiveError.js";
import {
  promoteRestoredDirectory,
  SERVER_DATA_RESTORE_BACKUP_PREFIX
} from "./serverDataRestorePromotion.js";

export { ServerDataArchiveError } from "./serverDataArchiveError.js";

export const SERVER_DATA_ARCHIVE_DATABASE_FILE = "planweave-server.sqlite";

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function isNotADatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is not a database|SQLITE_NOTADB|not a database/i.test(message);
}

async function openExistingServerDatabase(databasePath: string) {
  try {
    return await openServerDatabase(databasePath, 1_000);
  } catch (error) {
    if (isNotADatabase(error)) return null;
    throw error;
  }
}

async function listIncludedFiles(
  dataDirectory: string
): Promise<Array<{ relativePosix: string; absolutePath: string; size: number }>> {
  const root = resolve(dataDirectory);
  const files: Array<{ relativePosix: string; absolutePath: string; size: number }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePosix = toPosix(relative(root, absolutePath));
      if (shouldSkipArchivePath(relativePosix)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      assertArchivePath(relativePosix);
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
      assertArchiveLimit(info.size, SERVER_DATA_ARCHIVE_LIMITS.fileBytes);
      assertArchiveLimit(files.length + 1, SERVER_DATA_ARCHIVE_LIMITS.fileCount);
      files.push({ relativePosix, absolutePath, size: info.size });
    }
  }
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  await visit(root);
  files.sort((left, right) => left.relativePosix.localeCompare(right.relativePosix));
  return files;
}

export async function serverDataDirectoryHasExportableData(
  dataDirectory: string
): Promise<boolean> {
  return (await listIncludedFiles(dataDirectory)).length > 0;
}

async function existingRootNames(dataDirectory: string): Promise<string[]> {
  try {
    return await readdir(dataDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function serverDataDirectoryIsOccupied(dataDirectory: string): Promise<boolean> {
  return (await existingRootNames(dataDirectory)).length > 0;
}

async function assertRestoreTarget(
  dataDirectory: string,
  overwrite: boolean,
  staging?: string
): Promise<void> {
  const names = (await existingRootNames(dataDirectory)).filter(
    (name) => join(dataDirectory, name) !== staging
  );
  if (names.length && !overwrite)
    throw new ServerDataArchiveError("server_data_directory_nonempty");
  if (
    names.some(
      (name) =>
        name.startsWith(RESTORE_STAGING_PREFIX) ||
        name.startsWith(SERVER_DATA_RESTORE_BACKUP_PREFIX)
    )
  ) {
    throw new ServerDataArchiveError("server_data_restore_recovery_required");
  }
  if (await serverDataDirectoryIsActive(dataDirectory))
    throw new ServerDataArchiveError("server_data_directory_active");
}

export async function serverDataDirectoryIsActive(dataDirectory: string): Promise<boolean> {
  const databasePath = join(dataDirectory, SERVER_DATA_ARCHIVE_DATABASE_FILE);
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const database = await openExistingServerDatabase(databasePath);
  if (!database) return false;
  try {
    const row = database
      .prepare(
        `SELECT process_id AS processId, hostname AS hostname
         FROM server_instance_ownership WHERE singleton=1`
      )
      .get() as { processId?: number; hostname?: string } | undefined;
    if (!row || typeof row.processId !== "number" || typeof row.hostname !== "string") {
      return false;
    }
    if (row.hostname !== hostname()) return false;
    try {
      process.kill(row.processId, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("no such table")) return false;
    throw error;
  } finally {
    database.close();
  }
}

async function normalizeRestoredServerData(
  stagingDirectory: string,
  targetDirectory: string
): Promise<void> {
  const databasePath = join(stagingDirectory, SERVER_DATA_ARCHIVE_DATABASE_FILE);
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const database = await openServerDatabase(databasePath, 1_000).catch((error: unknown) => {
    if (isNotADatabase(error)) {
      throw new ServerDataArchiveError("server_data_restore_database_invalid");
    }
    throw error;
  });
  try {
    await normalizeServerDataRestoreHostBindings({
      database,
      stagingDirectory,
      targetDirectory
    });
  } catch (error) {
    if (error instanceof ServerDataRestoreHostBindingError) {
      throw new ServerDataArchiveError(error.code);
    }
    throw error;
  } finally {
    database.close();
  }
}

async function checkpointServerDatabase(dataDirectory: string): Promise<void> {
  const databasePath = join(dataDirectory, SERVER_DATA_ARCHIVE_DATABASE_FILE);
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const database = await openExistingServerDatabase(databasePath);
  if (!database) return;
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    database.close();
  }
}

function octalField(value: number, length: number): Buffer {
  const field = Buffer.alloc(length, 0);
  const encoded = value.toString(8).padStart(length - 1, "0");
  field.write(encoded, 0, length - 1, "ascii");
  return field;
}

function tarHeader(name: string, size: number, mtime: number): Buffer {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new ServerDataArchiveError("server_data_archive_invalid");
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  octalField(0o600, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  if (size < 8 * 1024 ** 3) octalField(size, 12).copy(header, 124);
  else {
    header[124] = 0x80;
    header.writeBigUInt64BE(BigInt(size), 128);
  }
  octalField(Math.floor(mtime), 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function padBlock(size: number): number {
  return (512 - (size % 512)) % 512;
}

async function writeTarGzip(
  archivePath: string,
  files: Array<{ name: string; bytes?: Buffer; absolutePath?: string; size: number }>
): Promise<void> {
  await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
  async function* members() {
    const mtime = Date.now() / 1000;
    for (const file of files) {
      yield tarHeader(file.name, file.size, mtime);
      let actual = 0;
      if (file.bytes) {
        actual = file.bytes.length;
        yield file.bytes;
      } else if (file.absolutePath) {
        for await (const chunk of createReadStream(file.absolutePath)) {
          actual += chunk.length;
          if (actual > file.size) throw new ServerDataArchiveError("server_data_archive_invalid");
          yield chunk;
        }
      }
      if (actual !== file.size) throw new ServerDataArchiveError("server_data_archive_invalid");
      if (padBlock(file.size)) yield Buffer.alloc(padBlock(file.size));
    }
    yield Buffer.alloc(1024);
  }
  let compressed = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed += chunk.length;
      try {
        assertArchiveLimit(compressed, SERVER_DATA_ARCHIVE_LIMITS.compressedBytes);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  await pipeline(
    Readable.from(members()),
    createGzip(),
    counter,
    createWriteStream(archivePath, { mode: 0o600 })
  );
}

export async function exportServerDataDirectory(input: {
  dataDirectory: string;
  archivePath: string;
  now?: () => Date;
}): Promise<ServerDataArchiveManifest> {
  if (!isAbsolute(input.archivePath)) {
    throw new ServerDataArchiveError("server_data_archive_path_invalid");
  }
  if (await serverDataDirectoryIsActive(input.dataDirectory)) {
    throw new ServerDataArchiveError("server_data_directory_active");
  }
  await checkpointServerDatabase(input.dataDirectory);
  const files = await listIncludedFiles(input.dataDirectory);
  if (files.length === 0) {
    throw new ServerDataArchiveError("server_data_directory_empty");
  }
  const paths = new ArchivePaths();
  assertArchiveLimit(files.length, SERVER_DATA_ARCHIVE_LIMITS.fileCount);
  for (const file of files) {
    paths.add(file.relativePosix);
    assertArchiveLimit(file.size, SERVER_DATA_ARCHIVE_LIMITS.fileBytes);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const manifest = serverDataArchiveManifestSchema.parse({
    schemaVersion: SERVER_DATA_ARCHIVE_SCHEMA_VERSION,
    exportedAt: (input.now?.() ?? new Date()).toISOString(),
    fileCount: files.length,
    totalBytes
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertArchiveLimit(manifestBytes.length, SERVER_DATA_ARCHIVE_LIMITS.manifestBytes);
  assertArchiveLimit(
    1024 +
      512 +
      manifestBytes.length +
      padBlock(manifestBytes.length) +
      files.reduce((sum, file) => sum + 512 + file.size + padBlock(file.size), 0),
    SERVER_DATA_ARCHIVE_LIMITS.expandedBytes
  );
  await writeTarGzip(input.archivePath, [
    { name: "manifest.json", bytes: manifestBytes, size: manifestBytes.byteLength },
    ...files.map((file) => ({
      name: `data/${file.relativePosix}`,
      absolutePath: file.absolutePath,
      size: file.size
    }))
  ]);
  await chmod(input.archivePath, 0o600);
  return manifest;
}

export async function inspectServerDataArchive(
  archivePath: string
): Promise<ServerDataArchiveManifest> {
  return readServerDataArchive({ archivePath });
}

export async function restoreServerDataDirectory(input: {
  dataDirectory: string;
  archivePath: string;
  overwrite: boolean;
}): Promise<ServerDataArchiveManifest> {
  if (!isAbsolute(input.archivePath) || !isAbsolute(input.dataDirectory)) {
    throw new ServerDataArchiveError("server_data_archive_path_invalid");
  }
  if (await serverDataDirectoryIsActive(input.dataDirectory)) {
    throw new ServerDataArchiveError("server_data_directory_active");
  }
  await assertRestoreTarget(input.dataDirectory, input.overwrite);
  const target = resolve(input.dataDirectory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const stagingName = `${RESTORE_STAGING_PREFIX}${randomUUID()}`;
  const staging = join(target, stagingName);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const manifest = await readServerDataArchive({
      archivePath: input.archivePath,
      openMember: async (relativePath) => {
        const destination = join(staging, ...relativePath.split("/"));
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await open(destination, "wx", 0o600);
        return {
          write: async (chunk) => {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              if (bytesWritten === 0) throw new Error("Archive member write made no progress");
              offset += bytesWritten;
            }
          },
          close: () => handle.close()
        };
      }
    });
    await normalizeRestoredServerData(staging, target);
    await assertRestoreTarget(target, input.overwrite, staging);
    await chmod(target, 0o700);
    await promoteRestoredDirectory(target, staging);
    return manifest;
  } catch (error) {
    if (error instanceof ServerDataArchiveError && error.diagnostic) throw error;
    try {
      await rm(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new ServerDataArchiveError(
        error instanceof ServerDataArchiveError ? error.code : "server_data_restore_prepare_failed",
        {
          cause: new AggregateError(
            [error, cleanupError],
            "Restore preparation and cleanup failed"
          ),
          diagnostic: { phase: "prepare", outcome: "not_committed", target, staging }
        }
      );
    }
    throw error;
  }
}
