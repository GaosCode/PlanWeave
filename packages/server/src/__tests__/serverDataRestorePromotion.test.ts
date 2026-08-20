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
    failMove?: (source: string, destination: string) => Error | undefined;
    failRemove?: (path: string) => Error | undefined;
  } = {}
): ServerDataRestorePromotionOperations {
  return {
    async createDirectory(path) {
      await mkdir(path, { recursive: true });
    },
    async listNames(path) {
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
    const cause = (caught as Error).cause;
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
      cause: cleanupFailure
    });
    await expect(readFile(join(target, "new-a.txt"), "utf8")).resolves.toBe("new-a");
    await expect(readFile(join(target, "new-b.txt"), "utf8")).resolves.toBe("new-b");
    await expect(readFile(join(target, "old-a.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
