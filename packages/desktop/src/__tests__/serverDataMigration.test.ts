import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerDataMigration } from "../main/collaboration/serverDataMigration.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => { close(): void };
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-desktop-server-data-"));
  directories.push(directory);
  return directory;
}

async function seedServerData(dataDirectory: string): Promise<void> {
  await mkdir(join(dataDirectory, "artifacts"), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(dataDirectory, "planweave-server.sqlite"));
  database.close();
  await writeFile(join(dataDirectory, "artifacts", "note.txt"), "workspace-bytes\n", {
    mode: 0o600
  });
}

describe("ServerDataMigration", () => {
  it("exports this computer's Server data through a save dialog", async () => {
    const root = await tempDir();
    const dataDirectory = join(root, "local-collaboration-server");
    await seedServerData(dataDirectory);
    const archivePath = join(root, "server-data.tgz");
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: archivePath }));
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    const onExported = vi.fn(async () => undefined);
    const migration = new ServerDataMigration({
      dataDirectory: () => dataDirectory,
      localServerState: () => "stopped",
      showSaveDialog,
      showOpenDialog,
      onExported,
      now: () => new Date("2030-01-02T00:00:00.000Z")
    });

    await expect(migration.listSources()).resolves.toEqual({
      sources: [{ id: "this_computer", occupied: true, running: false }]
    });
    await expect(migration.exportArchive({ sourceId: "this_computer" })).resolves.toMatchObject({
      status: "exported"
    });
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "planweave-server-data-2030-01-02.tgz",
      filters: [{ name: "PlanWeave Server data", extensions: ["tgz"] }]
    });
    expect(await readFile(archivePath)).toBeInstanceOf(Buffer);
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(onExported).toHaveBeenCalledTimes(1);
  });

  it("refuses export while the local Server is running and does not open a dialog", async () => {
    const root = await tempDir();
    const dataDirectory = join(root, "local-collaboration-server");
    await seedServerData(dataDirectory);
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: join(root, "no.tgz") }));
    const migration = new ServerDataMigration({
      dataDirectory: () => dataDirectory,
      localServerState: () => "running",
      showSaveDialog,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    });
    await expect(migration.listSources()).resolves.toEqual({
      sources: [{ id: "this_computer", occupied: true, running: true }]
    });
    await expect(migration.exportArchive({ sourceId: "this_computer" })).resolves.toEqual({
      status: "running"
    });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("asks for overwrite on a second restore without picking the file again", async () => {
    const root = await tempDir();
    const source = join(root, "source");
    const target = join(root, "target");
    await seedServerData(source);
    await seedServerData(target);
    const archivePath = join(root, "server-data.tgz");
    const exporter = new ServerDataMigration({
      dataDirectory: () => source,
      localServerState: () => "stopped",
      showSaveDialog: async () => ({ canceled: false, filePath: archivePath }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    });
    await expect(exporter.exportArchive({ sourceId: "this_computer" })).resolves.toMatchObject({
      status: "exported"
    });

    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [archivePath] }));
    const migration = new ServerDataMigration({
      dataDirectory: () => target,
      localServerState: () => "stopped",
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog
    });
    await expect(migration.restoreArchive({})).resolves.toEqual({ status: "needs_overwrite" });
    await expect(migration.restoreArchive({ overwrite: true })).resolves.toMatchObject({
      status: "restored"
    });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(await readFile(join(target, "artifacts", "note.txt"), "utf8")).toBe("workspace-bytes\n");
  });

  it("returns empty when this computer has no Server data", async () => {
    const root = await tempDir();
    const dataDirectory = join(root, "empty");
    await mkdir(dataDirectory, { recursive: true });
    const showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: join(root, "empty.tgz")
    }));
    const migration = new ServerDataMigration({
      dataDirectory: () => dataDirectory,
      localServerState: () => "stopped",
      showSaveDialog,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    });
    await expect(migration.exportArchive({ sourceId: "this_computer" })).resolves.toEqual({
      status: "empty"
    });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });
});
