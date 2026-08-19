import { hostname } from "node:os";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { createGunzip, createGzip, type Gzip } from "node:zlib";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openServerDatabase } from "./sqlite.js";

export const SERVER_DATA_ARCHIVE_SCHEMA_VERSION = "planweave-server-data-archive/v1" as const;
export const SERVER_DATA_ARCHIVE_DATABASE_FILE = "planweave-server.sqlite";

export class ServerDataArchiveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ServerDataArchiveError";
  }
}

export const serverDataArchiveManifestSchema = z
  .object({
    schemaVersion: z.literal(SERVER_DATA_ARCHIVE_SCHEMA_VERSION),
    exportedAt: z.iso.datetime(),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative()
  })
  .strict();
export type ServerDataArchiveManifest = z.infer<typeof serverDataArchiveManifestSchema>;

const SKIP_ROOTS = new Set(["backups"]);
const SKIP_TMP_PARENTS = new Set(["artifacts", "comment-attachments"]);
const RESTORE_STAGING_PREFIX = ".planweave-server-restore-";
const RESTORE_BACKUP_PREFIX = ".planweave-server-replaced-";

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function assertSafeRelative(posixPath: string): void {
  if (!posixPath || posixPath.startsWith("/") || posixPath.includes("\\")) {
    throw new ServerDataArchiveError("server_data_archive_invalid");
  }
  const parts = posixPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ServerDataArchiveError("server_data_archive_invalid");
  }
}

function shouldSkipPosix(posixPath: string): boolean {
  const parts = posixPath.split("/");
  if (SKIP_ROOTS.has(parts[0] ?? "")) return true;
  if (parts[0]?.startsWith(RESTORE_STAGING_PREFIX) || parts[0]?.startsWith(RESTORE_BACKUP_PREFIX)) {
    return true;
  }
  if (parts.length >= 2 && SKIP_TMP_PARENTS.has(parts[0] ?? "") && parts[1] === "tmp") return true;
  if (parts[parts.length - 1] === ".DS_Store") return true;
  return false;
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
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  );
  const files: Array<{ relativePosix: string; absolutePath: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(entry.parentPath, entry.name);
    const relativePosix = toPosix(relative(root, absolutePath));
    assertSafeRelative(relativePosix);
    if (shouldSkipPosix(relativePosix)) continue;
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    files.push({ relativePosix, absolutePath, size: info.size });
  }
  files.sort((left, right) => left.relativePosix.localeCompare(right.relativePosix));
  return files;
}

