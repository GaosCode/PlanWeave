import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyAuthorizedCanvasCommand,
  commitCanvasCommandApplication
} from "../graph/canvasCommandPort.js";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import { getDesktopLayoutDirect } from "../desktop/layoutStore.js";
import { loadPackage } from "../package/loadPackage.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { readState } from "../state.js";
import { readJsonFile } from "../json.js";
import { claimNext, submitBlockResult, submitReviewResult } from "../taskManager/index.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";
import { spawnReviewRetryActor } from "./helpers/reviewRetryProcessFixture.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, cp: vi.fn(actual.cp) };
});
const directories: string[] = [];
const actors: ReturnType<typeof spawnReviewRetryActor>[] = [];
const gates: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise.catch(() => undefined));
  return promise;
}
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const actor of actors.splice(0)) {
    actor.child.stdin.end();
    if (actor.child.exitCode === null) actor.child.kill();
    await actor.done;
  }
  await Promise.all(pending.splice(0));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  gates.push(resolve);
  return { promise, resolve };
}
async function fixture() {
  const f = await createTestWorkspace(
    basicManifest({ reviewMaxFeedbackCycles: 0, includeSecondTask: true })
  );
  directories.push(f.home, f.root);
  const projectRoot = f.init.workspace;
  await claimNext({ projectRoot });
  await submitBlockResult({
    projectRoot,
    ref: "T-001#B-001",
    reportPath: await writeReport(f.root, "implementation.md")
  });
  await claimNext({ projectRoot });
  await submitReviewResult({
    projectRoot,
    ref: "T-001#R-001",
    resultPath: await writeReviewResult(f.root, "needs_changes", "Exhausted.")
  });
  return projectRoot;
}
function actor(
  workspace: Awaited<ReturnType<typeof fixture>>,
  operation: "edit" | "retry" | "delete"
) {
  const child = spawnReviewRetryActor(workspace, false, operation);
  actors.push(child);
  return child;
}
async function application(workspace: Awaited<ReturnType<typeof fixture>>, taskId = "T-001") {
  return buildCanvasCommandApplication(
    (await loadPackage(workspace)).manifest,
    await getDesktopLayoutDirect(workspace),
    {
      kind: "update_task_fields",
      taskId,
      fields: { title: "Canvas title" }
    }
  );
}
async function assertWriter(
  workspace: Awaited<ReturnType<typeof fixture>>,
  operation: "edit" | "retry" | "delete"
) {
  const manifest = (await loadPackage(workspace)).manifest;
  if (operation === "retry") {
    const task = manifest.nodes.find((node) => node.id === "T-001");
    const review = task?.blocks.find((block) => block.id === "R-001");
    expect(review?.type === "review" && review.review.maxFeedbackCycles).toBe(3);
    expect((await readState(workspace.stateFile)).blocks["T-001#R-001"]).toMatchObject({
      status: "ready",
      completionReason: null
    });
    const index = await readJsonFile<{ reviewCompletionReasonByBlock?: Record<string, string> }>(
      join(workspace.resultsDir, "T-001", "index.json")
    );
    expect(index.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  } else if (operation === "edit") {
    expect(manifest.nodes.find((node) => node.id === "T-002")?.title).toBe("Child edit");
  } else {
    expect(manifest.nodes.find((node) => node.id === "T-002")).toBeUndefined();
    await expect(fs.stat(join(workspace.packageDir, "nodes", "T-002"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  }
  return manifest;
}

it.each([
  "retry",
  "edit",
  "delete"
] as const)("serializes a real %s writer arriving after canonical copy without losing successful changes", async (operation) => {
  const workspace = await fixture();
  const copied = deferred(),
    release = deferred();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.cp).mockImplementation(async (...args) => {
    await actual.cp(...args);
    if (args[0] === workspace.packageDir) {
      copied.resolve();
      await release.promise;
    }
  });
  const command = track(
    applyAuthorizedCanvasCommand({
      projectRoot: workspace,
      canvasId: "default",
      intent: {
        kind: "update_task_fields",
        taskId: operation === "delete" ? "T-002" : "T-001",
        fields: { title: "Canvas title" }
      }
    })
  );
  await copied.promise;
  const writer = actor(workspace, operation);
  await writer.ready;
  release.resolve();
  expect(await command).toMatchObject({ ok: true });
  expect(await writer.done).toMatchObject({ code: 0 });
  const manifest = await assertWriter(workspace, operation);
  if (operation !== "delete") {
    expect(manifest.nodes.find((node) => node.id === "T-001")?.title).toBe("Canvas title");
  }
  expect(writer.observedHeld).toBe(true);
});

it.each([
  "retry",
  "delete"
] as const)("rejects a prepared stale application after a successful %s without reviving old content", async (operation) => {
  const workspace = await fixture();
  const stale = await application(workspace, operation === "delete" ? "T-002" : "T-001");
  const writer = actor(workspace, operation);
  expect(await writer.done).toMatchObject({ code: 0 });
  const result = await commitCanvasCommandApplication({ workspace, application: stale });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "manifest_version_conflict" })
  );
  await assertWriter(workspace, operation);
  expect((await loadPackage(workspace)).manifest.nodes[0]?.title).not.toBe("Canvas title");
});

it("holds authority through failed commit marker rollback before a retry writer may succeed", async () => {
  const workspace = await fixture();
  const published = deferred(),
    release = deferred();
  const command = track(
    commitCanvasCommandApplication({
      workspace,
      application: await application(workspace),
      dependencies: {
        markTransactionCommitted: async () => {
          published.resolve();
          await release.promise;
          throw new Error("marker_failure");
        }
      }
    }).catch((error: unknown) => error)
  );
  await published.promise;
  const writer = actor(workspace, "retry");
  await writer.ready;
  release.resolve();
  expect(await command).toMatchObject({ message: "marker_failure" });
  expect(await writer.done).toMatchObject({ code: 0 });
  const manifest = await assertWriter(workspace, "retry");
  expect(manifest.nodes[0]?.title).not.toBe("Canvas title");
  expect(writer.observedHeld).toBe(true);
});

it("preserves the commit and rollback errors when recovery fails", async () => {
  const workspace = await fixture();
  const original = new Error("marker_failure"),
    rollback = new Error("rollback_failure");
  vi.spyOn(ImportTransaction.prototype, "rollback").mockRejectedValueOnce(rollback);
  const failure = await commitCanvasCommandApplication({
    workspace,
    application: await application(workspace),
    dependencies: {
      markTransactionCommitted: async () => {
        throw original;
      }
    }
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([original, rollback]);
});
