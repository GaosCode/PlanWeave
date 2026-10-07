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
