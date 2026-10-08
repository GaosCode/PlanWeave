import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backingPath } from "../packageSnapshotBacking.js";
import { packageSnapshotFixture } from "./packageSnapshotFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: vi.fn((await importOriginal<typeof import("node:fs/promises")>()).rm)
}));
const fixtures: Awaited<ReturnType<typeof packageSnapshotFixture>>[] = [];
const scope = {
  workspaceId: "w",
  projectId: "p",
  canvasId: "default",
  actor: { kind: "human", id: "owner" } as const,
  expectedAclRevision: 0
};
const at = "2026-01-02T00:00:00.000Z";

afterEach(async () => {
  vi.mocked(fs.rm).mockImplementation(
    (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm
  );
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await Promise.all(
      [fixture.workspace.root, fixture.workspace.home].map((path) =>
        fs.rm(path, { recursive: true, force: true })
      )
    );
  }
});

async function fixture() {
  const f = await packageSnapshotFixture();
  fixtures.push(f);
  const created = await f.snapshots.create(scope);
  const id = created.snapshot.immutable.snapshotId;
  const row = f.database.prepare("SELECT * FROM package_snapshots WHERE snapshot_id=?").get(id)!;
  const columns = Object.keys(row);
  let sequence = 0;
  const insert = f.database.prepare(
    `INSERT INTO package_snapshots(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
  );
  return {
    ...f,
    id,
    data: join(f.workspace.root, "snapshot-data"),
    canvas: created.snapshot.immutable.registry.canvasRegistryId,
    add(count: number, overrides: Record<string, unknown> = {}) {
      const ids = [];
      for (let index = 0; index < count; index++) {
        const id = `snapshot-${(++sequence).toString(16).padStart(32, "0")}`;
        const copy = {
          ...row,
          snapshot_id: id,
          source_revision: `revision-${sequence}`,
          ...overrides
        };
        insert.run(...columns.map((column) => copy[column]));
        ids.push(id);
      }
      return ids;
    }
  };
}

describe("snapshot backing maintenance entry points", () => {
  it("logically revokes the full old window even when physical cleanup has 600 candidates", async () => {
    const f = await fixture();
    f.add(600);
    f.add(256);
    const remove = vi.mocked(fs.rm).mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM package_snapshots WHERE state='available'")
        .get()
    ).toEqual({ count: 256 });
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE state='revoked' AND backing_cleanup_completed_at IS NULL"
        )
        .get()
    ).toEqual({ count: 345 });
    expect(remove).toHaveBeenCalledTimes(256);
    await expect(fs.stat(join(backingPath(f.data, f.id), "package.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("resumes a single total startup budget across canvases", async () => {
    const f = await fixture();
    f.add(300, { state: "revoked", revoked_at: at });
    const other = f.access.registry.canvasInternal("w", "p", "other")!;
    const second = f.add(300, {
      state: "revoked",
      revoked_at: at,
      canvas_registry_id: other.canvasRegistryId,
      canvas_id: "other"
    });
    const secondBacking = backingPath(f.data, second[0]!);
    await fs.mkdir(secondBacking, { recursive: true });
    await fs.writeFile(join(secondBacking, "package.json"), "other canvas audit backing");
    const remove = vi.mocked(fs.rm).mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).toHaveBeenCalledTimes(256);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 256 });
    await expect(fs.stat(secondBacking)).resolves.toBeDefined();
    remove.mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).toHaveBeenCalledTimes(256);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 512 });
    await expect(fs.stat(secondBacking)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records explicit revoke success and keeps a filesystem failure pending for retry", async () => {
    const f = await fixture();
    const backing = join(backingPath(f.data, f.id), "package.json");
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const remove = vi.mocked(fs.rm).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.snapshots.revoke({ ...scope, snapshotId: f.id })).rejects.toThrow(
      "disk unavailable"
    );
    expect(
      f.database
        .prepare(
          "SELECT state,backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?"
        )
        .get(f.id)
    ).toEqual({ state: "revoked", backing_cleanup_completed_at: null });
    await expect(fs.stat(backing)).resolves.toBeDefined();
    remove.mockImplementation(actualFs.rm);
    await f.snapshots.revoke({ ...scope, snapshotId: f.id });
    expect(
      f.database
        .prepare("SELECT backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?")
        .get(f.id)
    ).toEqual({ backing_cleanup_completed_at: at });
    await expect(fs.stat(backing)).rejects.toMatchObject({ code: "ENOENT" });
    remove.mockClear();
    await f.snapshots.revoke({ ...scope, snapshotId: f.id });
    expect(remove).not.toHaveBeenCalled();
  });
});
