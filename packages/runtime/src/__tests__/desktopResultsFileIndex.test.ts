import * as fsPromises from "node:fs/promises";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProject, searchProjectWithDiagnostics } from "../desktop/index.js";
import {
  maxIndexedResultFileCount,
  maxIndexedResultTotalBodyBytes,
  selectIndexedResultFingerprints,
  type ResultFileFingerprint
} from "../desktop/graph/resultsFileIndex.js";
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

function fingerprint(path: string, mtimeMs: number, size: number): ResultFileFingerprint {
  return { path, mtimeMs, size };
}

function sizedBody(needle: string, size: number): string {
  if (needle.length > size) {
    throw new Error("Needle exceeds requested body size.");
  }
  return needle + " ".repeat(size - needle.length);
}

describe("desktop results file index", () => {
  it("selects the newest result fingerprints first when the file count limit is exceeded", () => {
    const selected = selectIndexedResultFingerprints(
      [
        fingerprint("runs/old.md", 1000, 10),
        fingerprint("runs/new-b.md", 3000, 10),
        fingerprint("runs/new-a.md", 3000, 10),
        fingerprint("runs/mid.md", 2000, 10)
      ],
      { maxFiles: 3, maxTotalBodyBytes: 1000, maxSingleFileBytes: 100 }
    );

    expect(selected.files.map((file) => file.path)).toEqual([
      "runs/new-a.md",
      "runs/new-b.md",
      "runs/mid.md"
    ]);
    expect(selected.diagnostics).toEqual([
      expect.objectContaining({
        code: "desktop_results_index_file_limit_exceeded",
        path: "results",
        message: expect.stringContaining("total=4, indexed=3, skipped=1, limit=3")
      })
    ]);
  });

  it("skips readable result bodies that would exceed the total body byte budget", () => {
    const selected = selectIndexedResultFingerprints(
      [
        fingerprint("runs/new.md", 3000, 60),
        fingerprint("runs/mid.md", 2000, 50),
        fingerprint("runs/oversized.log", 1500, 500),
        fingerprint("runs/old.md", 1000, 40)
      ],
      { maxFiles: 10, maxTotalBodyBytes: 100, maxSingleFileBytes: 100 }
    );

    expect(selected.files.map((file) => file.path)).toEqual([
      "runs/new.md",
      "runs/oversized.log"
    ]);
    expect(selected.diagnostics).toEqual([
      expect.objectContaining({
        code: "desktop_results_index_byte_limit_exceeded",
        path: "results",
        message: expect.stringContaining("total=150, indexed=60, skipped=90, limit=100")
      })
    ]);
  });

  it("reports final indexed counts and full readable body totals when file and byte limits both apply", () => {
    const selected = selectIndexedResultFingerprints(
      [
        fingerprint("runs/skipped-by-file-limit.md", 1000, 50),
        fingerprint("runs/skipped-after-budget-a.md", 2000, 50),
        fingerprint("runs/skipped-after-budget-b.md", 3000, 50),
        fingerprint("runs/indexed.md", 4000, 60)
      ],
      { maxFiles: 3, maxTotalBodyBytes: 100, maxSingleFileBytes: 100 }
    );

    expect(selected.files.map((file) => file.path)).toEqual(["runs/indexed.md"]);
    expect(selected.diagnostics).toEqual([
      expect.objectContaining({
        code: "desktop_results_index_file_limit_exceeded",
        path: "results",
        message: expect.stringContaining("total=4, indexed=1, skipped=3, limit=3")
      }),
      expect.objectContaining({
        code: "desktop_results_index_byte_limit_exceeded",
        path: "results",
        message: expect.stringContaining("total=210, indexed=60, skipped=150, limit=100")
      })
    ]);
  });

  it("searches indexed new result files and reports skipped old result files when the byte limit is exceeded", async () => {
    const { root, init } = await createTestWorkspace();
    const limitedDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-LIMIT");
    await mkdir(limitedDir, { recursive: true });

    const bodySize = 250_000;
    const indexedFileCount = Math.floor(maxIndexedResultTotalBodyBytes / bodySize);
    const oldReport = join(limitedDir, "0000-old-skipped.md");
    const newReport = join(limitedDir, "9999-new-indexed.md");
    await writeFile(oldReport, sizedBody("old skipped byte limit needle\n", bodySize), "utf8");
    await writeFile(newReport, sizedBody("new indexed byte limit needle\n", bodySize), "utf8");
    await utimes(oldReport, new Date(1_000), new Date(1_000));
    await utimes(newReport, new Date(4_000), new Date(4_000));

    for (let index = 0; index < indexedFileCount - 1; index += 1) {
      const path = join(limitedDir, `${String(index + 1).padStart(4, "0")}-filler.md`);
      await writeFile(path, sizedBody(`filler result ${index}\n`, bodySize), "utf8");
      await utimes(path, new Date(2_000 + index), new Date(2_000 + index));
    }

    const indexed = await searchProjectWithDiagnostics(root, "new indexed byte limit needle");
    const skipped = await searchProjectWithDiagnostics(root, "old skipped byte limit needle");

    expect(indexed.results).toEqual([
      expect.objectContaining({ kind: "run_record", ref: "T-001/blocks/B-001/runs/RUN-LIMIT/9999-new-indexed.md" })
    ]);
    expect(skipped.results).toEqual([]);
    expect(indexed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "desktop_results_index_byte_limit_exceeded",
        path: "results",
        message: expect.stringContaining(`limit=${maxIndexedResultTotalBodyBytes}`)
      })
    ]));
  });

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
