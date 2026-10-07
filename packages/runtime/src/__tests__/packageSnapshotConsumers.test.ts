import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import {
  createLocalPackageAuthoritySource,
  createWorkspaceAuthorityBindingResolver
} from "../workspaceExecution/authorityBinding.js";
import { createLocalWorkspaceExecutionAdapter } from "../workspaceExecution/localExecutionAdapter.js";
import { duplicateTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { join } from "node:path";
import { runWithSession } from "../runSessions/runWithSession.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { claimBlock } from "../taskManager/claimScheduler.js";
import { packageExecutionSnapshot } from "../package/packageExecutionSnapshot.js";
import { runAutoRunStep } from "../taskManager/autoRunStep.js";
import { ExecutorCancelledError } from "../autoRun/executorCancellation.js";
import { createExecutorAdapter } from "../autoRun/executors.js";

const boundary = vi.hoisted(() => ({
  afterCapture: undefined as (() => Promise<void>) | undefined
}));
vi.mock("../package/packageSnapshot.js", async (original) => {
  const actual = await original<typeof import("../package/packageSnapshot.js")>();
  return {
    ...actual,
    capturePackageSnapshot: async (...args: Parameters<typeof actual.capturePackageSnapshot>) => {
      const result = await actual.capturePackageSnapshot(...args);
      await boundary.afterCapture?.();
      return result;
    }
  };
});
const roots: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
afterEach(async () => {
  boundary.afterCapture = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
});

async function fixture(parallel = false, nondefault = false) {
  const context = await createTestWorkspace(
    basicManifest({ parallel, maxConcurrent: parallel ? 2 : 1, includeSecondTask: parallel })
  );
  roots.push(context.root, context.home);
  const defaultWorkspace = context.init.workspace;
  let canvasId: string | undefined;
  if (nondefault) {
    const duplicate = await duplicateTaskCanvas(context.root, "default");
    canvasId = duplicate.canvasId;
    context.init.workspace = await resolveTaskCanvasWorkspace(context.root, duplicate.canvasId);
  }
  const captured = await capturePackageSnapshot({ projectRoot: context.init.workspace });
  const graph = await loadPlanGraphPackage(context.init.workspace);
  const expected = {
    contentRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint
  };
  const locator = {
    kind: "local_package" as const,
    packageWorkspace: context.root,
    expected,
    canvasId
  };
  const scope = parallel
    ? { kind: "project" as const }
    : { kind: "block" as const, blockRef: "T-001#B-001" };
  const mutate = async () => {
    const manifest = JSON.parse(await readFile(context.init.workspace.manifestFile, "utf8"));
    manifest.project.title = "changed after capture";
    await writeFile(context.init.workspace.manifestFile, JSON.stringify(manifest));
  };
  return { context, defaultWorkspace, expected, locator, scope, mutate };
}

describe("snapshot versions at authority and execution boundaries", () => {
  it("pairs local authority fingerprint with the exact captured bytes after a source mutation", async () => {
    const f = await fixture();
    boundary.afterCapture = async () => {
      boundary.afterCapture = undefined;
      await f.mutate();
    };
    const inspected = await createLocalPackageAuthoritySource().inspect(f.locator, f.scope);
    expect(inspected).toMatchObject(f.expected);
    expect(
      (await loadPlanGraphPackage(f.context.init.workspace)).graph.packageFingerprint
    ).not.toBe(inspected.graphFingerprint);
  });

  it("rejects content drift after binding before launching a local run", async () => {
    const f = await fixture();
    const resolver = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: { inspect: vi.fn() }
    });
    const binding = await resolver.resolve(f.locator, f.scope);
    await f.mutate();
    const run = vi.fn(async () => {
      throw new Error("unexpected_run_side_effect");
    });
    await expect(
      createLocalWorkspaceExecutionAdapter({ run }).launch({
        request: {
          authority: f.locator,
          scope: f.scope,
          trigger: "cli",
          target: { policy: "local" },
          eventFormat: "execution-v1"
        },
        binding
      })
    ).rejects.toMatchObject({ code: "workspace_content_revision_mismatch" });
    expect(run).not.toHaveBeenCalled();
  });
});

