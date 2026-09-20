import { describe, expect, it, vi } from "vitest";
import { ServerDataArchiveError } from "@planweave-ai/server";
import { ServerDataMigration } from "../main/collaboration/serverDataMigration.js";

const restore = vi.hoisted(() => vi.fn());
vi.mock("@planweave-ai/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@planweave-ai/server")>()),
  restoreServerDataDirectory: restore,
  serverDataDirectoryIsActive: async () => false
}));

describe("Desktop restore diagnostic mapping", () => {
  it("reports historical recovery remnants as requiring manual recovery", async () => {
    restore.mockRejectedValueOnce(
      new ServerDataArchiveError("server_data_restore_recovery_required")
    );
    const migration = new ServerDataMigration({
      dataDirectory: () => "/target",
      localServerState: () => "stopped",
      snapshotIdentity: async () => ({ status: "unavailable", reason: "missing_identity" }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/archive.tgz"] })
    });
    expect(await migration.restoreArchive({})).toEqual({ status: "recovery_required" });
  });

  it("reports archive resource limits as a distinct result", async () => {
    restore.mockRejectedValueOnce(new ServerDataArchiveError("server_data_archive_resource_limit"));
    const migration = new ServerDataMigration({
      dataDirectory: () => "/target",
      localServerState: () => "stopped",
      snapshotIdentity: async () => ({ status: "unavailable", reason: "missing_identity" }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/archive.tgz"] })
    });
    expect(await migration.restoreArchive({})).toEqual({ status: "resource_limit" });
  });

  it.each([
    ["not_committed", "not_restored"],
    ["rollback_failed", "recovery_required"],
    ["committed", "restored_cleanup_failed"]
  ] as const)("reports %s without exposing paths", async (outcome, status) => {
    restore.mockRejectedValueOnce(
      new ServerDataArchiveError("server_data_restore_failed", {
        diagnostic: {
          phase: outcome === "committed" ? "cleanup" : "promotion",
          outcome,
          target: "/private/target",
          staging: "/private/staging",
          backup: "/private/backup"
        }
      })
    );
    const open = vi.fn(async () => ({ canceled: false, filePaths: ["/archive.tgz"] }));
    const migration = new ServerDataMigration({
      dataDirectory: () => "/target",
      localServerState: () => "stopped",
      snapshotIdentity: async () => ({ status: "unavailable", reason: "missing_identity" }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: open
    });
    expect(await migration.restoreArchive({})).toEqual({ status });
    restore.mockResolvedValueOnce({ fileCount: 3 });
    expect(await migration.restoreArchive({ overwrite: true })).toEqual({
      status: "restored",
      fileCount: 3
    });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
