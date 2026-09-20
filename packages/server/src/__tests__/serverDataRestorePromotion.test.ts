import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerDataArchiveError } from "../serverDataArchive.js";
import {
  promoteRestoredDirectory,
  type ServerDataRestorePromotionOperations
} from "../serverDataRestorePromotion.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-restore-promotion-"));
  directories.push(root);
  const target = join(root, "target");
  const staging = join(target, ".staging");
  await mkdir(staging, { recursive: true });
  await writeFile(join(target, "old-a.txt"), "old-a", "utf8");
  await writeFile(join(target, "old-b.txt"), "old-b", "utf8");
  await writeFile(join(staging, "new-a.txt"), "new-a", "utf8");
  await writeFile(join(staging, "new-b.txt"), "new-b", "utf8");
  return { target, staging };
}

function operations(
  input: {
    failList?: (path: string) => Error | undefined;
    failMove?: (source: string, destination: string) => Error | undefined;
    failRemove?: (path: string) => Error | undefined;
  } = {}
): ServerDataRestorePromotionOperations {
  return {
    async createDirectory(path) {
      await mkdir(path, { recursive: true });
    },
    async listNames(path) {
      const failure = input.failList?.(path);
      if (failure) throw failure;
      return readdir(path);
    },
    async move(source, destination) {
      const failure = input.failMove?.(source, destination);
      if (failure) throw failure;
      await rename(source, destination);
    },
    async remove(path) {
      const failure = input.failRemove?.(path);
      if (failure) throw failure;
      await rm(path, { recursive: true, force: true });
    }
  };
}

async function expectOriginalTarget(target: string): Promise<void> {
  await expect(readFile(join(target, "old-a.txt"), "utf8")).resolves.toBe("old-a");
  await expect(readFile(join(target, "old-b.txt"), "utf8")).resolves.toBe("old-b");
  await expect(readFile(join(target, "new-a.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT"
  });
}

describe("server data restore promotion", () => {
  it("restores entries already moved when original backup preparation fails", async () => {
    const { target, staging } = await fixture();
    const failure = new Error("backup-second-entry-failed");
    await expect(
      promoteRestoredDirectory(
        target,
        staging,
        operations({
          failMove(source, destination) {
            return basename(source) === "old-b.txt" &&
              basename(dirname(destination)).startsWith(".planweave-server-replaced-")
              ? failure
              : undefined;
          }
        })
      )
    ).rejects.toMatchObject({
      code: "server_data_restore_backup_prepare_failed",
      cause: failure
    });
    await expectOriginalTarget(target);
  });

  it("removes promoted entries and restores the backup when staging promotion fails", async () => {
    const { target, staging } = await fixture();
    const failure = new Error("staging-second-entry-failed");
    await expect(
      promoteRestoredDirectory(
        target,
        staging,
        operations({
          failMove(source) {
            return dirname(source) === staging && basename(source) === "new-b.txt"
              ? failure
              : undefined;
          }
        })
      )
    ).rejects.toMatchObject({ code: "server_data_restore_promotion_failed", cause: failure });
    await expectOriginalTarget(target);
  });

  it("aggregates rollback failures instead of hiding them", async () => {
    const { target, staging } = await fixture();
    const promotionFailure = new Error("staging-promotion-failed");
    const rollbackFailure = new Error("backup-restore-failed");
    let promotionFailed = false;
    let caught: unknown;
    try {
      await promoteRestoredDirectory(
        target,
        staging,
        operations({
          failMove(source, destination) {
            if (dirname(source) === staging && basename(source) === "new-b.txt") {
              promotionFailed = true;
              return promotionFailure;
            }
            if (
              promotionFailed &&
              basename(dirname(source)).startsWith(".planweave-server-replaced-") &&
              destination === join(target, "old-a.txt")
            ) {
              return rollbackFailure;
            }
            return undefined;
          }
        })
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerDataArchiveError);
    expect(caught).toMatchObject({ code: "server_data_restore_promotion_failed" });
    if (!(caught instanceof ServerDataArchiveError) || !caught.diagnostic?.backup)
      throw new Error("missing diagnostic");
    expect(caught.diagnostic.outcome).toBe("rollback_failed");
    expect(await readFile(join(caught.diagnostic.backup, "old-a.txt"), "utf8")).toBe("old-a");
    const cause = caught.cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([promotionFailure, rollbackFailure]);
  });

  it("does not roll back committed data when backup cleanup fails", async () => {
    const { target, staging } = await fixture();
    const cleanupFailure = new Error("backup-cleanup-failed");
    await expect(
      promoteRestoredDirectory(
        target,
        staging,
        operations({
          failRemove(path) {
            return basename(path).startsWith(".planweave-server-replaced-")
              ? cleanupFailure
              : undefined;
          }
        })
      )
    ).rejects.toMatchObject({
      code: "server_data_restore_committed_cleanup_failed",
      diagnostic: { phase: "cleanup", outcome: "committed", target, staging },
      cause: cleanupFailure
    });
    await expect(readFile(join(target, "new-a.txt"), "utf8")).resolves.toBe("new-a");
    await expect(readFile(join(target, "new-b.txt"), "utf8")).resolves.toBe("new-b");
    await expect(readFile(join(target, "old-a.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("restore fault matrix", () => {
  it.each(["backup-first", "staging-first", "staging-list"])("rolls back %s", async (fault) => {
    const { target, staging } = await fixture();
    await expect(
      promoteRestoredDirectory(
        target,
        staging,
        operations({
          failList: (path) =>
            fault === "staging-list" && path === staging ? new Error(fault) : undefined,
          failMove: (source, destination) =>
            (fault === "backup-first" &&
              basename(source) === "old-a.txt" &&
              dirname(destination) !== target) ||
            (fault === "staging-first" && dirname(source) === staging)
              ? new Error(fault)
              : undefined
        })
      )
    ).rejects.toMatchObject({ diagnostic: { outcome: "not_committed", target, staging } });
    await expectOriginalTarget(target);
    expect((await readdir(target)).sort()).toEqual([".staging", "old-a.txt", "old-b.txt"]);
  });

  it("keeps original copies when removing a promoted same-name file fails", async () => {
    const { target, staging } = await fixture();
    await writeFile(join(staging, "old-a.txt"), "replacement");
    await writeFile(join(staging, "z-last.txt"), "last");
    let caught: unknown;
    try {
      await promoteRestoredDirectory(
        target,
        staging,
        operations({
          failMove: (source) =>
            basename(source) === "z-last.txt" ? new Error("move failed") : undefined,
          failRemove: (path) =>
            path === join(target, "old-a.txt") ? new Error("remove failed") : undefined
        })
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      diagnostic: { outcome: "rollback_failed", phase: "promotion" }
    });
    if (!(caught instanceof ServerDataArchiveError) || !caught.diagnostic?.backup)
      throw new Error("missing diagnostic");
    expect(await readFile(join(caught.diagnostic.backup, "old-a.txt"), "utf8")).toBe("old-a");
    expect(await readFile(join(target, "old-a.txt"), "utf8")).toBe("replacement");
  });
});
