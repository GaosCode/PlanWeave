import fs from "node:fs/promises";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const home = process.env.PW_AUTHORITY_LOCK_TEST_HOME;
const mode = process.env.PW_AUTHORITY_LOCK_TEST_MODE;
if (!home || !mode) throw new Error("Expected isolated child environment.");
const oldRename = fs.rename;
fs.rename = async (...args) => {
  if (mode === "rollback" && String(args[0]).endsWith(".layout.json"))
    throw new Error("controlled_layout_install_failure");
  return Reflect.apply(oldRename, fs, args);
};
const oldUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...oldUserInfo(...args), homedir: home });
process.env.PLANWEAVE_HOME = home;
process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");
syncBuiltinESMExports();
const { createTestWorkspace } = await import("../promptTestHelpers.js");
const { capturePackageSnapshot } = await import("../../package/packageSnapshot.js");
const { packageExecutionSnapshot } = await import("../../package/packageExecutionSnapshot.js");
const { captureAuthorizedCanvasContent } = await import("../../desktop/authorizedCanvasContent.js");
const { materializeAuthoritativeCanvasWorkspace } = await import(
  "../../desktop/contentVersionMaterializer.js"
);
const { claimBlock } = await import("../../taskManager/claimScheduler.js");
const { createExecutorAdapter } = await import("../../autoRun/executors.js");
const { submitBlockResult } = await import("../../taskManager/blockSubmission.js");
const f = await createTestWorkspace(undefined, {
  planweaveHome: home,
  trustPackageExecutors: false
});
const w = f.init.workspace;
process.stdout.write(`${JSON.stringify({ kind: "fixture", root: f.root })}\n`);
const snapshot = packageExecutionSnapshot(
  w,
  (await capturePackageSnapshot({ projectRoot: w })).snapshot
);
const { saveDesktopLayout } = await import("../../desktop/layoutApi.js");
await saveDesktopLayout(w, {
  version: "desktop-layout/v1",
  projectId: w.id,
  nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
  updatedAt: "2026-10-08T00:00:00.000Z"
});
const { content } = await captureAuthorizedCanvasContent({ projectRoot: w });
const ref = "T-001#B-001";
const claim =
  mode === "prepare" || mode === "submit"
    ? await claimBlock({ projectRoot: w, ref, executionSnapshot: snapshot })
    : undefined;
