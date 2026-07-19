import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProject, searchProjectWithDiagnostics } from "../desktop/index.js";
import {
  buildResultsFileIndexFromFingerprintSnapshot,
  clearResultsFileIndexCache,
  getResultsFingerprintFullScanCount,
  hydrateResultsFileIndexBodies,
  maxCachedResultsDirectories,
  maxIndexedResultTotalBodyBytes,
  resetResultsFingerprintFullScanCount,
  resultsDirSignature,
  selectIndexedResultFingerprints,
  snapshotResultsFileFingerprints,
  type ResultFileFingerprint,
  type ResultsFileIndex,
  type ResultsFileIndexEntry
} from "../desktop/graph/resultsFileIndex.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat)
  };
});

afterEach(() => {
  vi.clearAllMocks();
  clearResultsFileIndexCache();
  resetResultsFingerprintFullScanCount();
  delete process.env.PLANWEAVE_HOME;
});

function resultReadPaths(resultsDir: string): string[] {
  const readFileMock = vi.mocked(fsPromises.readFile);
  return readFileMock.mock.calls
    .map(([path]) => (typeof path === "string" ? path : null))
    .filter((path): path is string => path !== null && path.startsWith(resultsDir));
}

function fingerprint(path: string, mtimeMs: number, size: number): ResultFileFingerprint {
  return { path, ctimeMs: mtimeMs, mtimeMs, size };
}

