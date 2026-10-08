import * as runtime from "@planweave-ai/runtime";
import { join } from "node:path";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../canvas/localFilesystemRuntimeAdapter.js";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backingPath } from "../packageSnapshotBacking.js";
import { enforcePackageSnapshotRetention } from "../packageSnapshotRetention.js";
import { packageSnapshotFixture } from "./packageSnapshotFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: vi.fn((await importOriginal<typeof import("node:fs/promises")>()).rm)
}));

const fixtures: Awaited<ReturnType<typeof packageSnapshotFixture>>[] = [];
const at = "2026-01-02T00:00:00.000Z";
const scope = {
  workspaceId: "w",
  projectId: "p",
  canvasId: "default",
  actor: { kind: "human", id: "owner" } as const,
  expectedAclRevision: 0
};

afterEach(async () => {
  vi.mocked(fs.rm).mockReset();
  vi.mocked(fs.rm).mockImplementation(
    (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm
  );
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await Promise.all(
      [fixture.workspace.home, fixture.workspace.root].map((path) =>
        fs.rm(path, { recursive: true, force: true })
      )
    );
  }
});

async function fixture(
  onRetentionCleanupError?: (error: unknown, canvasRegistryId: string) => void
) {
  const value = await packageSnapshotFixture(onRetentionCleanupError);
  fixtures.push(value);
  const created = await value.snapshots.create(scope);
  const id = created.snapshot.immutable.snapshotId;
  const row = value.database
    .prepare("SELECT * FROM package_snapshots WHERE snapshot_id=?")
    .get(id)!;
  const columns = Object.keys(row);
  let sequence = 0;
  return {
    ...value,
    id,
    canvas: created.snapshot.immutable.registry.canvasRegistryId,
    data: `${value.workspace.root}/snapshot-data`,
    add(count: number, overrides: Record<string, unknown> = {}) {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const snapshotId = `snapshot-${(++sequence).toString(16).padStart(32, "0")}`;
        const next = {
          ...row,
          snapshot_id: snapshotId,
          source_revision: `revision-${sequence}`,
          ...overrides
        };
        value.database
          .prepare(
            `INSERT INTO package_snapshots (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
          )
          .run(...columns.map((column) => next[column]));
        ids.push(snapshotId);
      }
      return ids;
    }
  };
}

describe("package snapshot retention", () => {
  it("pins the 257th snapshot without assigning an out-of-window rank", async () => {
    const f = await fixture();
    f.database
      .prepare("UPDATE package_snapshots SET restore_marker='restore_pending' WHERE snapshot_id=?")
      .run(f.id);
    f.add(256);
    const remove = vi.mocked(fs.rm).mockClear().mockResolvedValue();
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(f.snapshots.read({ ...scope, snapshotId: f.id }).mutable).toMatchObject({
      state: "available",
      restoreMarker: "restore_pending",
      retentionOrder: null
    });
    expect(remove).not.toHaveBeenCalled();
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count, MAX(retention_order) AS maximum FROM package_snapshots WHERE retention_order IS NOT NULL AND state='available'"
        )
        .get()
    ).toEqual({ count: 256, maximum: 256 });
  });

  it("passes multiple batches of pinned rows, isolates canvases, and revisits released pins", async () => {
    const f = await fixture();
    f.database
      .prepare("UPDATE package_snapshots SET restore_marker='restore_pending' WHERE snapshot_id=?")
      .run(f.id);
    const pinned = f.add(270, { restore_marker: "restore_pending" });
    const reclaimable = f.add(2);
    f.add(256);
    const other = f.access.registry.canvasInternal("w", "p", "other")!;
    const [otherId] = f.add(1, { canvas_registry_id: other.canvasRegistryId, canvas_id: "other" });
    const [oldRevoked] = f.add(1, {
      state: "revoked",
      revoked_at: at,
      restore_marker: "restore_pending"
    });
    const remove = vi.mocked(fs.rm).mockClear().mockResolvedValue();
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    for (const id of reclaimable)
      expect(remove).toHaveBeenCalledWith(backingPath(f.data, id), {
        recursive: true,
        force: true
      });
    for (const id of [f.id, ...pinned, otherId, oldRevoked])
      expect(remove).not.toHaveBeenCalledWith(backingPath(f.data, id), expect.anything());
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
        )
        .get(f.canvas)
    ).toEqual({ count: 527 });
    f.database
      .prepare(
        "UPDATE package_snapshots SET restore_marker='none' WHERE canvas_registry_id=? AND state='available'"
      )
      .run(f.canvas);
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
        )
        .get(f.canvas)
    ).toEqual({ count: 256 });
    expect(remove).not.toHaveBeenCalledWith(backingPath(f.data, oldRevoked), expect.anything());
  });

  it("does not delete backing when the conditional revocation does not take ownership", async () => {
    const f = await fixture();
    f.add(256);
    f.database.exec(
      "CREATE TRIGGER reject_retention BEFORE UPDATE OF state ON package_snapshots WHEN NEW.state='revoked' BEGIN SELECT RAISE(IGNORE); END;"
    );
    const remove = vi.mocked(fs.rm).mockClear().mockResolvedValue();
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(f.snapshots.read({ ...scope, snapshotId: f.id }).mutable.state).toBe("available");
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports post-restore cleanup failure without reversing success and retries revoked backing", async () => {
    const diagnose = vi.fn();
    const f = await fixture(diagnose);
    vi.spyOn(runtime, "restorePackageSnapshot").mockImplementation(async () => {
      f.add(256);
    });
    const diskError = new Error("disk unavailable");
    const remove = vi.mocked(fs.rm).mockClear().mockRejectedValue(diskError);
    await expect(f.snapshots.restore({ ...scope, snapshotId: f.id })).resolves.toMatchObject({
      outcome: "restored",
      detail: null
    });
    expect(f.snapshots.read({ ...scope, snapshotId: f.id }).mutable).toMatchObject({
      state: "revoked",
      restoreMarker: "restore_complete"
    });
    expect(diagnose).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "snapshot_retention_cleanup_failed",
        errors: [diskError]
      }),
      f.canvas
    );
    await expect(fs.stat(`${backingPath(f.data, f.id)}/package.json`)).resolves.toBeDefined();
    expect(
      f.database
        .prepare("SELECT backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?")
        .get(f.id)
    ).toEqual({ backing_cleanup_completed_at: null });
    remove.mockImplementation(
      (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm
    );
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    await expect(fs.stat(`${backingPath(f.data, f.id)}/package.json`)).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(
      f.database
        .prepare("SELECT backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?")
        .get(f.id)
    ).toEqual({ backing_cleanup_completed_at: at });
  });

  it.each([
    {
      name: "runtime unavailable",
      error: new Error("canvas_runtime_unavailable"),
      detail: "canvas_runtime_unavailable",
      outcome: "conflict",
      pending: false
    },
    {
      name: "runtime failure",
      error: new Error("restore-failure"),
      detail: "snapshot_restore_failed",
      outcome: "malformed",
      pending: false
    },
    {
      name: "uncertain rollback",
      error: new AggregateError([new Error("rollback failed")], "restore-failure"),
      detail: "snapshot_restore_recovery_required",
      outcome: "malformed",
      pending: true
    },
    {
      name: "marker release conflict",
      error: new Error("restore-failure"),
      detail: "snapshot_restore_recovery_required",
      outcome: "malformed",
      pending: true
    }
  ])("only compensates a safely released marker after $name", async ({
    name,
    error,
    detail,
    outcome,
    pending
  }) => {
    const f = await fixture();
    vi.spyOn(runtime, "restorePackageSnapshot").mockImplementation(async () => {
      f.add(256);
      if (name === "marker release conflict")
        f.database.exec(
          "CREATE TRIGGER reject_release BEFORE UPDATE OF restore_marker ON package_snapshots WHEN NEW.restore_marker='none' BEGIN SELECT RAISE(IGNORE); END;"
        );
      throw error;
    });
    const remove = vi.mocked(fs.rm).mockClear().mockResolvedValue();
    await expect(f.snapshots.restore({ ...scope, snapshotId: f.id })).resolves.toMatchObject({
      outcome,
      detail
    });
    expect(f.snapshots.read({ ...scope, snapshotId: f.id }).mutable).toMatchObject({
      state: pending ? "available" : "revoked",
      restoreMarker: pending ? "restore_pending" : "none"
    });
    if (pending) {
      await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
      expect(remove).not.toHaveBeenCalled();
    } else {
      expect(remove).toHaveBeenCalledExactlyOnceWith(backingPath(f.data, f.id), {
        recursive: true,
        force: true
      });
    }
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS count FROM package_snapshots WHERE state='available'")
        .get()
    ).toEqual({ count: pending ? 257 : 256 });
  });

  it("limits each maintenance to 256 backing attempts and persists successful cleanup", async () => {
    const f = await fixture();
    const revoked = f.add(600, { state: "revoked", revoked_at: at });
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const firstBacking = backingPath(f.data, revoked[0]!);
    await fs.mkdir(firstBacking, { recursive: true });
    await fs.writeFile(join(firstBacking, "package.json"), "audit backing");
    const remove = vi.mocked(fs.rm).mockClear().mockImplementation(actualFs.rm);
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(remove).toHaveBeenCalledTimes(256);
    await expect(fs.stat(firstBacking)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 256 });
    remove.mockClear();
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(remove).toHaveBeenCalledTimes(256);
    expect(remove).not.toHaveBeenCalledWith(firstBacking, expect.anything());
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 512 });
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE state='revoked' AND backing_cleanup_completed_at IS NULL"
        )
        .get()
    ).toEqual({ count: 0 });
    remove.mockClear();
    await enforcePackageSnapshotRetention(f.database, f.data, f.canvas, at);
    expect(remove).not.toHaveBeenCalled();
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("real snapshot restore and retention interleaving", () => {
  it.each([
    "success",
    "failure",
    "acl",
    "uncertain",
    "cleanup failure"
  ] as const)("preserves backing until real restore settles: %s", async (mode) => {
    const diagnose = vi.fn();
    const f = await packageSnapshotFixture(diagnose);
    fixtures.push(f);
    const data = join(f.workspace.root, "snapshot-data");
    const prompt = join(f.workspace.init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    let oldest = "";
    let canvas = "";
    for (let revision = 0; revision < 256; revision++) {
      await fs.writeFile(prompt, `# real revision ${revision}\n`, "utf8");
      const created = await f.snapshots.create(scope);
      if (revision === 0) {
        oldest = created.snapshot.immutable.snapshotId;
        canvas = created.snapshot.immutable.registry.canvasRegistryId;
      }
    }
    const capturePackageDir = join(f.workspace.root, "retention-capture-package");
    await fs.cp(f.workspace.init.workspace.packageDir, capturePackageDir, { recursive: true });
    await fs.writeFile(join(capturePackageDir, "nodes/T-001/prompt.md"), "# real revision 256\n");
    const captureWorkspace = {
      ...f.workspace.init.workspace,
      packageDir: capturePackageDir,
      manifestFile: join(capturePackageDir, "manifest.json")
    };
    // Retention publication can consume an independent complete capture while restore owns its target lock.
    const publishing = new PackageSnapshotRepository(
      f.database,
      f.access,
      data,
      {
        ...createLocalFilesystemCanvasRuntimeAdapter({
          resolveExactCanvasLocation: () => ({
            workspaceId: "w",
            projectId: "p",
            canvasId: "default",
            projectRoot: f.workspace.root,
            packageDir: f.workspace.init.workspace.packageDir
          })
        }),
        captureSnapshot: async () =>
          (await runtime.capturePackageSnapshot({ projectRoot: captureWorkspace })).snapshot
      },
      () => new Date(at),
      diagnose
    );
    const oldBacking = join(backingPath(data, oldest), "package.json");
    const originalBacking = await fs.readFile(oldBacking, "utf8");
    const entered = barrier();
    const release = barrier();
    const restore = runtime.restorePackageSnapshot;
    vi.spyOn(runtime, "restorePackageSnapshot").mockImplementation((input) =>
      restore({
        ...input,
        beforeCommit: async () => {
          entered.release();
          await release.promise;
          await input.beforeCommit?.();
          if (mode === "failure" || mode === "uncertain")
            throw new Error("controlled restore failure");
        }
      })
    );
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const diskError = new Error("controlled backing deletion failure");
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (mode === "cleanup failure" && String(path) === backingPath(data, oldest)) throw diskError;
      if (mode === "uncertain" && String(path).includes(".planweave-snapshot-"))
        throw new Error("controlled staging cleanup failure");
      await actualFs.rm(path, options);
    });
    const pending = f.snapshots.restore({ ...scope, snapshotId: oldest });
    try {
      await entered.promise;
      expect(f.snapshots.read({ ...scope, snapshotId: oldest }).mutable).toMatchObject({
        state: "available",
        restoreMarker: "restore_pending"
      });
      await fs.writeFile(prompt, "# real revision 256\n", "utf8");
      const newest = await publishing.create(scope);
      expect(newest.snapshot.immutable.snapshotId).not.toBe(oldest);
      expect(f.snapshots.read({ ...scope, snapshotId: oldest }).mutable).toMatchObject({
        state: "available",
        restoreMarker: "restore_pending",
        retentionOrder: null
      });
      expect(await fs.readFile(oldBacking, "utf8")).toBe(originalBacking);
      expect(
        f.database
          .prepare(
            "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
          )
          .get(canvas)
      ).toEqual({ count: 257 });
      // Repeat retention while the same restore owns its marker.
      await enforcePackageSnapshotRetention(f.database, data, canvas, at);
      expect(await fs.readFile(oldBacking, "utf8")).toBe(originalBacking);

      if (mode === "success") {
        const other = await runtime.createTaskCanvas(f.workspace.root, {
          name: "Other retention scope"
        });
        const otherWorkspace = await runtime.resolveTaskCanvasWorkspace(
          f.workspace.root,
          other.canvasId
        );
        f.access.registerCanvasInternal({
          workspaceId: "w",
          projectId: "p",
          canvasId: other.canvasId,
          packageDir: otherWorkspace.packageDir,
          visibility: "shared",
          ownerHumanPrincipalId: "owner"
        });
        f.access.markCanvasCutover("w", "p", other.canvasId);
        const otherSnapshots = new PackageSnapshotRepository(
          f.database,
          f.access,
          data,
          createLocalFilesystemCanvasRuntimeAdapter({
            resolveExactCanvasLocation(otherScope) {
              return {
                ...otherScope,
                projectRoot: f.workspace.root,
                packageDir: otherWorkspace.packageDir
              };
            }
          })
        );
        const otherSnapshot = await otherSnapshots.create({ ...scope, canvasId: other.canvasId });
        await enforcePackageSnapshotRetention(f.database, data, canvas, at);
        await expect(
          fs.readFile(
            join(backingPath(data, otherSnapshot.snapshot.immutable.snapshotId), "package.json"),
            "utf8"
          )
        ).resolves.toContain('"files"');
        expect(
          otherSnapshots.read({
            ...scope,
            canvasId: other.canvasId,
            snapshotId: otherSnapshot.snapshot.immutable.snapshotId
          }).mutable.state
        ).toBe("available");
      }
      if (mode === "acl")
        f.database
          .prepare(
            "UPDATE canvas_registry SET acl_revision=acl_revision+1 WHERE canvas_registry_id=?"
          )
          .run(canvas);
      release.release();
      const result = await pending;
      expect(result).toMatchObject(
        mode === "success" || mode === "cleanup failure"
          ? { outcome: "restored", detail: null }
          : mode === "acl"
            ? { outcome: "conflict", detail: "stale_acl_revision" }
            : {
                outcome: "malformed",
                detail:
                  mode === "uncertain"
                    ? "snapshot_restore_recovery_required"
                    : "snapshot_restore_failed"
              }
      );
      expect(await fs.readFile(prompt, "utf8")).toBe(
        mode === "success" || mode === "cleanup failure"
          ? "# real revision 0\n"
          : "# real revision 256\n"
      );
      const row = f.database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(oldest);
      expect(row).toEqual({
        state: mode === "uncertain" ? "available" : "revoked",
        restore_marker:
          mode === "uncertain"
            ? "restore_pending"
            : mode === "success" || mode === "cleanup failure"
              ? "restore_complete"
              : "none"
      });
      expect(
        f.database
          .prepare(
            "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
          )
          .get(canvas)
      ).toEqual({ count: mode === "uncertain" ? 257 : 256 });
      if (mode === "uncertain") {
        await enforcePackageSnapshotRetention(f.database, data, canvas, at);
        expect(await fs.readFile(oldBacking, "utf8")).toBe(originalBacking);
      } else if (mode === "cleanup failure") {
        expect(diagnose).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            message: "snapshot_retention_cleanup_failed",
            errors: [diskError]
          }),
          canvas
        );
        expect(await fs.readFile(oldBacking, "utf8")).toBe(originalBacking);
        vi.mocked(fs.rm).mockImplementation(actualFs.rm);
        await enforcePackageSnapshotRetention(f.database, data, canvas, at);
        await expect(fs.stat(oldBacking)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(diagnose).not.toHaveBeenCalled();
        await expect(fs.stat(oldBacking)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      release.release();
      await pending;
      vi.mocked(fs.rm).mockImplementation(actualFs.rm);
    }
  }, 20_000);
});
