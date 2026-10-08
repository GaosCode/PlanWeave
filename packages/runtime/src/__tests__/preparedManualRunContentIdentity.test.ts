import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capturePackageSnapshot,
  packageSnapshotGraphFingerprint
} from "../package/packageSnapshot.js";
import {
  createLocalPackageAuthoritySource,
  createWorkspaceAuthorityBindingResolver
} from "../workspaceExecution/authorityBinding.js";
import { createLocalWorkspaceExecutionAdapter } from "../workspaceExecution/localExecutionAdapter.js";
import { runAutoRunStep } from "../taskManager/autoRunStep.js";
import { ExecutorClaimRejectedError } from "../autoRun/executorShared.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const originalHome = process.env.PLANWEAVE_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
});

async function fixture() {
  const context = await createTestWorkspace(undefined, { trustPackageExecutors: false });
  const workspace = context.init.workspace;
  const resolver = createWorkspaceAuthorityBindingResolver({
    local: createLocalPackageAuthoritySource(),
    remote: {
      inspect: async () => {
        throw new Error("local execution must not inspect remote authority");
      }
    }
  });
  const adapter = createLocalWorkspaceExecutionAdapter();
  const scope = { kind: "block", blockRef: "T-001#B-001" } as const;
  const runRoot = join(workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
  async function launch() {
    const captured = await capturePackageSnapshot({ projectRoot: workspace });
    const authority = {
      kind: "local_package" as const,
      packageWorkspace: context.root,
      expected: {
        contentRevision: captured.snapshot.sourceRevision,
        graphFingerprint: packageSnapshotGraphFingerprint(captured.snapshot)
      }
    };
    const binding = await resolver.resolve(authority, scope);
    const result = await adapter.launch({
      request: {
        authority,
        scope,
        trigger: "cli",
        target: { policy: "local" },
        eventFormat: "execution-v1"
      },
      binding,
      signal: new AbortController().signal
    });
    return { binding, result };
  }
  async function artifacts() {
    return {
      runs: (await readdir(runRoot)).filter((entry) => entry.startsWith("RUN-")),
      prompt: await readFile(join(runRoot, "RUN-001", "prompt.md"), "utf8"),
      metadata: await readFile(join(runRoot, "RUN-001", "metadata.json"), "utf8"),
      state: await readFile(workspace.stateFile, "utf8")
    };
  }
  return { context, workspace, launch, artifacts };
}

describe("prepared manual RUN captured content identity", () => {
  it("reuses the same attempt, RUN and artifact bytes for repeated authority A", async () => {
    const test = await fixture();
    const first = await test.launch();
    expect(first.result.terminal).toEqual({ terminal: false, reason: "action_required" });
    const before = await test.artifacts();
    const repeated = await test.launch();
    expect(repeated.binding.contentRevision).toBe(first.binding.contentRevision);
    expect(repeated.result.terminal).toEqual(first.result.terminal);
    expect(await test.artifacts()).toEqual(before);
  });

  it.each([
    "prompt",
    "unrendered manifest content"
  ])("rejects authority B after %s changes without overwriting authority A artifacts", async (change) => {
    const test = await fixture();
    const first = await test.launch();
    expect(first.result.terminal).toEqual({ terminal: false, reason: "action_required" });
    const before = await test.artifacts();
    if (change === "prompt") {
      await writeFile(
        join(test.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
        "# AUTHORITY_B\n"
      );
    } else {
      const path = join(test.workspace.packageDir, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.project.description = "Different captured content outside the rendered block prompt";
      await writeFile(path, JSON.stringify(manifest, null, 2));
    }
    const changed = await test.launch();
    expect(changed.binding.contentRevision).not.toBe(first.binding.contentRevision);
    expect(changed.result.terminal).toEqual({ terminal: true, outcome: "failed" });
    expect(changed.result.session.error).toContain("Prepared run 'RUN-001' content conflicts");
    expect(await test.artifacts()).toEqual(before);
  });

  it("refuses an uncaptured attempt when a captured RUN already owns its artifacts", async () => {
    const test = await fixture();
    await test.launch();
    const before = await test.artifacts();
    await expect(runAutoRunStep({ projectRoot: test.context.root })).rejects.toBeInstanceOf(
      ExecutorClaimRejectedError
    );
    expect(await test.artifacts()).toEqual(before);
  });

  it("refuses captured authorization for an existing uncaptured RUN", async () => {
    const test = await fixture();
    expect((await runAutoRunStep({ projectRoot: test.context.root })).kind).toBe("manual");
    const before = await test.artifacts();
    const authorized = await test.launch();
    expect(authorized.result.terminal).toEqual({ terminal: true, outcome: "failed" });
    expect(authorized.result.session.error).toContain("Prepared run 'RUN-001' content conflicts");
    expect(await test.artifacts()).toEqual(before);
  });
});
