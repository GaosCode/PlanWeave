import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readBlockRunIndexView } from "../autoRun/blockRunIndex.js";
import { writeJsonFile } from "../json.js";

const worker = fileURLToPath(new URL("./support/blockRunIndexWriterWorker.ts", import.meta.url));
const temporaryRoots: string[] = [];
const runCount = 100;
const writerSplit = runCount / 2;
const runIdWidth = 3;
const testTimeoutMs = 15_000;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function runWriter(runRoot: string, first: number, last: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, runRoot, String(first), String(last)],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Block run index writer exited code=${String(code)} signal=${String(signal)}: ${stderr}`
          )
        );
      }
    });
  });
}

describe("block run index cross-process locking", () => {
  it(
    "does not lose entries written by two processes",
    async () => {
      const runRoot = await mkdtemp(join(tmpdir(), "planweave-index-concurrency-"));
      temporaryRoots.push(runRoot);
      await Promise.all(
        Array.from({ length: runCount }, async (_, offset) => {
          const index = offset + 1;
          const runId = `RUN-${String(index).padStart(runIdWidth, "0")}`;
          const runDir = join(runRoot, runId);
          await mkdir(runDir, { recursive: true });
          await writeJsonFile(join(runDir, "metadata.json"), {
            runId,
            ref: "T-001#B-001",
            startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
          });
        })
      );

      await Promise.all([
        runWriter(runRoot, 1, writerSplit),
        runWriter(runRoot, writerSplit + 1, runCount)
      ]);

      const view = await readBlockRunIndexView(runRoot, { limit: runCount });
      expect(view.entries).toHaveLength(runCount);
      expect(new Set(view.entries.map((entry) => entry.runId))).toHaveLength(runCount);
      expect(new Set(view.entries.map((entry) => entry.retryIndex))).toHaveLength(runCount);
    },
    testTimeoutMs
  );
});
