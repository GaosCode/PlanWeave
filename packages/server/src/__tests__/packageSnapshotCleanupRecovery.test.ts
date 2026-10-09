import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backingPath } from "../packageSnapshotBacking.js";
import { SnapshotProcessHarness } from "./support/packageSnapshotProcessHarness.js";
import {
  recoveryAt,
  recoveryScope,
  snapshotRecoveryFixture
} from "./support/packageSnapshotRecoveryFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: vi.fn((await importOriginal<typeof import("node:fs/promises")>()).rm)
}));
const fixtures: Awaited<ReturnType<typeof snapshotRecoveryFixture>>[] = [];
const children: SnapshotProcessHarness[] = [];
const permissions: string[] = [];
async function fixture() {
  const f = await snapshotRecoveryFixture();
  fixtures.push(f);
  return f;
}
function child(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: "cleanup" | "hold-cleanup" | "hold-restore",
  id = f.id
) {
  const process = new SnapshotProcessHarness({
    file: f.file,
    data: f.data,
    canvas: f.canvas,
    id,
    location: f.location,
    mode
  });
  children.push(process);
  return process;
}
function row(f: Awaited<ReturnType<typeof fixture>>, id: string = f.id) {
  return f.database
    .prepare(
      "SELECT state,restore_marker,backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?"
    )
    .get(id);
}
function completed(f: Awaited<ReturnType<typeof fixture>>) {
  return Number(
    f.database
      .prepare(
        "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NOT NULL"
      )
      .get()!.count
  );
}
afterEach(async () => {
  for (const process of children.splice(0)) await process.dispose();
  for (const path of permissions.splice(0)) await fs.chmod(path, 0o700);
  vi.mocked(fs.rm).mockImplementation(
    (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm
  );
  for (const f of fixtures.splice(0)) {
    f.database.close();
    await Promise.all(
      [f.workspace.root, f.workspace.home].map((path) =>
        fs.rm(path, { recursive: true, force: true })
      )
    );
  }
});

describe("durable snapshot cleanup recovery", () => {
  it("reopens after real removal succeeds but the completion write fails, preserving immutable audit metadata", async () => {
    const f = await fixture();
    const immutable = f.snapshots.read({ ...recoveryScope, snapshotId: f.id }).immutable;
    f.database.exec(`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE OF backing_cleanup_completed_at ON package_snapshots
      WHEN NEW.backing_cleanup_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'completion write interrupted'); END;`);
    await expect(f.snapshots.revoke({ ...recoveryScope, snapshotId: f.id })).rejects.toThrow(
      "completion write interrupted"
    );
    await expect(fs.stat(backingPath(f.data, f.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(row(f)).toMatchObject({ state: "revoked", backing_cleanup_completed_at: null });
    await f.reopen();
    expect(row(f)).toMatchObject({ state: "revoked", backing_cleanup_completed_at: null });
    f.database.exec("DROP TRIGGER fail_cleanup_completion");
    await f.snapshots.recoverBackingCleanup();
    expect(row(f)).toMatchObject({ backing_cleanup_completed_at: recoveryAt });
    expect(f.snapshots.read({ ...recoveryScope, snapshotId: f.id }).immutable).toEqual(immutable);
    const remove = vi.mocked(fs.rm).mockClear();
    await f.snapshots.recoverBackingCleanup();
    await f.snapshots.revoke({ ...recoveryScope, snapshotId: f.id });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    "create",
    "restore"
  ] as const)("propagates real completion database failures after %s instead of diagnosing success", async (operation) => {
    const f = await fixture();
    const [pending] = f.add(1, { state: "revoked", revoked_at: recoveryAt });
    f.database.exec(`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE OF backing_cleanup_completed_at ON package_snapshots
      WHEN NEW.snapshot_id='${pending}' AND NEW.backing_cleanup_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'maintenance completion interrupted'); END;`);
    const failure = await (operation === "create"
      ? f.snapshots.create(recoveryScope)
      : f.snapshots.restore({ ...recoveryScope, snapshotId: f.id })
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContainEqual(
      expect.objectContaining({ message: "maintenance completion interrupted" })
    );
    expect(row(f, pending)).toMatchObject({ state: "revoked", backing_cleanup_completed_at: null });
    if (operation === "restore") expect(row(f)?.restore_marker).toBe("restore_complete");
    f.database.exec("DROP TRIGGER fail_cleanup_completion");
    await f.snapshots.recoverBackingCleanup();
    expect(row(f, pending)?.backing_cleanup_completed_at).toBe(recoveryAt);
  });

  it("advances past a real persistent filesystem failure through 3000 rows across restarts, within 256 attempts per call", async () => {
    const f = await fixture();
    const backing = backingPath(f.data, f.id);
    await fs.chmod(backing, 0o500);
    permissions.push(backing);
    await expect(f.snapshots.revoke({ ...recoveryScope, snapshotId: f.id })).rejects.toMatchObject({
      snapshotId: f.id,
      canvasRegistryId: f.canvas,
      cause: { code: "EACCES" }
    });
    await expect(fs.stat(join(backing, "package.json"))).resolves.toBeDefined();
    const historical = f.add(3000, { state: "revoked", revoked_at: recoveryAt });
    await Promise.all(
      historical.slice(0, 600).map(async (id) => {
        const target = backingPath(f.data, id);
        await fs.mkdir(target, { recursive: true });
        await fs.copyFile(join(backing, "package.json"), join(target, "package.json"));
      })
    );
    const latest = f.add(256);
    let previous = 0;
    for (let batch = 0; batch < 12; batch++) {
      const remove = vi.mocked(fs.rm).mockClear();
      await f.snapshots.recoverBackingCleanup();
      const total = completed(f);
      expect(remove.mock.calls.length).toBeLessThanOrEqual(256);
      expect(total - previous).toBeGreaterThan(0);
      expect(total - previous).toBeLessThanOrEqual(256);
      previous = total;
      await f.reopen();
    }
    expect(completed(f)).toBe(3000);
    await expect(fs.stat(backingPath(f.data, historical[599]!))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(row(f)).toMatchObject({ state: "revoked", backing_cleanup_completed_at: null });
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM package_snapshots WHERE state='available'")
        .get()
    ).toEqual({ count: 256 });
    expect(latest.every((id) => row(f, id)?.state === "available")).toBe(true);
    await fs.chmod(backing, 0o700);
    permissions.splice(permissions.indexOf(backing), 1);
    const remove = vi.mocked(fs.rm).mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(row(f)).toMatchObject({ backing_cleanup_completed_at: recoveryAt });
    await expect(fs.stat(backing)).rejects.toMatchObject({ code: "ENOENT" });
    remove.mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).not.toHaveBeenCalled();
  });

  it("protects a real restore pin in another process while retention crosses the latest-256 boundary", async () => {
    const f = await fixture();
    const prompt = join(f.location.packageDir, "nodes/T-001/prompt.md");
    const original = await fs.readFile(prompt, "utf8");
    await fs.writeFile(prompt, "# current package before restore\n");
    const restore = child(f, "hold-restore");
    await restore.waitFor("held");
    expect(row(f)).toMatchObject({ state: "available", restore_marker: "restore_pending" });
    f.add(256);
    const cleanup = child(f, "cleanup");
    await cleanup.waitFor("done");
    expect(row(f)).toMatchObject({
      state: "available",
      restore_marker: "restore_pending",
      backing_cleanup_completed_at: null
    });
    await expect(fs.stat(join(backingPath(f.data, f.id), "package.json"))).resolves.toBeDefined();
    await expect(f.snapshots.revoke({ ...recoveryScope, snapshotId: f.id })).rejects.toThrow(
      "snapshot_restore_pending"
    );
    restore.release();
    expect((await restore.waitFor("done")).result).toMatchObject({ outcome: "restored" });
    expect(await fs.readFile(prompt, "utf8")).toBe(original);
    expect(row(f)).toMatchObject({
      state: "revoked",
      restore_marker: "restore_complete",
      backing_cleanup_completed_at: recoveryAt
    });
    await expect(fs.stat(backingPath(f.data, f.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies a late restore after deletion qualification while real snapshot creation overlaps filesystem cleanup", async () => {
    const f = await fixture();
    f.database
      .prepare("UPDATE package_snapshots SET state='revoked',revoked_at=? WHERE snapshot_id=?")
      .run(recoveryAt, f.id);
    const cleanup = child(f, "hold-cleanup");
    await cleanup.waitFor("held");
    await expect(fs.stat(backingPath(f.data, f.id))).resolves.toBeDefined();
    await expect(
      f.snapshots.restore({ ...recoveryScope, snapshotId: f.id })
    ).resolves.toMatchObject({ outcome: "revoked" });
    expect(row(f)?.restore_marker).not.toBe("restore_pending");
    await fs.writeFile(
      join(f.location.packageDir, "nodes/T-001/prompt.md"),
      "# concurrently published revision\n"
    );
    const created = await f.snapshots.create(recoveryScope);
    const published = created.snapshot.immutable.snapshotId;
    expect(published).not.toBe(f.id);
    cleanup.release();
    await cleanup.waitFor("done");
    expect(row(f)).toMatchObject({ state: "revoked", backing_cleanup_completed_at: recoveryAt });
    expect(row(f, published)).toMatchObject({
      state: "available",
      backing_cleanup_completed_at: null
    });
    await expect(
      fs.stat(join(backingPath(f.data, published), "package.json"))
    ).resolves.toBeDefined();
  });

  it("shares a durable cursor across simultaneous cleanup processes without repeating the first in-flight batch", async () => {
    const f = await fixture();
    f.database
      .prepare("UPDATE package_snapshots SET state='revoked',revoked_at=? WHERE snapshot_id=?")
      .run(recoveryAt, f.id);
    const ids = f.add(600, { state: "revoked", revoked_at: recoveryAt });
    const laterBacking = backingPath(f.data, ids[300]!);
    await fs.mkdir(laterBacking, { recursive: true });
    await fs.writeFile(join(laterBacking, "package.json"), "later persisted backing");
    const first = child(f, "hold-cleanup");
    await first.waitFor("held");
    expect(completed(f)).toBe(0);
    const second = child(f, "cleanup");
    await second.waitFor("done");
    expect(completed(f)).toBe(256);
    expect(row(f)?.backing_cleanup_completed_at).toBeNull();
    await expect(fs.stat(laterBacking)).rejects.toMatchObject({ code: "ENOENT" });
    first.release();
    await first.waitFor("done");
    expect(completed(f)).toBe(512);
    await f.reopen();
    const remove = vi.mocked(fs.rm).mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).toHaveBeenCalledTimes(89);
    expect(completed(f)).toBe(601);
    remove.mockClear();
    await f.snapshots.recoverBackingCleanup();
    expect(remove).not.toHaveBeenCalled();
  });
});
