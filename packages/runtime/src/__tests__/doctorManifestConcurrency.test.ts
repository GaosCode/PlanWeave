import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commitPlanPackageGraphMutation, updateNode } from "../graph/editGraph.js";
import { buildPlanPackageGraphMutation } from "../graph/mutation.js";
import { initWorkspace } from "../initWorkspace.js";
import { loadPackage } from "../package/loadPackage.js";
import { withCurrentProjectWorkspace } from "../project.js";
import { readState } from "../state.js";
import { runDoctor } from "../taskManager/doctor.js";
import {
  claimBlock,
  createRemoteBlockRuntimePort,
  submitBlockResult
} from "../taskManager/index.js";
import type { DoctorReport, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { basicManifest, createTestWorkspace, writeReport } from "./promptTestHelpers.js";
import {
  activeIdentity,
  claimIdentity,
  remoteManifest,
  reportInput
} from "./remoteBlockTestHelpers.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function observeProjectWaiter(workspace: ProjectWorkspace) {
  const directory = join(userInfo().homedir, ".cache", "planweave", "project-locks");
  const key = createHash("sha256")
    .update(await realpath(dirname(workspace.projectFile)))
    .digest("hex");
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const queued = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const inspect = () => {
    void readdir(directory).then((entries) => {
      if (entries.some((name) => name.startsWith(`${key}.prepare-`))) resolve();
    }, reject);
  };
  const observer = watch(directory, inspect);
  observer.on("error", reject);
  const deadline = setTimeout(
    () => reject(new Error("Doctor did not reach project admission")),
    10_000
  );
  inspect();
  return {
    queued,
    close: () => {
      clearTimeout(deadline);
      observer.close();
    }
  };
}

