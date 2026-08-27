import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePackageSnapshot,
  packageSnapshotSourceRevision,
  restorePackageSnapshot
} from "../package/packageSnapshot.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package snapshots", () => {
  it("captures a non-persistent path envelope and restores the package atomically", async () => {
    const { root, init } = await createTestWorkspace();
    roots.push(root);
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const capturedAgain = await capturePackageSnapshot({ projectRoot: root });
    expect(captured.snapshot).not.toHaveProperty("packageDir");
    expect(capturedAgain.snapshot.sourceRevision).toBe(captured.snapshot.sourceRevision);
    expect(packageSnapshotSourceRevision(captured.snapshot.digestManifest)).toBe(
      captured.snapshot.sourceRevision
    );
    expect(captured.resolvedPackageDir).toBe(init.workspace.packageDir);
    await writeFile(init.workspace.manifestFile, "{}", "utf8");
    await restorePackageSnapshot({
      projectRoot: root,
      expectedPackageDir: init.workspace.packageDir,
      snapshot: captured.snapshot
    });
    expect(JSON.parse(await readFile(init.workspace.manifestFile, "utf8")).project.title).toBe(
      "Test Plan"
    );
  });

  it("rolls back a failed package replacement without touching the original", async () => {
    const { root, init } = await createTestWorkspace();
    roots.push(root);
    const captured = await capturePackageSnapshot({ projectRoot: root });
    vi.spyOn(ImportTransaction.prototype, "commit").mockRejectedValue(new Error("commit-failure"));
    await expect(
      restorePackageSnapshot({
        projectRoot: root,
        expectedPackageDir: init.workspace.packageDir,
        snapshot: captured.snapshot
      })
    ).rejects.toThrow("commit-failure");
    expect(JSON.parse(await readFile(init.workspace.manifestFile, "utf8")).project.title).toBe(
      "Test Plan"
    );
  });

  it("runs the before-commit fence after staged validation and preserves the original on failure", async () => {
    const { root, init } = await createTestWorkspace();
    roots.push(root);
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const beforeCommit = vi.fn(() => {
      throw new Error("before-commit-failure");
    });
    await expect(
      restorePackageSnapshot({
        projectRoot: root,
        expectedPackageDir: init.workspace.packageDir,
        snapshot: captured.snapshot,
        beforeCommit
      })
    ).rejects.toThrow("before-commit-failure");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(init.workspace.manifestFile, "utf8")).project.title).toBe(
      "Test Plan"
    );
  });
});