// Real preparation after authority verification must consume the authorized version.
it.each([
  { parallel: false, nondefault: false },
  { parallel: true, nondefault: false },
  { parallel: false, nondefault: true }
])("prepares authorized manual prompts and executors after the run boundary changes files to B (parallel=$parallel, nondefault=$nondefault)", async ({
  parallel,
  nondefault
}) => {
  const f = await fixture(parallel, nondefault);
  const binding = await createWorkspaceAuthorityBindingResolver({
    local: createLocalPackageAuthoritySource(),
    remote: { inspect: vi.fn() }
  }).resolve(f.locator, f.scope);
  const workspace = f.context.init.workspace;
  const promptPath = join(workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md");
  const originalPrompt = await readFile(promptPath, "utf8");
  const originalState = await readFile(workspace.stateFile, "utf8");
  const defaultState = await readFile(f.defaultWorkspace.stateFile, "utf8");
  const capturedPromptMarker = originalPrompt.trim();
  let actualResult: Awaited<ReturnType<typeof runWithSession>> | undefined;
  const adapter = createLocalWorkspaceExecutionAdapter({
    run: async (options) => {
      await writeFile(promptPath, "# UNAUTHORIZED_VERSION_B_MARKER\n");
      const manifest = JSON.parse(await readFile(workspace.manifestFile, "utf8"));
      manifest.executors = { ...manifest.executors, "version-b-only": { adapter: "manual" } };
      for (const task of manifest.nodes) task.blocks[0].executor = "version-b-only";
      manifest.project.title = "UNAUTHORIZED_TITLE_B";
      await writeFile(workspace.manifestFile, JSON.stringify(manifest));
      actualResult = await runWithSession({ ...options, parallel });
      return actualResult;
    }
  });
  const result = await adapter.launch({
    request: {
      authority: f.locator,
      scope: f.scope,
      trigger: "cli",
      target: { policy: "local" },
      eventFormat: "execution-v1"
    },
    binding,
    signal: AbortSignal.timeout(10000)
  });
  expect(actualResult?.terminalReason).toBe("manual");
  const step = actualResult?.steps[0];
  const manualSteps =
    step?.kind === "batch_submitted" ? step.steps : step?.kind === "manual" ? [step] : [];
  expect(manualSteps).toHaveLength(parallel ? 2 : 1);
  for (const manualStep of manualSteps) {
    expect(manualStep.kind).toBe("manual");
    expect(manualStep.adapterResult.executor).toBe("default");
    if (manualStep.claim.ref === "T-001#B-001") {
      const prepared = await readFile(manualStep.adapterResult.promptPath, "utf8");
      expect(prepared).toContain(capturedPromptMarker);
      expect(prepared).not.toContain("UNAUTHORIZED_VERSION_B_MARKER");
      expect(prepared).not.toContain("UNAUTHORIZED_TITLE_B");
    }
  }
  expect(result.handle.authorityBindingId).toBe(binding.bindingId);
  expect(await readFile(promptPath, "utf8")).toBe("# UNAUTHORIZED_VERSION_B_MARKER\n");
  expect(await readFile(workspace.manifestFile, "utf8")).toContain("UNAUTHORIZED_TITLE_B");
  expect(await readFile(workspace.stateFile, "utf8")).not.toBe(originalState);
  if (nondefault) expect(await readFile(f.defaultWorkspace.stateFile, "utf8")).toBe(defaultState);
});

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => {
      if (!process.env.PLANWEAVE_HOME) throw new Error("Expected isolated test home.");
      return { ...actual.userInfo(), homedir: process.env.PLANWEAVE_HOME };
    }
  };
});

