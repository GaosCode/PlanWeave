import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorizedCanvasRuntimeStatusProjection,
  readAuthorizedCanvasRuntimeStatus
} from "../desktop/canvasRuntimeStatus.js";
import { loadDesktopGraphViewModelContext } from "../desktop/graph/readModel.js";
import { readState, writeState } from "../state.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("authorized canvas runtime status", () => {
  it("returns current task/block statuses without device-private runtime fields", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const state = await readState(fixture.init.workspace.stateFile);
    state.blocks["T-001#B-001"] = {
      status: "completed",
      lastRunId: "private-run-id"
    };
    state.blocks["T-001#R-001"] = {
      status: "completed",
      completionReason: "passed",
      lastRunId: "private-review-run-id"
    };
    await writeState(fixture.init.workspace.stateFile, state);

    const projection = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: fixture.root,
      canvasId: "default",
      expectedPackageDir: fixture.init.workspace.packageDir,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      capturedAt: "2026-08-01T00:00:00.000Z"
    });

    expect(projection.tasks).toContainEqual({
      taskId: "T-001",
      status: "implemented",
      openFeedbackCount: 0
    });
    expect(projection.blocks).toContainEqual({
      ref: "T-001#R-001",
      status: "completed",
      completionReason: "passed",
      blockedReason: null,
      divergenceReason: null,
      dispatchable: false
    });
    expect(JSON.stringify(projection)).not.toContain("private-run-id");
  });

  it("projects required reviews through remote dispatch readiness", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const initialContext = await loadDesktopGraphViewModelContext(fixture.init.workspace);
    const initial = await buildAuthorizedCanvasRuntimeStatusProjection({
      context: initialContext,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });
    expect(initial.blocks.find((block) => block.ref === "T-001#R-001")?.dispatchable).toBe(false);

    const state = await readState(fixture.init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "completed", lastRunId: "RUN-001" };
    await writeState(fixture.init.workspace.stateFile, state);
    const readyContext = await loadDesktopGraphViewModelContext(fixture.init.workspace);
    const ready = await buildAuthorizedCanvasRuntimeStatusProjection({
      context: readyContext,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });

    expect(ready.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "ready",
      dispatchable: true
    });
  });

  it("does not charge an open-feedback review against remote dispatch capacity", async () => {
    const fixture = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 1, includeSecondTask: true })
    );
    directories.push(fixture.home, fixture.root);
    const state = await readState(fixture.init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "completed", lastRunId: "RUN-001" };
    state.blocks["T-001#R-001"] = { status: "in_progress", lastRunId: "RUN-002" };
    state.currentRefs = [];
    state.currentReviewBlockRef = "T-001#R-001";
    state.currentFeedbackId = "FE-001";
    state.feedback["FE-001"] = {
      status: "open",
      sourceReviewBlockRef: "T-001#R-001",
      latestSubmissionId: null,
      content: "Review feedback"
    };
    await writeState(fixture.init.workspace.stateFile, state);
    const context = await loadDesktopGraphViewModelContext(fixture.init.workspace);
    const projection = await buildAuthorizedCanvasRuntimeStatusProjection({
      context,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });

    expect(projection.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      dispatchable: false
    });
    expect(projection.blocks.find((block) => block.ref === "T-002#B-001")).toMatchObject({
      status: "ready",
      dispatchable: true
    });
  });

  it("rejects a package path outside the authorized canvas", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);

    await expect(
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: fixture.root,
        canvasId: "default",
        expectedPackageDir: `${fixture.init.workspace.packageDir}-other`,
        scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
      })
    ).rejects.toThrow("runtime_package_location_mismatch");
  });

  it("reads an explicit managed workspace without resolving its source cwd", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const explicitWorkspace = {
      ...fixture.init.workspace,
      rootPath: "/source-cwd-must-not-be-resolved",
      sourceRoot: "/source-cwd-must-not-be-resolved"
    };

    await expect(
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: explicitWorkspace,
        canvasId: "default",
        expectedPackageDir: explicitWorkspace.packageDir,
        scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
      })
    ).resolves.toMatchObject({
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });
  });

  it("keeps runtime status and package fingerprint on one captured graph snapshot", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const context = await loadDesktopGraphViewModelContext(fixture.init.workspace);
    const before = await buildAuthorizedCanvasRuntimeStatusProjection({
      context,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      capturedAt: "2026-08-01T00:00:00.000Z"
    });
    const laterManifest = structuredClone(context.manifest);
    laterManifest.project.title = "Later manifest version";
    await writeFile(
      fixture.init.workspace.manifestFile,
      `${JSON.stringify(laterManifest, null, 2)}\n`,
      "utf8"
    );

    const after = await buildAuthorizedCanvasRuntimeStatusProjection({
      context,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      capturedAt: "2026-08-01T00:00:00.000Z"
    });

    expect(after.packageFingerprint).toBe(before.packageFingerprint);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.blocks).toEqual(before.blocks);
  });
});
