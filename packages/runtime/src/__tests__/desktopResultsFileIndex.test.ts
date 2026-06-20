import * as fsPromises from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProject, searchProjectWithDiagnostics } from "../desktop/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile)
  };
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PLANWEAVE_HOME;
});

function resultReadPaths(resultsDir: string): string[] {
  const readFileMock = vi.mocked(fsPromises.readFile);
  return readFileMock.mock.calls
    .map(([path]) => typeof path === "string" ? path : null)
    .filter((path): path is string => path !== null && path.startsWith(resultsDir));
}

describe("desktop results file index", () => {
  it("reuses unchanged result file bodies when another result file changes", async () => {
    const { root, init } = await createTestWorkspace();
    const stableRunDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-STABLE");
    const changedRunDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-CHANGED");
    const stableReport = join(stableRunDir, "report.md");
    const changedReport = join(changedRunDir, "report.md");
    await mkdir(stableRunDir, { recursive: true });
    await mkdir(changedRunDir, { recursive: true });
    await writeFile(stableReport, "stable cached result needle\n", "utf8");
    await writeFile(changedReport, "changed cached result needle\n", "utf8");

    await searchProjectWithDiagnostics(root, "cached result needle");
    vi.mocked(fsPromises.readFile).mockClear();
    await writeFile(changedReport, "changed cached result needle updated\n", "utf8");

    await expect(searchProject(root, "changed cached result needle updated")).resolves.toEqual([
      expect.objectContaining({ kind: "run_record", ref: "T-001/blocks/B-001/runs/RUN-CHANGED/report.md" })
    ]);
    expect(resultReadPaths(init.workspace.resultsDir).filter((path) => path.endsWith("report.md"))).toEqual([changedReport]);
  });

  it("drops deleted result files from the incremental result index cache", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-DELETED");
    const reportPath = join(runDir, "report.md");
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "deleted cache result needle\n", "utf8");

    await expect(searchProject(root, "deleted cache result needle")).resolves.toEqual([
      expect.objectContaining({ kind: "run_record", ref: "T-001/blocks/B-001/runs/RUN-DELETED/report.md" })
    ]);
    await rm(reportPath);

    await expect(searchProject(root, "deleted cache result needle")).resolves.toEqual([]);
  });

  it("reuses cached file diagnostics when a malformed result metadata file is unchanged", async () => {
    const { root, init } = await createTestWorkspace();
    const badRunDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-BAD-CACHED");
    const changedRunDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-DIAGNOSTIC-CHANGED");
    const badMetadataPath = join(badRunDir, "metadata.json");
    const changedReport = join(changedRunDir, "report.md");
    await mkdir(badRunDir, { recursive: true });
    await mkdir(changedRunDir, { recursive: true });
    await writeFile(badMetadataPath, "{", "utf8");
    await writeFile(changedReport, "diagnostic cache trigger\n", "utf8");

    await searchProjectWithDiagnostics(root, "diagnostic cache trigger");
    vi.mocked(fsPromises.readFile).mockClear();
    await writeFile(changedReport, "diagnostic cache trigger updated\n", "utf8");

    const projection = await searchProjectWithDiagnostics(root, "diagnostic cache trigger updated");

    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "desktop_result_metadata_read_failed",
        path: "results/T-001/blocks/B-001/runs/RUN-BAD-CACHED/metadata.json"
      })
    ]));
    expect(resultReadPaths(init.workspace.resultsDir)).not.toContain(badMetadataPath);
  });
});
