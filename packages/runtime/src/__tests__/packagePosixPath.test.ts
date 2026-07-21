import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toPackagePosixPath } from "../package/packagePosixPath.js";
import { normalizePackagePath, promptPathToRefs } from "../graph/session/fileQueue.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { basicManifest } from "./promptTestHelpers.js";
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
  it("maps Windows-separated prompt paths to the same refs as POSIX", () => {
    const graph = compileTaskGraph(basicManifest());
    const posix = promptPathToRefs(graph, "nodes/T-001/prompt.md");
    const windows = promptPathToRefs(graph, String.raw`nodes\T-001\prompt.md`);
    expect(windows).toEqual(posix);
    expect(windows.length).toBeGreaterThan(0);
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
