import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { toPackagePosixPath } from "../package/packagePosixPath.js";
import {
  createExecutionGraphSession,
  drainGraphReadQueue,
  enqueuePackageFileChanges
} from "../graph/session.js";
import { normalizePackagePath } from "../graph/session/fileQueue.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import type { ExecutionGraphSession } from "../types.js";

describe("toPackagePosixPath", () => {
  it("normalizes Windows separators to POSIX package paths", () => {
    expect(toPackagePosixPath(String.raw`nodes\task-pi-note\prompt.md`)).toBe(
      "nodes/task-pi-note/prompt.md"
    );
    expect(toPackagePosixPath("nodes/task-pi-note/prompt.md")).toBe("nodes/task-pi-note/prompt.md");
  });

  it("makes Windows path.relative results match manifest prompt keys", () => {
    const diskRelative = String.raw`nodes\T-001\blocks\B-001.prompt.md`;
    const manifestPrompt = "nodes/T-001/blocks/B-001.prompt.md";
    const referenced = new Set([manifestPrompt]);
    expect(referenced.has(toPackagePosixPath(diskRelative))).toBe(true);
  });
});

describe("fileQueue path normalization", () => {
  it("maps Windows-separated prompt paths to the same refs as POSIX", async () => {
    const { home, root, init } = await createTestWorkspace();
    onTestFinished(async () => {
      await Promise.all([home, root].map((path) => rm(path, { recursive: true, force: true })));
    });
    for (const path of ["nodes/T-001/prompt.md", String.raw`nodes\T-001\prompt.md`]) {
      const session = await createExecutionGraphSession(init.workspace);
      enqueuePackageFileChanges(session, [{ path, type: "changed" }]);
      const result = await drainGraphReadQueue(session);
      expect(result.dirtyPromptRefs).toEqual(["T-001#B-001", "T-001#R-001"]);
    }
  });

  it("normalizes absolute package paths to POSIX relative form", () => {
    const packageRoot = join("/tmp", "demo", "package");
    const session = { packageRoot } as ExecutionGraphSession;
    expect(normalizePackagePath(session, join(packageRoot, "nodes", "T-001", "prompt.md"))).toBe(
      "nodes/T-001/prompt.md"
    );
    expect(normalizePackagePath(session, String.raw`nodes\T-001\prompt.md`)).toBe(
      "nodes/T-001/prompt.md"
    );
  });
});
