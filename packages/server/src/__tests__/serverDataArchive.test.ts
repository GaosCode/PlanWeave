import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ServerDataArchiveError,
  exportServerDataDirectory,
  inspectServerDataArchive,
  restoreServerDataDirectory,
  serverDataDirectoryIsOccupied
} from "../serverDataArchive.js";
import { openServerDatabase } from "../sqlite.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-server-data-"));
  directories.push(directory);
  return directory;
}

async function writeSqlite(
  databasePath: string,
  ownership?: { processId: number; hostname: string }
): Promise<void> {
  const database = await openServerDatabase(databasePath, 1_000);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS server_instance_ownership (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        owner_token TEXT NOT NULL,
        process_id INTEGER NOT NULL CHECK(process_id > 0),
        hostname TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
    if (ownership) {
      database
        .prepare(
          `INSERT INTO server_instance_ownership(singleton, owner_token, process_id, hostname, acquired_at)
           VALUES (1, ?, ?, ?, ?)`
        )
        .run(
          "archive-test-token",
          ownership.processId,
          ownership.hostname,
          "2030-01-01T00:00:00.000Z"
        );
    }
  } finally {
    database.close();
  }
}

async function seedDataDirectory(root: string): Promise<string> {
  const dataDirectory = join(root, "data");
  await mkdir(join(dataDirectory, "artifacts", "sha256", "ab"), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDirectory, "artifacts", "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDirectory, "backups"), { recursive: true, mode: 0o700 });
  await writeSqlite(join(dataDirectory, "planweave-server.sqlite"));
  await writeFile(join(dataDirectory, "artifacts", "sha256", "ab", `${"a".repeat(64)}`), "blob\n", {
    mode: 0o600
  });
  await writeFile(join(dataDirectory, "artifacts", "tmp", "scratch"), "tmp\n", { mode: 0o600 });
  await writeFile(join(dataDirectory, "backups", "old"), "backup\n", { mode: 0o600 });
  return dataDirectory;
}

describe("server data archive", () => {
  it("exports durable Server files and restores them onto an empty directory", async () => {
    const root = await tempDir();
    const dataDirectory = await seedDataDirectory(root);
    const archivePath = join(root, "server-data.tgz");

    const manifest = await exportServerDataDirectory({
      dataDirectory,
      archivePath,
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    expect(manifest).toMatchObject({
      schemaVersion: "planweave-server-data-archive/v1",
      exportedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(manifest.fileCount).toBeGreaterThanOrEqual(2);
    expect(await inspectServerDataArchive(archivePath)).toEqual(manifest);

    const restored = join(root, "restored");
    await restoreServerDataDirectory({
      dataDirectory: restored,
      archivePath,
      overwrite: false
    });
    expect(
      await readFile(join(restored, "artifacts", "sha256", "ab", `${"a".repeat(64)}`), "utf8")
    ).toBe("blob\n");
    await expect(readFile(join(restored, "artifacts", "tmp", "scratch"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(restored, "backups", "old"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    const restoredDatabase = await openServerDatabase(
      join(restored, "planweave-server.sqlite"),
      1_000
    );
    try {
      expect(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM server_instance_ownership").get()
      ).toEqual({ count: 0 });
    } finally {
      restoredDatabase.close();
    }
  });

  it("refuses to restore over existing data unless overwrite is selected", async () => {
    const root = await tempDir();
    const dataDirectory = await seedDataDirectory(root);
    const archivePath = join(root, "server-data.tgz");
    await exportServerDataDirectory({ dataDirectory, archivePath });
    const target = join(root, "target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "planweave-server.sqlite"), "keep-me\n");
    expect(await serverDataDirectoryIsOccupied(target)).toBe(true);

    await expect(
      restoreServerDataDirectory({ dataDirectory: target, archivePath, overwrite: false })
    ).rejects.toEqual(new ServerDataArchiveError("server_data_directory_nonempty"));
    expect(await readFile(join(target, "planweave-server.sqlite"), "utf8")).toBe("keep-me\n");

    await restoreServerDataDirectory({ dataDirectory: target, archivePath, overwrite: true });
    expect(
      await readFile(join(target, "artifacts", "sha256", "ab", `${"a".repeat(64)}`), "utf8")
    ).toBe("blob\n");
    await expect(readFile(join(target, "planweave-server.sqlite"), "utf8")).resolves.not.toBe(
      "keep-me\n"
    );
  });

  it("restores inside the data volume when the parent directory is not writable", async () => {
    const root = await tempDir();
    const parent = join(root, "readonly-parent");
    const source = join(root, "source");
    const target = join(parent, "data");
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeSqlite(join(source, "planweave-server.sqlite"));
    await writeFile(join(source, "keep.txt"), "keep");
    const archivePath = join(root, "archive.tgz");
    await exportServerDataDirectory({ dataDirectory: source, archivePath });

    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "old.txt"), "old");
    await chmod(parent, 0o555);
    try {
      await restoreServerDataDirectory({
        dataDirectory: target,
        archivePath,
        overwrite: true
      });
    } finally {
      await chmod(parent, 0o700);
    }
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");
    await expect(readFile(join(target, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an empty source directory", async () => {
    const root = await tempDir();
    const dataDirectory = join(root, "empty");
    await mkdir(dataDirectory, { recursive: true });
    await expect(
      exportServerDataDirectory({
        dataDirectory,
        archivePath: join(root, "empty.tgz")
      })
    ).rejects.toEqual(new ServerDataArchiveError("server_data_directory_empty"));
  });

  it("refuses export while this computer still owns a live Server process", async () => {
    const root = await tempDir();
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeSqlite(join(dataDirectory, "planweave-server.sqlite"), {
      processId: process.pid,
      hostname: hostname()
    });
    await expect(
      exportServerDataDirectory({
        dataDirectory,
        archivePath: join(root, "live.tgz")
      })
    ).rejects.toEqual(new ServerDataArchiveError("server_data_directory_active"));
  });
});
