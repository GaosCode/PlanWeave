import { afterEach, describe, expect, it, vi } from "vitest";
import * as planGraphRepository from "../plangraph/packageRepository.js";
import * as stateStore from "../state.js";
import * as projectGraphClaimGuard from "../taskManager/projectGraphClaimGuard.js";
import { buildBlockDetail } from "../desktop/graph/readModel.js";
import { createTaskWorkspaceReadContext } from "../desktop/taskWorkspaceReadContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

describe("Task Workspace read-context error propagation", () => {
  it("propagates PlanGraph load failures unchanged", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const failure = new Error("plan graph unavailable");
    vi.spyOn(planGraphRepository, "loadPlanGraphPackage").mockRejectedValueOnce(failure);

    await expect(createTaskWorkspaceReadContext({ projectRoot: root })).rejects.toBe(failure);
  });

  it("propagates state read failures unchanged", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const failure = new Error("state read failed");
    vi.spyOn(stateStore, "readState").mockRejectedValueOnce(failure);

    await expect(createTaskWorkspaceReadContext({ projectRoot: root })).rejects.toBe(failure);
  });

  it("propagates claim-guard failures unchanged", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const failure = new Error("claim guard failed");
    vi.spyOn(
      projectGraphClaimGuard,
      "createProjectGraphClaimGuardFromAggregation"
    ).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(createTaskWorkspaceReadContext({ projectRoot: root })).rejects.toBe(failure);
  });

  it("propagates prompt source failures unchanged", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const context = await createTaskWorkspaceReadContext({ projectRoot: root });
    const failure = new Error("project prompt read failed");
    vi.spyOn(context.promptSourceReader, "readProjectPrompt").mockRejectedValue(failure);

    await expect(buildBlockDetail(context, "T-001#B-001")).rejects.toBe(failure);
  });
});
