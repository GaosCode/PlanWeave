import {
  ServerDataArchiveError,
  exportServerDataDirectory,
  restoreServerDataDirectory,
  serverDataDirectoryIsActive,
  serverDataDirectoryIsOccupied
} from "@planweave-ai/server";
import type { LocalCollaborationServerStatus } from "../../shared/localCollaborationScopes.js";
import {
  exportServerDataArchiveInputSchema,
  exportServerDataArchiveResultSchema,
  listServerDataExportSourcesResultSchema,
  restoreServerDataArchiveInputSchema,
  restoreServerDataArchiveResultSchema,
  type ExportServerDataArchiveResult,
  type ListServerDataExportSourcesResult,
  type RestoreServerDataArchiveResult
} from "../../shared/serverDataMigration.js";

export type ServerDataMigrationDialogs = {
  showSaveDialog: (options: {
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog: (options: {
    filters: Array<{ name: string; extensions: string[] }>;
    properties: Array<"openFile">;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
};

export type ServerDataMigrationOptions = ServerDataMigrationDialogs & {
  dataDirectory: () => string;
  localServerState: () => LocalCollaborationServerStatus["state"];
  now?: () => Date;
  onExported?: () => Promise<void>;
};

const archiveFilter = [{ name: "PlanWeave Server data", extensions: ["tgz"] }];

export function localServerLifecycleBlocksMigration(
  state: LocalCollaborationServerStatus["state"]
): boolean {
  return state === "running" || state === "starting" || state === "stopping";
}

function archiveErrorStatus(error: unknown): string | null {
  if (error instanceof ServerDataArchiveError) return error.code;
  return null;
}

export class ServerDataMigration {
  private pendingArchivePath: string | null = null;
  private readonly dataDirectory: ServerDataMigrationOptions["dataDirectory"];
  private readonly localServerState: ServerDataMigrationOptions["localServerState"];
  private readonly showSaveDialog: ServerDataMigrationDialogs["showSaveDialog"];
  private readonly showOpenDialog: ServerDataMigrationDialogs["showOpenDialog"];
  private readonly now: () => Date;
  private readonly onExported?: () => Promise<void>;

  constructor(options: ServerDataMigrationOptions) {
    this.dataDirectory = options.dataDirectory;
    this.localServerState = options.localServerState;
    this.showSaveDialog = options.showSaveDialog;
    this.showOpenDialog = options.showOpenDialog;
    this.now = options.now ?? (() => new Date());
    this.onExported = options.onExported;
  }

  private async isRunning(dataDirectory: string): Promise<boolean> {
    return (
      localServerLifecycleBlocksMigration(this.localServerState()) ||
      (await serverDataDirectoryIsActive(dataDirectory))
    );
  }

  async listSources(): Promise<ListServerDataExportSourcesResult> {
    const dataDirectory = this.dataDirectory();
    return listServerDataExportSourcesResultSchema.parse({
      sources: [
        {
          id: "this_computer",
          occupied: await serverDataDirectoryIsOccupied(dataDirectory),
          running: await this.isRunning(dataDirectory)
        }
      ]
    });
  }

  async exportArchive(input: unknown): Promise<ExportServerDataArchiveResult> {
    exportServerDataArchiveInputSchema.parse(input);
    const dataDirectory = this.dataDirectory();
    if (await this.isRunning(dataDirectory)) {
      return exportServerDataArchiveResultSchema.parse({ status: "running" });
    }
    if (!(await serverDataDirectoryIsOccupied(dataDirectory))) {
      return exportServerDataArchiveResultSchema.parse({ status: "empty" });
    }
    const date = this.now().toISOString().slice(0, 10);
    const save = await this.showSaveDialog({
      defaultPath: `planweave-server-data-${date}.tgz`,
      filters: archiveFilter
    });
    if (save.canceled || !save.filePath) {
      return exportServerDataArchiveResultSchema.parse({ status: "cancelled" });
    }
    try {
      const manifest = await exportServerDataDirectory({
        dataDirectory,
        archivePath: save.filePath
      });
      try {
        await this.onExported?.();
      } catch (error) {
        console.error("Failed to snapshot exported Server data identity.", error);
      }
      return exportServerDataArchiveResultSchema.parse({
        status: "exported",
        fileCount: manifest.fileCount
      });
    } catch (error) {
      const code = archiveErrorStatus(error);
      if (code === "server_data_directory_active") {
        return exportServerDataArchiveResultSchema.parse({ status: "running" });
      }
      if (code === "server_data_directory_empty") {
        return exportServerDataArchiveResultSchema.parse({ status: "empty" });
      }
      if (code) {
        return exportServerDataArchiveResultSchema.parse({ status: "unavailable" });
      }
      throw error;
    }
  }

  async restoreArchive(input: unknown): Promise<RestoreServerDataArchiveResult> {
    const parsed = restoreServerDataArchiveInputSchema.parse(input ?? {});
    const dataDirectory = this.dataDirectory();
    if (await this.isRunning(dataDirectory)) {
      return restoreServerDataArchiveResultSchema.parse({ status: "running" });
    }
    let archivePath = parsed.overwrite === true ? this.pendingArchivePath : null;
    if (!archivePath) {
      const open = await this.showOpenDialog({
        filters: archiveFilter,
        properties: ["openFile"]
      });
      if (open.canceled || !open.filePaths[0]) {
        return restoreServerDataArchiveResultSchema.parse({ status: "cancelled" });
      }
      archivePath = open.filePaths[0];
      this.pendingArchivePath = archivePath;
    }
    try {
      const manifest = await restoreServerDataDirectory({
        dataDirectory,
        archivePath,
        overwrite: parsed.overwrite === true
      });
      this.pendingArchivePath = null;
      return restoreServerDataArchiveResultSchema.parse({
        status: "restored",
        fileCount: manifest.fileCount
      });
    } catch (error) {
      const code = archiveErrorStatus(error);
      if (code === "server_data_directory_active") {
        return restoreServerDataArchiveResultSchema.parse({ status: "running" });
      }
      if (code === "server_data_directory_nonempty") {
        return restoreServerDataArchiveResultSchema.parse({ status: "needs_overwrite" });
      }
      if (code === "server_data_archive_invalid") {
        this.pendingArchivePath = null;
        return restoreServerDataArchiveResultSchema.parse({ status: "invalid_archive" });
      }
      if (code) {
        return restoreServerDataArchiveResultSchema.parse({ status: "unavailable" });
      }
      throw error;
    }
  }
}