export async function serverDataDirectoryIsOccupied(dataDirectory: string): Promise<boolean> {
  return (await listIncludedFiles(dataDirectory)).length > 0;
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

async function clearServerInstanceOwnership(dataDirectory: string): Promise<void> {
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
    database.exec("DELETE FROM server_instance_ownership");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("no such table")) throw error;
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
  octalField(size, 12).copy(header, 124);
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

async function writeGzipChunk(gzip: Gzip, chunk: Buffer): Promise<void> {
  if (!gzip.write(chunk)) await once(gzip, "drain");
}

async function writeTarGzip(
  archivePath: string,
  files: Array<{ name: string; bytes?: Buffer; absolutePath?: string; size: number }>
): Promise<void> {
  await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
  const gzip = createGzip();
  const output = createWriteStream(archivePath, { mode: 0o600 });
  const writing = pipeline(gzip, output);
  const mtime = Date.now() / 1000;
  for (const file of files) {
    await writeGzipChunk(gzip, tarHeader(file.name, file.size, mtime));
    if (file.bytes) {
      if (file.bytes.byteLength !== file.size) {
        throw new ServerDataArchiveError("server_data_archive_invalid");
      }
      await writeGzipChunk(gzip, file.bytes);
    } else if (file.absolutePath) {
      const source = createReadStream(file.absolutePath);
      for await (const chunk of source) {
        await writeGzipChunk(gzip, Buffer.from(chunk));
      }
    }
    const padding = padBlock(file.size);
    if (padding > 0) await writeGzipChunk(gzip, Buffer.alloc(padding, 0));
  }
  await writeGzipChunk(gzip, Buffer.alloc(1024, 0));
  gzip.end();
  await writing;
}

async function readTarGzip(
  archivePath: string
): Promise<Array<{ name: string; size: number; body: Buffer }>> {
  const gunzip = createGunzip();
  createReadStream(archivePath).pipe(gunzip);
  const chunks: Buffer[] = [];
  for await (const chunk of gunzip) {
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const files: Array<{ name: string; size: number; body: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 135).toString("ascii").replace(/\0/g, "").trim();
    const size = Number.parseInt(sizeText, 8);
    if (!name || !Number.isFinite(size) || size < 0) {
      throw new ServerDataArchiveError("server_data_archive_invalid");
    }
    if (offset + size > buffer.length) {
      throw new ServerDataArchiveError("server_data_archive_invalid");
    }
    files.push({ name, size, body: Buffer.from(buffer.subarray(offset, offset + size)) });
    offset += size + padBlock(size);
  }
  return files;
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
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const manifest = serverDataArchiveManifestSchema.parse({
    schemaVersion: SERVER_DATA_ARCHIVE_SCHEMA_VERSION,
    exportedAt: (input.now?.() ?? new Date()).toISOString(),
    fileCount: files.length,
    totalBytes
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeTarGzip(input.archivePath, [
    { name: "manifest.json", bytes: manifestBytes, size: manifestBytes.byteLength },
    ...files.map((file) => ({
      name: `data/${file.relativePosix}`,
      absolutePath: file.absolutePath,
      size: file.size
    }))
  ]);
  await chmod(input.archivePath, 0o600).catch(() => undefined);
  return manifest;
}

export async function inspectServerDataArchive(
  archivePath: string
): Promise<ServerDataArchiveManifest> {
  const files = await readTarGzip(archivePath);
  const manifestFile = files.find((file) => file.name === "manifest.json");
  if (!manifestFile) throw new ServerDataArchiveError("server_data_archive_invalid");
  const manifest = serverDataArchiveManifestSchema.parse(
    JSON.parse(manifestFile.body.toString("utf8"))
  );
  const dataFiles = files.filter((file) => file.name.startsWith("data/"));
  if (dataFiles.length !== manifest.fileCount) {
    throw new ServerDataArchiveError("server_data_archive_invalid");
  }
  for (const file of dataFiles) {
    const relativePosix = file.name.slice("data/".length);
    assertSafeRelative(relativePosix);
    if (shouldSkipPosix(relativePosix)) {
      throw new ServerDataArchiveError("server_data_archive_invalid");
    }
  }
  return manifest;
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
  const occupied = await serverDataDirectoryIsOccupied(input.dataDirectory);
  if (occupied && !input.overwrite) {
    throw new ServerDataArchiveError("server_data_directory_nonempty");
  }
  const files = await readTarGzip(input.archivePath);
  const manifestFile = files.find((file) => file.name === "manifest.json");
  if (!manifestFile) throw new ServerDataArchiveError("server_data_archive_invalid");
  const manifest = serverDataArchiveManifestSchema.parse(
    JSON.parse(manifestFile.body.toString("utf8"))
  );
  const target = resolve(input.dataDirectory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const stagingName = `${RESTORE_STAGING_PREFIX}${randomUUID()}`;
  const staging = join(target, stagingName);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) {
      if (file.name === "manifest.json") continue;
      if (!file.name.startsWith("data/")) {
        throw new ServerDataArchiveError("server_data_archive_invalid");
      }
      const relativePosix = file.name.slice("data/".length);
      assertSafeRelative(relativePosix);
      const destination = resolve(join(staging, ...relativePosix.split("/")));
      if (!destination.startsWith(resolve(staging))) {
        throw new ServerDataArchiveError("server_data_archive_invalid");
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.body, { mode: 0o600 });
    }
    await promoteRestoredDirectory(target, staging);
    await chmod(target, 0o700).catch(() => undefined);
    await clearServerInstanceOwnership(target);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function promoteRestoredDirectory(target: string, staging: string): Promise<void> {
  const stagingName = basename(staging);
  const backup = join(target, `${RESTORE_BACKUP_PREFIX}${randomUUID()}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const backupName = basename(backup);
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === stagingName || entry.name === backupName) continue;
    await rename(join(target, entry.name), join(backup, entry.name));
  }
  try {
    for (const name of await readdir(staging)) {
      await rename(join(staging, name), join(target, name));
    }
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === stagingName || entry.name === backupName) continue;
      await rm(join(target, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const name of await readdir(backup).catch(() => [])) {
      await rename(join(backup, name), join(target, name)).catch(() => undefined);
    }
    throw error;
  }
}
