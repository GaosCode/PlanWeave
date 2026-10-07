import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import {
  createLocalPackageAuthoritySource,
  createWorkspaceAuthorityBindingResolver
} from "../workspaceExecution/authorityBinding.js";
import { createLocalWorkspaceExecutionAdapter } from "../workspaceExecution/localExecutionAdapter.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const boundary = vi.hoisted(() => ({
  afterCapture: undefined as (() => Promise<void>) | undefined
}));
vi.mock("../package/packageSnapshot.js", async (original) => {
  const actual = await original<typeof import("../package/packageSnapshot.js")>();
  return {
    ...actual,
    capturePackageSnapshot: async (...args: Parameters<typeof actual.capturePackageSnapshot>) => {
      const result = await actual.capturePackageSnapshot(...args);
      await boundary.afterCapture?.();
      return result;
    }
  };
});
const roots: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
afterEach(async () => {
  boundary.afterCapture = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
});

async function fixture() {
  const context = await createTestWorkspace();
  roots.push(context.root, context.home);
  const captured = await capturePackageSnapshot({ projectRoot: context.init.workspace });
  const graph = await loadPlanGraphPackage(context.init.workspace);
  const expected = {
    contentRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint
  };
  const locator = { kind: "local_package" as const, packageWorkspace: context.root, expected };
  const scope = { kind: "block" as const, blockRef: "T-001#B-001" };
  const mutate = async () => {
    const manifest = JSON.parse(await readFile(context.init.workspace.manifestFile, "utf8"));
    manifest.project.title = "changed after capture";
    await writeFile(context.init.workspace.manifestFile, JSON.stringify(manifest));
  };
  return { context, expected, locator, scope, mutate };
}

describe("snapshot versions at authority and execution boundaries", () => {
  it("pairs local authority fingerprint with the exact captured bytes after a source mutation", async () => {
    const f = await fixture();
    boundary.afterCapture = async () => {
      boundary.afterCapture = undefined;
      await f.mutate();
    };
    const inspected = await createLocalPackageAuthoritySource().inspect(f.locator, f.scope);
    expect(inspected).toMatchObject(f.expected);
    expect(
      (await loadPlanGraphPackage(f.context.init.workspace)).graph.packageFingerprint
    ).not.toBe(inspected.graphFingerprint);
  });

  it("rejects content drift after binding before launching a local run", async () => {
    const f = await fixture();
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: { inspect: vi.fn() }
    });
    const binding = await resolver.resolve(f.locator, f.scope);
    await f.mutate();
    const run = vi.fn(async () => {
      throw new Error("unexpected_run_side_effect");
    });
    await expect(
      createLocalWorkspaceExecutionAdapter({ run }).launch({
        request: {
          authority: f.locator,
          scope: f.scope,
          trigger: "cli",
          target: { policy: "local" },
          eventFormat: "execution-v1"
        },
        binding
      })
    ).rejects.toMatchObject({ code: "workspace_content_revision_mismatch" });
    expect(run).not.toHaveBeenCalled();
  });
});