it.each([
  "add",
  "delete",
  "change-type"
] as const)("rejects incompatible canonical B state without overwriting its real claim (%s)", async (change) => {
  const f = await fixture();
  const binding = await createWorkspaceAuthorityBindingResolver({
    local: createLocalPackageAuthoritySource(),
    remote: { inspect: vi.fn() }
  }).resolve(f.locator, f.scope);
  const workspace = f.context.init.workspace;
  let canonicalState: string | undefined;
  const adapter = createLocalWorkspaceExecutionAdapter({
    run: async (options) => {
      const manifest = basicManifest({ includeSecondTask: true });
      const target = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
      if (target?.type !== "task") throw new Error("Expected target task.");
      if (change === "delete") {
        manifest.nodes = manifest.nodes.filter((node) => node.id !== "T-001");
        manifest.edges = [];
      }
      if (change === "change-type") {
        const review = target.blocks.find((block) => block.type === "review");
        if (!review) throw new Error("Expected review block.");
        target.blocks = [{ ...review, id: "B-001", depends_on: [] }];
      }
      await writeFile(workspace.manifestFile, JSON.stringify(manifest));
      await writePromptFiles(workspace.packageDir, manifest);
      const claimed = await claimBlock({ projectRoot: workspace, ref: "T-002#B-001" });
      expect(claimed.kind).toBe("block");
      const raw = await readFile(workspace.stateFile, "utf8");
      expect(JSON.parse(raw).blocks["T-002#B-001"].submissionAttemptId).toEqual(expect.any(String));
      canonicalState = raw;
      return runWithSession(options);
    }
  });
  await expect(
    adapter.launch({
      request: {
        authority: f.locator,
        scope: f.scope,
        trigger: "cli",
        target: { policy: "local" },
        eventFormat: "execution-v1"
      },
      binding,
      signal: AbortSignal.timeout(10000)
    })
  ).rejects.toMatchObject({ code: "package_execution_state_conflict" });
  expect(canonicalState).toBeDefined();
  expect(await readFile(workspace.stateFile, "utf8")).toBe(canonicalState);
});

it.each([
  "failure",
  "cancel"
] as const)("preserves canonical B claims and the original %s when cleanup is incompatible", async (mode) => {
  const f = await fixture();
  const workspace = f.context.init.workspace;
  const captured = await capturePackageSnapshot({ projectRoot: workspace });
  const executionSnapshot = packageExecutionSnapshot(workspace, captured.snapshot);
  const originalError =
    mode === "cancel"
      ? new ExecutorCancelledError("original cancellation")
      : new Error("original executor failure");
  let canonicalState: string | undefined;
  await expect(
    runAutoRunStep({
      projectRoot: workspace,
      executionSnapshot,
      scope: f.scope,
      executor: {
        runBlock: async () => {
          const manifest = basicManifest({
            includeSecondTask: true,
            parallel: true,
            maxConcurrent: 2
          });
          await writeFile(workspace.manifestFile, JSON.stringify(manifest));
          await writePromptFiles(workspace.packageDir, manifest);
          expect(
            (await claimBlock({ projectRoot: workspace, ref: "T-002#B-001", dispatch: true })).kind
          ).toBe("block");
          canonicalState = await readFile(workspace.stateFile, "utf8");
          throw originalError;
        },
        runFeedback: async () => {
          throw new Error("unexpected feedback execution");
        }
      },
      signal: AbortSignal.timeout(10000)
    })
  ).rejects.toBe(originalError);
  expect(canonicalState).toBeDefined();
  expect(await readFile(workspace.stateFile, "utf8")).toBe(canonicalState);
});

it("rejects a deleted target at actual manual preparation after the A claim", async () => {
  const f = await fixture();
  const workspace = f.context.init.workspace;
  const captured = await capturePackageSnapshot({ projectRoot: workspace });
  const executionSnapshot = packageExecutionSnapshot(workspace, captured.snapshot);
  const actualExecutor = createExecutorAdapter({ projectRoot: workspace, executionSnapshot });
  let canonicalState: string | undefined;
  await expect(
    runAutoRunStep({
      projectRoot: workspace,
      executionSnapshot,
      scope: f.scope,
      executor: {
        ...actualExecutor,
        runBlock: async (input) => {
          const manifest = basicManifest({ includeSecondTask: true });
          manifest.nodes = manifest.nodes.filter((node) => node.id !== "T-001");
          await writeFile(workspace.manifestFile, JSON.stringify(manifest));
          await writePromptFiles(workspace.packageDir, manifest);
          expect((await claimBlock({ projectRoot: workspace, ref: "T-002#B-001" })).kind).toBe(
            "block"
          );
          canonicalState = await readFile(workspace.stateFile, "utf8");
          return actualExecutor.runBlock(input);
        }
      },
      signal: AbortSignal.timeout(10000)
    })
  ).rejects.toMatchObject({ code: "package_execution_state_conflict" });
  expect(canonicalState).toBeDefined();
  expect(await readFile(workspace.stateFile, "utf8")).toBe(canonicalState);
});