function spawnDoctor(workspace: ProjectWorkspace) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const { runDoctor } = await import(process.argv[1]);
     const report = await runDoctor({ projectRoot: JSON.parse(process.argv[2]), repair: true });
     process.stdout.write(JSON.stringify(report));`,
      new URL("../taskManager/doctor.ts", import.meta.url).href,
      JSON.stringify(workspace)
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const result = new Promise<DoctorReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Doctor child exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  void result.catch(() => undefined);
  return { child, result };
}

async function completedFixture(manifest: PlanPackageManifest = basicManifest()) {
  const fixture = await createTestWorkspace(manifest);
  directories.push(fixture.root, fixture.home);
  const { workspace } = await loadPackage(fixture.root);
  await claimBlock({ projectRoot: workspace, ref: "T-001#B-001" });
  await submitBlockResult({
    projectRoot: workspace,
    ref: "T-001#B-001",
    reportPath: await writeReport(fixture.root, "implementation.md", "original result\n")
  });
  return { ...fixture, workspace, manifest };
}

async function fileSnapshot(path: string) {
  const info = await stat(path);
  return {
    bytes: (await readFile(path)).toString("base64"),
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs
  };
}

async function resultSnapshot(directory: string) {
  const files: Record<string, Awaited<ReturnType<typeof fileSnapshot>>> = {};
  const visit = async (path: string, relative: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const childRelative = join(relative, entry.name);
      if (entry.isDirectory()) await visit(join(path, entry.name), childRelative);
      else files[childRelative] = await fileSnapshot(join(path, entry.name));
    }
  };
  await visit(directory, "");
  return files;
}

async function runtimeSnapshot(workspace: ProjectWorkspace) {
  return {
    state: await fileSnapshot(workspace.stateFile),
    results: await resultSnapshot(workspace.resultsDir)
  };
}

async function withQueuedDoctor(workspace: ProjectWorkspace, mutate: () => Promise<void>) {
  let actor: ReturnType<typeof spawnDoctor> | undefined;
  try {
    await withCurrentProjectWorkspace(workspace, async () => {
      const observer = await observeProjectWaiter(workspace);
      actor = spawnDoctor(workspace);
      try {
        await Promise.race([
          observer.queued,
          actor.result.then(() => {
            throw new Error("Doctor bypassed held admission");
          })
        ]);
        await mutate();
      } finally {
        observer.close();
      }
    });
    if (!actor) throw new Error("Doctor child was not started");
    return await actor.result;
  } finally {
    if (actor && actor.child.exitCode === null) {
      actor.child.kill();
      await actor.result.catch(() => undefined);
    }
  }
}

it("preserves a block claimed by another process while Doctor waits for repair admission", async () => {
  const { workspace, manifest } = await completedFixture();
  const indexPath = join(workspace.resultsDir, "T-001", "index.json");
  const reportPath = join(
    workspace.resultsDir,
    "T-001",
    "blocks",
    "B-001",
    "runs",
    "RUN-001",
    "report.md"
  );
  const beforeResults = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(reportPath, "utf8")
  ]);
  let expectedState: Awaited<ReturnType<typeof readState>> | undefined;
  const report = await withQueuedDoctor(workspace, async () => {
    const task = manifest.nodes.find((node) => node.id === "T-001");
    if (!task || task.type !== "task") throw new Error("Missing fixture task");
    const edit = await updateNode({
      projectRoot: workspace,
      node: {
        ...task,
        blocks: [
          ...task.blocks,
          {
            id: "B-002",
            type: "implementation",
            title: "Concurrent work",
            prompt: "nodes/T-001/blocks/B-002.prompt.md",
            depends_on: []
          }
        ]
      }
    });
    expect(edit.ok).toBe(true);
    expect(await claimBlock({ projectRoot: workspace, ref: "T-001#B-002" })).toMatchObject({
      kind: "block",
      ref: "T-001#B-002",
      reason: "claimed"
    });
    expectedState = await readState(workspace.stateFile);
  });
  expect(report).toMatchObject({ ok: true, issues: [] });
  expect(await readState(workspace.stateFile)).toEqual(expectedState);
  expect(await Promise.all([readFile(indexPath, "utf8"), readFile(reportPath, "utf8")])).toEqual(
    beforeResults
  );
}, 20_000);

it("repairs a block removed during admission only on request and leaves repeated repairs unchanged", async () => {
  const { workspace, manifest } = await completedFixture();
  const ref = "T-001#R-001";
  expect(await claimBlock({ projectRoot: workspace, ref })).toMatchObject({ kind: "block", ref });
  const resultsBefore = await resultSnapshot(workspace.resultsDir);
  const repaired = await withQueuedDoctor(workspace, async () => {
    const edit = await commitPlanPackageGraphMutation({
      projectRoot: workspace,
      mutation: buildPlanPackageGraphMutation(manifest, { kind: "removeBlock", blockRef: ref })
    });
    expect(edit.ok).toBe(true);
    const beforeReadonly = await runtimeSnapshot(workspace);
    const diagnosis = await runDoctor({ projectRoot: workspace });
    expect(diagnosis.issues).toContainEqual(
      expect.objectContaining({ code: "stale_current_ref", ref, repaired: false })
    );
    expect(await runtimeSnapshot(workspace)).toEqual(beforeReadonly);
    expect((await readState(workspace.stateFile)).currentRefs).toContain(ref);
  });
  expect(repaired.issues).toContainEqual(
    expect.objectContaining({ code: "stale_current_ref", ref, repaired: true })
  );
  expect(repaired.ok).toBe(true);
  const state = await readState(workspace.stateFile);
  expect(state.currentRefs).not.toContain(ref);
  expect(state.currentReviewBlockRef).toBeNull();
  expect(state.blocks[ref]).toBeUndefined();
  expect(state.blocks["T-001#B-001"]).toMatchObject({ status: "completed", lastRunId: "RUN-001" });
  expect(await resultSnapshot(workspace.resultsDir)).toEqual(resultsBefore);
  const settled = await runtimeSnapshot(workspace);
  for (const repair of [true, false, true]) {
    expect(await runDoctor({ projectRoot: workspace, repair })).toMatchObject({
      ok: true,
      issues: []
    });
    expect(await runtimeSnapshot(workspace)).toEqual(settled);
  }
}, 20_000);

it.each([
  "passed",
  "needs_changes"
] as const)("preserves a real %s Review and its feedback after a queued manifest type change", async (verdict) => {
  const manifest = remoteManifest();
  const task = manifest.nodes[0];
  if (task.type !== "task") throw new Error("Missing fixture task");
  const review = task.blocks.find((block) => block.id === "R-001");
  if (!review || review.type !== "review") throw new Error("Missing fixture review");
  task.blocks = task.blocks.map((block) =>
    block.id === review.id
      ? {
          id: block.id,
          type: "implementation",
          title: block.title,
          prompt: block.prompt,
          depends_on: block.depends_on
        }
      : block
  );
  const { workspace } = await completedFixture(manifest);
  const ref = "T-001#R-001";
  let expected: Awaited<ReturnType<typeof runtimeSnapshot>> | undefined;
  const diagnosis = await withQueuedDoctor(workspace, async () => {
    const edit = await updateNode({
      projectRoot: workspace,
      node: {
        ...task,
        blocks: task.blocks.map((block) => (block.id === review.id ? review : block))
      }
    });
    expect(edit.ok).toBe(true);
    const port = createRemoteBlockRuntimePort({ projectRoot: workspace });
    const identity = activeIdentity(await port.inspect({ ref }));
    await port.claim({ ref, ...claimIdentity(identity) });
    await port.activate({ ref, ...identity });
    const completed = await port.complete({
      ref,
      ...identity,
      ...reportInput(
        Buffer.from(
          JSON.stringify({
            reviewBlockRef: ref,
            taskId: "T-001",
            verdict,
            content: "Review evidence"
          })
        )
      )
    });
    const state = await readState(workspace.stateFile);
    if (verdict === "passed") {
      expect(state.blocks[ref]).toMatchObject({
        status: "completed",
        remoteOperationReceipt: {
          blockType: "review",
          outcome: "completed",
          runId: completed.runId
        }
      });
    } else {
      const feedbackId = state.blocks[ref].activeFeedbackId;
      expect(feedbackId).toBeTruthy();
      expect(state.feedback[feedbackId!]).toMatchObject({
        status: "open",
        sourceReviewBlockRef: ref
      });
      expect(state.currentFeedbackId).toBe(feedbackId);
      expect(state.currentReviewBlockRef).toBe(ref);
    }
    expected = await runtimeSnapshot(workspace);
  });
  expect(diagnosis).toMatchObject({ ok: true, issues: [] });
  expect(await runtimeSnapshot(workspace)).toEqual(expected);
}, 20_000);

it.each([
  "package",
  "results"
] as const)("rejects queued Doctor repair after a real %s reset without touching replacement storage", async (reset) => {
  const { root, workspace } = await completedFixture();
  let replacement: ProjectWorkspace | undefined;
  let expected: Awaited<ReturnType<typeof runtimeSnapshot>> | undefined;
  await expect(
    withQueuedDoctor(workspace, async () => {
      const initialized = await initWorkspace({
        projectRoot: root,
        ...(reset === "package" ? { resetPackage: true } : { resetResults: true })
      });
      replacement = (await loadPackage(initialized.workspace)).workspace;
      expected = await runtimeSnapshot(replacement);
    })
  ).rejects.toThrow("identity changed");
  if (!replacement) throw new Error("Missing reset workspace");
  expect(await runtimeSnapshot(replacement)).toEqual(expected);
}, 20_000);
