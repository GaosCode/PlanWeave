import * as fs from "node:fs/promises";
import nativeFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../canvas/localFilesystemRuntimeAdapter.js";
const hooks = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  after: undefined as (() => Promise<void>) | undefined
}));
vi.mock("@planweave-ai/runtime", async (original) => {
  const actual = await original<typeof import("@planweave-ai/runtime")>();
  return {
    ...actual,
    readAuthorizedCanvasRuntimeStatus: async (
      ...args: Parameters<typeof actual.readAuthorizedCanvasRuntimeStatus>
    ) => {
      await hooks.before?.();
      const result = await actual.readAuthorizedCanvasRuntimeStatus(...args);
      await hooks.after?.();
      return result;
    }
  };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.before = hooks.after = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
it("rejects status from the intermediate version during a real filesystem ABA", async () => {
  vi.stubEnv("PLANWEAVE_HOME", process.env.PLANWEAVE_HOME ?? "");
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE ?? "");
  const f = await createTestWorkspace();
  roots.push(f.root, f.home);
  const path = f.init.workspace.manifestFile;
  const before = await readFile(path, "utf8");
  const manifest = JSON.parse(before);
  manifest.project.title = "intermediate version";
  hooks.before = () => writeFile(path, JSON.stringify(manifest));
  hooks.after = () => writeFile(path, before);
  const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
  const adapter = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation: () => ({
      ...scope,
      projectRoot: f.root,
      packageDir: f.init.workspace.packageDir
    })
  });
  await expect(adapter.readAvailability(scope, "2026-01-01T00:00:00.000Z")).resolves.toMatchObject({
    kind: "unavailable",
    reason: "content_out_of_sync"
  });
  expect(await readFile(path, "utf8")).toBe(before);
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => {
      if (!process.env.PLANWEAVE_HOME) throw new Error("Expected isolated test home.");
      return { ...actual.userInfo(), homedir: process.env.PLANWEAVE_HOME };
    }
  };
});
it.each([
  "parse",
  "unknown",
  "permission"
] as const)("does not turn %s failures into content drift", async (mode) => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const originalStat = nativeFs.stat;
  vi.mocked(fs.stat).mockImplementation(originalStat);
  const f = await createTestWorkspace();
  roots.push(f.root, f.home);
  const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
  const adapter = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation: () => ({
      ...scope,
      projectRoot: f.root,
      packageDir: f.init.workspace.packageDir
    })
  });
  const prompt = join(f.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md");
  const state = await actual.readFile(f.init.workspace.stateFile, "utf8");
  const error =
    mode === "permission"
      ? Object.assign(new Error("permission denied"), { code: "EACCES" })
      : new Error("package_snapshot_conflict:untyped_unknown");
  if (mode === "parse") await actual.writeFile(f.init.workspace.manifestFile, "{broken");
  else {
    let reads = 0;
    vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (
        String(args[0]) === prompt &&
        typeof args[1] === "object" &&
        args[1]?.bigint &&
        ++reads === 2
      )
        throw error;
      return Reflect.apply(originalStat, actual, args);
    });
  }
  try {
    const controlledStat = vi.mocked(fs.stat).getMockImplementation();
    if (!controlledStat) throw new Error("Expected controlled filesystem boundary.");
    nativeFs.stat = controlledStat;
    syncBuiltinESMExports();
    const pending = adapter.readAvailability(scope, "2026-01-01T00:00:00.000Z");
    if (mode === "permission")
      await expect(pending).resolves.toMatchObject({
        kind: "unavailable",
        reason: "runtime_not_attached"
      });
    else if (mode === "parse") await expect(pending).rejects.toBeInstanceOf(SyntaxError);
    else await expect(pending).rejects.toBe(error);
    expect(await actual.readFile(f.init.workspace.stateFile, "utf8")).toBe(state);
  } finally {
    nativeFs.stat = originalStat;
    syncBuiltinESMExports();
    vi.mocked(fs.stat).mockImplementation(originalStat);
  }
});