if (claim && claim.kind !== "block") throw new Error("Expected real initial claim.");
const report = join(home, "report.md");
await fs.writeFile(report, "# complete implementation\n");
const beforeManifest = await fs.readFile(w.manifestFile, "utf8");
const beforeLayout = await fs.readFile(join(w.workspaceRoot, "desktop", "layout.json"), "utf8");
const packageLock = join(
  home,
  ".cache",
  "planweave",
  "package-locks",
  createHash("sha256")
    .update(await fs.realpath(w.packageDir))
    .digest("hex")
);
let enter!: () => void;
let release!: () => void;
let request!: () => void;
let held!: () => void;
const entered = new Promise<void>((resolve) => {
  enter = resolve;
});
const resume = new Promise<void>((resolve) => {
  release = resolve;
});
const requested = new Promise<void>((resolve) => {
  request = resolve;
});
const packageHeld = new Promise<void>((resolve) => {
  held = resolve;
});
const oldWrite = fs.writeFile;
const oldReal = fs.realpath;
let paused = false;
let stateStarted = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let blocker: ReturnType<typeof setInterval> | undefined;
try {
  fs.writeFile = async (...args) => {
    await Reflect.apply(oldWrite, fs, args);
    const path = String(args[0]);
    if (!paused && path.includes(".planweave-content-version-") && path.endsWith("manifest.json")) {
      paused = true;
      enter();
      await resume;
    }
    if (stateStarted && path === join(packageLock, "holder.json")) held();
  };
  fs.realpath = async (...args) => {
    const path = await Reflect.apply(oldReal, fs, args);
    if (
      stateStarted &&
      [w.workspaceRoot, w.packageDir, w.stateFile, w.resultsDir].includes(String(args[0]))
    )
      request();
    return path;
  };
  syncBuiltinESMExports();
  const materialization = materializeAuthoritativeCanvasWorkspace({ workspace: w, content });
  // Attach a rejection observer immediately; rollback errors remain part of the final result.
  void materialization.catch(() => {});
  await entered;
  let initialPackageHolder: unknown;
  try {
    initialPackageHolder = JSON.parse(await fs.readFile(join(packageLock, "holder.json"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  stateStarted = true;
  const operation = (async () => {
    if (mode === "prepare") {
      if (!claim || claim.kind !== "block") throw new Error("Expected claim.");
      return createExecutorAdapter({ projectRoot: w, executionSnapshot: snapshot }).runBlock({
        claim,
        prompt: "# captured A prompt\n"
      });
    }
    if (mode === "submit") {
      if (!claim || claim.kind !== "block") throw new Error("Expected claim.");
      return submitBlockResult({
        projectRoot: w,
        ref,
        reportPath: report,
        submissionAttemptId: claim.submissionAttemptId,
        executionSnapshot: snapshot
      });
    }
    return claimBlock({ projectRoot: w, ref, executionSnapshot: snapshot });
  })();
  void operation.catch(() => {});
  await requested;
  // Observe package-lock ownership before resuming materialization.
  if (!initialPackageHolder) await packageHeld;
  release();
  const results = await Promise.race([
    Promise.allSettled([materialization, operation]),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2500);
    })
  ]);
  clearTimeout(timer);
  if (!results) {
    const canvas = JSON.parse(
      await fs.readFile(join(dirname(w.stateFile), ".planweave.lock", "holder.json"), "utf8")
    );
    const pkg = JSON.parse(await fs.readFile(join(packageLock, "holder.json"), "utf8"));
    process.stdout.write(
      `${JSON.stringify({ kind: "pending", canvasOperation: canvas.operation, packageOperation: pkg.operation })}\n`
    );
    blocker = setInterval(() => {}, 1000);
    await new Promise<void>(() => {});
  }
  const [materialized, stateOperation] = results;
  if (mode === "rollback") {
    assert.equal(materialized.status, "rejected");
    if (materialized.status === "rejected")
      assert.match(String(materialized.reason), /controlled_layout_install_failure/);
  } else assert.equal(materialized.status, "fulfilled");
  assert.equal(stateOperation.status, "fulfilled");
  const state = JSON.parse(await fs.readFile(w.stateFile, "utf8"));
  assert.ok(state.blocks[ref].submissionAttemptId);
  assert.equal(state.blocks[ref].status, mode === "submit" ? "completed" : "in_progress");
  if (mode !== "submit") assert.ok(state.currentRefs.includes(ref));
  assert.equal(await fs.readFile(w.manifestFile, "utf8"), beforeManifest);
  assert.equal(
    await fs.readFile(join(w.workspaceRoot, "desktop", "layout.json"), "utf8"),
    beforeLayout
  );
  if (mode === "prepare" && stateOperation.status === "fulfilled") {
    const result = stateOperation.value;
    if (!result || !("promptPath" in result) || typeof result.promptPath !== "string")
      throw new Error("Expected actual manual preparation.");
    assert.equal(await fs.readFile(result.promptPath, "utf8"), "# captured A prompt\n");
  }
  assert.deepEqual(
    await fs.readdir(join(w.workspaceRoot, "desktop", "recovery", "package-import")),
    []
  );
  process.stdout.write(
    `${JSON.stringify({ kind: "completed", mode, status: state.blocks[ref].status, pairedContentPreserved: true })}\n`
  );
} finally {
  clearTimeout(timer);
  clearInterval(blocker);
  fs.writeFile = oldWrite;
  fs.realpath = oldReal;
  fs.rename = oldRename;
  os.userInfo = oldUserInfo;
  syncBuiltinESMExports();
  await fs.rm(f.root, { recursive: true, force: true });
}
