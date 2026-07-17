import type { PathLike } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedReadFailure = vi.hoisted(
  (): { path: string | null; error: NodeJS.ErrnoException | null } => ({
    path: null,
    error: null
  })
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: PathLike | number, options?: Parameters<typeof actual.readFile>[1]) => {
      if (injectedReadFailure.path === path.toString() && injectedReadFailure.error) {
        throw injectedReadFailure.error;
      }
      return actual.readFile(path as never, options as never);
    }
  };
});

import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { createTaskWorkspaceReadContext } from "../desktop/taskWorkspaceReadContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  injectedReadFailure.path = null;
  injectedReadFailure.error = null;
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

describe("PlanGraph package prompt read failures", () => {
  it("distinguishes permission failures from missing prompts and propagates them to Task Workspace", async () => {
    const { root, init } = await createTestWorkspace(basicManifest());
    const packagePath = "nodes/T-001/blocks/B-001.prompt.md";
    injectedReadFailure.path = `${init.workspace.packageDir}/${packagePath}`;
    const permissionError = new Error("permission denied") as NodeJS.ErrnoException;
    permissionError.code = "EACCES";
    injectedReadFailure.error = permissionError;

    const loaded = await loadPlanGraphPackage(root);
    expect(loaded.promptReadFailuresByPath.get(packagePath)).toEqual({
      kind: "read_error",
      path: packagePath,
      error: permissionError
    });
    await expect(createTaskWorkspaceReadContext({ projectRoot: root })).rejects.toBe(
      permissionError
    );
  });
});
