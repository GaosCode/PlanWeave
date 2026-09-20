import { z } from "zod";
import { ServerDataArchiveError } from "./serverDataArchiveError.js";

export const SERVER_DATA_ARCHIVE_SCHEMA_VERSION = "planweave-server-data-archive/v1" as const;
export const serverDataArchiveManifestSchema = z
  .object({
    schemaVersion: z.literal(SERVER_DATA_ARCHIVE_SCHEMA_VERSION),
    exportedAt: z.iso.datetime(),
    fileCount: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe()
  })
  .strict();
export type ServerDataArchiveManifest = z.infer<typeof serverDataArchiveManifestSchema>;
export type ServerDataArchiveLimits = Readonly<{
  compressedBytes: number;
  expandedBytes: number;
  fileBytes: number;
  fileCount: number;
  manifestBytes: number;
}>;
export const SERVER_DATA_ARCHIVE_LIMITS: ServerDataArchiveLimits = Object.freeze({
  compressedBytes: 8 * 1024 ** 3,
  expandedBytes: 32 * 1024 ** 3,
  fileBytes: 8 * 1024 ** 3,
  fileCount: 100_000,
  manifestBytes: 64 * 1024
});
export const SERVER_DATA_RESTORE_BACKUP_PREFIX = ".planweave-server-replaced-";
export const RESTORE_STAGING_PREFIX = ".planweave-server-restore-";

export function archiveInvalid(): never {
  throw new ServerDataArchiveError("server_data_archive_invalid");
}
export function assertArchiveLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new ServerDataArchiveError("server_data_archive_resource_limit");
  }
}
export function shouldSkipArchivePath(path: string): boolean {
  const parts = path.normalize("NFC").toLowerCase().split("/");
  return (
    parts[0] === "backups" ||
    parts[0]?.startsWith(RESTORE_STAGING_PREFIX) === true ||
    parts[0]?.startsWith(SERVER_DATA_RESTORE_BACKUP_PREFIX) === true ||
    (["artifacts", "comment-attachments"].includes(parts[0] ?? "") && parts[1] === "tmp") ||
    parts.at(-1) === ".ds_store"
  );
}
export function assertArchivePath(path: string): void {
  if (!path || Buffer.byteLength(`data/${path}`, "utf8") > 100) archiveInvalid();
  for (const part of path.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\\<>:"|?*]/u.test(part) ||
      [...part].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      /[. ]$/u.test(part) ||
      /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(part)
    )
      archiveInvalid();
  }
}

/** Records files and implied directories, including portable filesystem aliases. */
export class ArchivePaths {
  private readonly paths = new Map<string, { spelling: string; file: boolean }>();
  add(path: string): void {
    assertArchivePath(path);
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const spelling = parts.slice(0, index + 1).join("/");
      const key = spelling.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
      const file = index === parts.length - 1;
      const existing = this.paths.get(key);
      if (existing && (existing.spelling !== spelling || existing.file || file)) archiveInvalid();
      this.paths.set(key, { spelling, file });
    }
  }
}