function sizedBody(needle: string, size: number): string {
  if (needle.length > size) {
    throw new Error("Needle exceeds requested body size.");
  }
  return needle + " ".repeat(size - needle.length);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultIndexEntry(
  workspace: ResultsFileIndex["workspace"],
  relativePath: string,
  size: number
): ResultsFileIndexEntry {
  const entryFingerprint = fingerprint(relativePath, 1000, size);
  return {
    absolutePath: join(workspace.resultsDir, relativePath),
    relativePath,
    fingerprint: entryFingerprint,
    body: "",
    bodyLoaded: false,
    bodyTruncated: false,
    metadata: null
  };
}

async function indexedReportWorkspace(
  template: ResultsFileIndex["workspace"],
  label: string,
  body: string
): Promise<{
  workspace: ResultsFileIndex["workspace"];
  index: ResultsFileIndex;
  reportPath: string;
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `planweave-results-cache-${label}-`));
  const resultsDir = join(workspaceRoot, "results");
  const relativePath = `T-001/blocks/B-001/runs/RUN-${label}/report.md`;
  const reportPath = join(resultsDir, relativePath);
  const workspace = {
    ...template,
    rootPath: workspaceRoot,
    workspaceRoot,
    packageDir: join(workspaceRoot, "package"),
    manifestFile: join(workspaceRoot, "package", "manifest.json"),
    stateFile: join(workspaceRoot, "state.json"),
    resultsDir,
    projectFile: join(workspaceRoot, "project.json"),
    projectPromptFile: join(workspaceRoot, "policy", "project-prompt.md")
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, body, "utf8");
  const index = await buildResultsFileIndexFromFingerprintSnapshot(workspace, {
    diagnostics: [],
    files: [fingerprint(relativePath, 1000, Buffer.byteLength(body))]
  });
  return { workspace, index, reportPath };
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

    expect(selected.files.map((file) => file.path)).toEqual(["runs/new.md", "runs/oversized.log"]);
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

  it("builds metadata-only result indexes without reading ordinary result bodies and hydrates bodies through cache", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-METADATA"
    );
    const reportPath = join(runDir, "report.md");
    const metadataPath = join(runDir, "metadata.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "metadata-only stage must not read body needle\n", "utf8");
    await writeJsonFile(metadataPath, {
      startedAt: "2026-06-30T00:00:00.000Z",
      finishedAt: "2026-06-30T00:00:01.000Z"
    });

    const snapshot = await snapshotResultsFileFingerprints(init.workspace);
    vi.mocked(fsPromises.readFile).mockClear();
    const index = await buildResultsFileIndexFromFingerprintSnapshot(init.workspace, snapshot);
    const metadataEntry = index.entries.find((entry) =>
      entry.relativePath.endsWith("metadata.json")
    );
    const reportEntry = index.entries.find((entry) => entry.relativePath.endsWith("report.md"));

    expect(resultReadPaths(init.workspace.resultsDir)).toEqual([metadataPath]);
    expect(metadataEntry?.metadata).toMatchObject({ startedAt: "2026-06-30T00:00:00.000Z" });
    expect(reportEntry).toMatchObject({
      body: "",
      bodyLoaded: false
    });

    vi.mocked(fsPromises.readFile).mockClear();
    const hydrated = await hydrateResultsFileIndexBodies(index);
    expect(
      hydrated.entries.find((entry) => entry.relativePath.endsWith("report.md"))
    ).toMatchObject({
      body: "metadata-only stage must not read body needle\n",
      bodyLoaded: true
    });
    expect(resultReadPaths(init.workspace.resultsDir)).toEqual(
      expect.arrayContaining([reportPath])
    );

    vi.mocked(fsPromises.readFile).mockClear();
    await hydrateResultsFileIndexBodies(index);
    expect(resultReadPaths(init.workspace.resultsDir)).toEqual([]);
  });

  it("clears one cached results directory without clearing another", async () => {
    const { init } = await createTestWorkspace();
    const first = await indexedReportWorkspace(
      init.workspace,
      "CLEAR-A",
      "first scoped cache needle\n"
    );
    const second = await indexedReportWorkspace(
      init.workspace,
      "CLEAR-B",
      "second scoped cache needle\n"
    );
    await hydrateResultsFileIndexBodies(first.index);
    await hydrateResultsFileIndexBodies(second.index);

    vi.mocked(fsPromises.readFile).mockClear();
    clearResultsFileIndexCache({ resultsDir: first.workspace.resultsDir });
    const firstHydrated = await hydrateResultsFileIndexBodies(first.index);
    const secondHydrated = await hydrateResultsFileIndexBodies(second.index);

    expect(firstHydrated.entries[0]).toMatchObject({
      body: "first scoped cache needle\n",
      bodyLoaded: true
    });
    expect(secondHydrated.entries[0]).toMatchObject({
      body: "second scoped cache needle\n",
      bodyLoaded: true
    });
    expect(resultReadPaths(first.workspace.resultsDir)).toEqual([first.reportPath]);
    expect(resultReadPaths(second.workspace.resultsDir)).toEqual([]);
  });

  it("evicts the least recently used results directory when the cache exceeds its entry limit", async () => {
    const { init } = await createTestWorkspace();
    const cached: Array<Awaited<ReturnType<typeof indexedReportWorkspace>>> = [];
    for (let index = 0; index < maxCachedResultsDirectories; index += 1) {
      const report = await indexedReportWorkspace(
        init.workspace,
        `LRU-${String(index).padStart(2, "0")}`,
        `lru cached body ${index}\n`
      );
      await hydrateResultsFileIndexBodies(report.index);
      cached.push(report);
    }

    vi.mocked(fsPromises.readFile).mockClear();
    await hydrateResultsFileIndexBodies(cached[0].index);
    expect(resultReadPaths(cached[0].workspace.resultsDir)).toEqual([]);

    const overflow = await indexedReportWorkspace(
      init.workspace,
      "LRU-OVERFLOW",
      "lru overflow body\n"
    );
    await hydrateResultsFileIndexBodies(overflow.index);

    vi.mocked(fsPromises.readFile).mockClear();
    await hydrateResultsFileIndexBodies(cached[0].index);
    await hydrateResultsFileIndexBodies(cached[1].index);

    expect(resultReadPaths(cached[0].workspace.resultsDir)).toEqual([]);
    expect(resultReadPaths(cached[1].workspace.resultsDir)).toEqual([cached[1].reportPath]);
  });

  it("reads result directories with bounded concurrency and keeps indexing after one directory read failure", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { init } = await createTestWorkspace();
    const runsDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const failedRunDir = join(runsDir, "RUN-DIR-05");
    for (let index = 0; index < 12; index += 1) {
      const runDir = join(runsDir, `RUN-DIR-${String(index).padStart(2, "0")}`);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "report.md"), `directory concurrency ${index}\n`, "utf8");
    }

    let inFlight = 0;
    let peakInFlight = 0;
    await vi.mocked(fsPromises.readdir).withImplementation(
      async (...args: Parameters<typeof fsPromises.readdir>) => {
        const pathString = typeof args[0] === "string" ? args[0] : args[0].toString();
        if (pathString.includes("RUN-DIR-")) {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await delay(5);
          inFlight -= 1;
          if (pathString === failedRunDir) {
            throw new Error("directory unavailable");
          }
        }
        return actualFs.readdir(...args);
      },
      async () => {
        const snapshot = await snapshotResultsFileFingerprints(init.workspace);
        const paths = snapshot.files.map((file) => file.path);

        expect(peakInFlight).toBeGreaterThan(1);
        expect(peakInFlight).toBeLessThanOrEqual(8);
        expect(paths).toEqual(
          expect.arrayContaining([
            "T-001/blocks/B-001/runs/RUN-DIR-00/report.md",
            "T-001/blocks/B-001/runs/RUN-DIR-11/report.md"
          ])
        );
        expect(paths).not.toContain("T-001/blocks/B-001/runs/RUN-DIR-05/report.md");
        expect(snapshot.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "desktop_results_read_failed",
              path: "results/T-001/blocks/B-001/runs/RUN-DIR-05"
            })
          ])
        );
      }
    );
  });

  it("stats result files with bounded concurrency and keeps indexing after one stat failure", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-STAT-CONCURRENCY"
    );
    await mkdir(runDir, { recursive: true });
    const failedPath = join(runDir, "report-05.md");
    for (let index = 0; index < 24; index += 1) {
      await writeFile(
        join(runDir, `report-${String(index).padStart(2, "0")}.md`),
        `stat concurrency ${index}\n`,
        "utf8"
      );
    }

    let inFlight = 0;
    let peakInFlight = 0;
    const statMock = vi.mocked(fsPromises.stat);
    await statMock.withImplementation(
      async (path: Parameters<typeof fsPromises.stat>[0]) => {
        const pathString = typeof path === "string" ? path : path.toString();
        if (pathString.startsWith(init.workspace.resultsDir)) {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await delay(5);
          inFlight -= 1;
          if (pathString === failedPath) {
            throw new Error("stat unavailable");
          }
        }
        return actualFs.stat(path);
      },
      async () => {
        const snapshot = await snapshotResultsFileFingerprints(init.workspace);

        expect(peakInFlight).toBeGreaterThan(1);
        expect(peakInFlight).toBeLessThanOrEqual(16);
        expect(snapshot.files.map((file) => file.path)).not.toContain(
          "T-001/blocks/B-001/runs/RUN-STAT-CONCURRENCY/report-05.md"
        );
        expect(snapshot.files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            "T-001/blocks/B-001/runs/RUN-STAT-CONCURRENCY/report-00.md",
            "T-001/blocks/B-001/runs/RUN-STAT-CONCURRENCY/report-23.md"
          ])
        );
        expect(snapshot.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "desktop_result_file_read_failed",
              path: "results/T-001/blocks/B-001/runs/RUN-STAT-CONCURRENCY/report-05.md"
            })
          ])
        );
      }
    );
  });

  it("reads metadata entries concurrently while preserving snapshot order", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { init } = await createTestWorkspace();
    const relativePaths = Array.from(
      { length: 10 },
      (_, index) => `T-001/blocks/B-001/runs/RUN-ORDER-${index + 1}/metadata.json`
    );
    const snapshot = {
      diagnostics: [],
      files: relativePaths.map((path, index) => fingerprint(path, 10_000 - index, 20))
    };
    let inFlight = 0;
    let peakInFlight = 0;

    await vi.mocked(fsPromises.readFile).withImplementation(
      async (...args: Parameters<typeof fsPromises.readFile>) => {
        const pathString = typeof args[0] === "string" ? args[0] : args[0].toString();
        if (
          pathString.startsWith(init.workspace.resultsDir) &&
          pathString.endsWith("metadata.json")
        ) {
          const orderIndex = relativePaths.findIndex((relativePath) =>
            pathString.endsWith(relativePath)
          );
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await delay((relativePaths.length - orderIndex) * 2);
          inFlight -= 1;
          return JSON.stringify({ orderIndex });
        }
        return actualFs.readFile(...args);
      },
      async () => {
        const index = await buildResultsFileIndexFromFingerprintSnapshot(init.workspace, snapshot);

        expect(peakInFlight).toBeGreaterThan(1);
        expect(peakInFlight).toBeLessThanOrEqual(8);
        expect(index.entries.map((entry) => entry.relativePath)).toEqual(relativePaths);
        expect(index.entries.map((entry) => entry.metadata)).toEqual(
          relativePaths.map((_, orderIndex) => ({ orderIndex }))
        );
      }
    );
  });

  it("hydrates result bodies concurrently, keeps entry order, and keeps going after a read failure", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { init } = await createTestWorkspace();
    const relativePaths = Array.from(
      { length: 6 },
      (_, index) => `T-001/blocks/B-001/runs/RUN-BODY-${index + 1}/report.md`
    );
    const failedRelativePath = relativePaths[2];
    const index: ResultsFileIndex = {
      workspace: init.workspace,
      entries: relativePaths.map((path) => resultIndexEntry(init.workspace, path, 30)),
      diagnostics: []
    };
    let inFlight = 0;
    let peakInFlight = 0;

    await vi.mocked(fsPromises.readFile).withImplementation(
      async (...args: Parameters<typeof fsPromises.readFile>) => {
        const pathString = typeof args[0] === "string" ? args[0] : args[0].toString();
        if (pathString.startsWith(init.workspace.resultsDir) && pathString.endsWith("report.md")) {
          const orderIndex = relativePaths.findIndex((relativePath) =>
            pathString.endsWith(relativePath)
          );
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await delay((relativePaths.length - orderIndex) * 2);
          inFlight -= 1;
          if (pathString.endsWith(failedRelativePath)) {
            throw new Error("body unavailable");
          }
          return `body ${orderIndex}`;
        }
        return actualFs.readFile(...args);
      },
      async () => {
        const hydrated = await hydrateResultsFileIndexBodies(index);

        expect(peakInFlight).toBeGreaterThan(1);
        expect(peakInFlight).toBeLessThanOrEqual(4);
        expect(hydrated.entries.map((entry) => entry.relativePath)).toEqual(relativePaths);
        expect(hydrated.entries[0]).toMatchObject({ body: "body 0", bodyLoaded: true });
        expect(hydrated.entries[2]).toMatchObject({ body: "", bodyLoaded: false });
        expect(hydrated.entries[5]).toMatchObject({ body: "body 5", bodyLoaded: true });
        expect(hydrated.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "desktop_result_file_read_failed",
              path: `results/${failedRelativePath}`
            })
          ])
        );
      }
    );
  });

  it("does not cache a result body read failure as a permanent empty body", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { init } = await createTestWorkspace();
    const report = await indexedReportWorkspace(
      init.workspace,
      "RETRY-BODY",
      "retry body cache needle\n"
    );
    let failNextRead = true;

    await vi.mocked(fsPromises.readFile).withImplementation(
      async (...args: Parameters<typeof fsPromises.readFile>) => {
        const pathString = typeof args[0] === "string" ? args[0] : args[0].toString();
        if (pathString === report.reportPath && failNextRead) {
          failNextRead = false;
          throw new Error("temporary body read failure");
        }
        return actualFs.readFile(...args);
      },
      async () => {
        const failed = await hydrateResultsFileIndexBodies(report.index);
        expect(failed.entries[0]).toMatchObject({ body: "", bodyLoaded: false });
        expect(failed.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "desktop_result_file_read_failed",
              path: "results/T-001/blocks/B-001/runs/RUN-RETRY-BODY/report.md"
            })
          ])
        );

        vi.mocked(fsPromises.readFile).mockClear();
        const retried = await hydrateResultsFileIndexBodies(report.index);
        expect(retried.entries[0]).toMatchObject({
          body: "retry body cache needle\n",
          bodyLoaded: true
        });
        expect(resultReadPaths(report.workspace.resultsDir)).toEqual([report.reportPath]);
      }
    );
  });

  it("searches indexed new result files and reports skipped old result files when the byte limit is exceeded", async () => {
    const { root, init } = await createTestWorkspace();
    const limitedDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-LIMIT"
    );
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
      expect.objectContaining({
        kind: "run_record",
        ref: "T-001/blocks/B-001/runs/RUN-LIMIT/9999-new-indexed.md"
      })
    ]);
    expect(skipped.results).toEqual([]);
    expect(indexed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_results_index_byte_limit_exceeded",
          path: "results",
          message: expect.stringContaining(`limit=${maxIndexedResultTotalBodyBytes}`)
        })
      ])
    );
  });

  it("reuses unchanged result file bodies when another result file changes", async () => {
    const { root, init } = await createTestWorkspace();
    const stableRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-STABLE"
    );
    const changedRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-CHANGED"
    );
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
      expect.objectContaining({
        kind: "run_record",
        ref: "T-001/blocks/B-001/runs/RUN-CHANGED/report.md"
      })
    ]);
    expect(
      resultReadPaths(init.workspace.resultsDir).filter((path) => path.endsWith("report.md"))
    ).toEqual([changedReport]);
  });

  it("drops deleted result files from the incremental result index cache", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-DELETED"
    );
    const reportPath = join(runDir, "report.md");
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "deleted cache result needle\n", "utf8");

    await expect(searchProject(root, "deleted cache result needle")).resolves.toEqual([
      expect.objectContaining({
        kind: "run_record",
        ref: "T-001/blocks/B-001/runs/RUN-DELETED/report.md"
      })
    ]);
    await rm(reportPath);

    await expect(searchProject(root, "deleted cache result needle")).resolves.toEqual([]);
  });

  it("reuses cached file diagnostics when a malformed result metadata file is unchanged", async () => {
    const { root, init } = await createTestWorkspace();
    const badRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-BAD-CACHED"
    );
    const changedRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-DIAGNOSTIC-CHANGED"
    );
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

    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_metadata_read_failed",
          path: "results/T-001/blocks/B-001/runs/RUN-BAD-CACHED/metadata.json"
        })
      ])
    );
    expect(resultReadPaths(init.workspace.resultsDir)).not.toContain(badMetadataPath);
  });

  it("skips repeated full results scans when the results dir signature is unchanged", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-SIG-CACHE"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "signature cache warm path\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-SIG-CACHE",
      finishedAt: null
    });

    resetResultsFingerprintFullScanCount();
    const first = await snapshotResultsFileFingerprints(init.workspace);
    const second = await snapshotResultsFileFingerprints(init.workspace);
    const third = await snapshotResultsFileFingerprints(init.workspace);

    expect(getResultsFingerprintFullScanCount()).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await resultsDirSignature(init.workspace.resultsDir)).toEqual(expect.any(String));
  });

  it("rescans when a new result file appears under results/", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-NEW-FILE"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "first result file\n", "utf8");

    resetResultsFingerprintFullScanCount();
    const first = await snapshotResultsFileFingerprints(init.workspace);
    expect(first.files.map((file) => file.path)).toEqual([
      "T-001/blocks/B-001/runs/RUN-NEW-FILE/report.md"
    ]);
    expect(getResultsFingerprintFullScanCount()).toBe(1);

    await writeFile(join(runDir, "stdout.md"), "new stdout artifact\n", "utf8");
    const second = await snapshotResultsFileFingerprints(init.workspace);

    expect(getResultsFingerprintFullScanCount()).toBe(2);
    expect(second.files.map((file) => file.path).sort()).toEqual(
      [
        "T-001/blocks/B-001/runs/RUN-NEW-FILE/report.md",
        "T-001/blocks/B-001/runs/RUN-NEW-FILE/stdout.md"
      ].sort()
    );
  });

  it("rescans when an existing metadata.json is rewritten in place", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-META-REWRITE"
    );
    const metadataPath = join(runDir, "metadata.json");
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(metadataPath, {
      runId: "RUN-META-REWRITE",
      finishedAt: null,
      exitCode: null
    });

    resetResultsFingerprintFullScanCount();
    const firstSnapshot = await snapshotResultsFileFingerprints(init.workspace);
    const firstIndex = await buildResultsFileIndexFromFingerprintSnapshot(
      init.workspace,
      firstSnapshot
    );
    expect(
      firstIndex.entries.find((entry) => entry.relativePath.endsWith("metadata.json"))?.metadata
    ).toMatchObject({
      finishedAt: null,
      exitCode: null
    });
    expect(getResultsFingerprintFullScanCount()).toBe(1);

    // Simulate finishRunMetadata: rewrite the same path with updated finalization fields.
    await delay(5);
    await writeJsonFile(metadataPath, {
      runId: "RUN-META-REWRITE",
      finishedAt: "2026-07-09T12:00:00.000Z",
      exitCode: 0
    });

    const secondSnapshot = await snapshotResultsFileFingerprints(init.workspace);
    const secondIndex = await buildResultsFileIndexFromFingerprintSnapshot(
      init.workspace,
      secondSnapshot
    );

    expect(getResultsFingerprintFullScanCount()).toBe(2);
    expect(secondSnapshot.files).not.toEqual(firstSnapshot.files);
    expect(
      secondIndex.entries.find((entry) => entry.relativePath.endsWith("metadata.json"))?.metadata
    ).toMatchObject({
      finishedAt: "2026-07-09T12:00:00.000Z",
      exitCode: 0
    });
  });

  it("forces a full rescan after clearResultsFileIndexCache even when files are unchanged", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-CLEAR-SIG"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "clear signature cache\n", "utf8");

    resetResultsFingerprintFullScanCount();
    await snapshotResultsFileFingerprints(init.workspace);
    await snapshotResultsFileFingerprints(init.workspace);
    expect(getResultsFingerprintFullScanCount()).toBe(1);

    clearResultsFileIndexCache({ resultsDir: init.workspace.resultsDir });
    await snapshotResultsFileFingerprints(init.workspace);
    expect(getResultsFingerprintFullScanCount()).toBe(2);

    clearResultsFileIndexCache();
    await snapshotResultsFileFingerprints(init.workspace);
    expect(getResultsFingerprintFullScanCount()).toBe(3);
  });
});
