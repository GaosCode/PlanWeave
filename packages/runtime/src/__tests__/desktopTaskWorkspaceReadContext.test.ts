import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as graphSession from "../graph/session.js";
import * as planGraphRepository from "../plangraph/packageRepository.js";
import * as executionStatus from "../taskManager/executionStatus.js";
import * as projectGraphClaimGuard from "../taskManager/projectGraphClaimGuard.js";
import * as runtimeContext from "../taskManager/runtimeContext.js";
import * as canvasApi from "../desktop/canvasApi.js";
import { createTaskWorkspaceReadContext } from "../desktop/taskWorkspaceReadContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

describe("TaskWorkspaceReadContext", () => {
  it("loads each request-level runtime snapshot once", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const resolveWorkspace = vi.spyOn(canvasApi, "resolveTaskCanvasWorkspace");
    const createSession = vi.spyOn(graphSession, "createExecutionGraphSession");
    const loadRuntime = vi.spyOn(runtimeContext, "loadRuntimeReadonly");
    const createClaimGuard = vi.spyOn(projectGraphClaimGuard, "createProjectGraphClaimGuard");
    const buildStatus = vi.spyOn(executionStatus, "buildExecutionStatus");
    const loadPlanGraph = vi.spyOn(planGraphRepository, "loadPlanGraphPackage");

    const context = await createTaskWorkspaceReadContext({
      projectRoot: root,
      canvasId: "default"
    });

    expect(resolveWorkspace).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(createClaimGuard).toHaveBeenCalledTimes(1);
    expect(buildStatus).toHaveBeenCalledTimes(1);
    expect(loadPlanGraph).toHaveBeenCalledTimes(1);
    expect(context.status.projectId).toBe(context.runtime.workspace.id);
    expect(context.planGraphPackage.workspace).toEqual(context.runtime.workspace);
  });

  it("memoizes prompt sources within one request and isolates separate requests", async () => {
    const { home, root, init } = await createTestWorkspace(basicManifest());
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "global-prompt.md"), "global prompt\n", "utf8");
    await mkdir(join(init.workspace.workspaceRoot, "policy"), { recursive: true });
    await writeFile(init.workspace.projectPromptFile, "project prompt\n", "utf8");
    const reportPath = join(home, "report.md");
    await writeFile(reportPath, "report body\n", "utf8");

    const firstContext = await createTaskWorkspaceReadContext({ projectRoot: root });
    const reader = firstContext.promptSourceReader;

    const policy = reader.readProjectPromptPolicy();
    expect(reader.readProjectPromptPolicy()).toBe(policy);
    const globalPrompt = reader.readGlobalPrompt();
    expect(reader.readGlobalPrompt()).toBe(globalPrompt);
    const projectPrompt = reader.readProjectPrompt();
    expect(reader.readProjectPrompt()).toBe(projectPrompt);
    const packagePrompt = reader.readPackagePrompt("nodes/T-001/prompt.md");
    expect(reader.readPackagePrompt("nodes/T-001/prompt.md")).toBe(packagePrompt);
    const report = reader.readLatestReportSnippet(reportPath);
    expect(reader.readLatestReportSnippet(reportPath)).toBe(report);

    await expect(policy).resolves.toEqual({ includeGlobalPrompt: true });
    await expect(globalPrompt).resolves.toEqual({ markdown: "global prompt\n", missing: false });
    await expect(projectPrompt).resolves.toEqual({ markdown: "project prompt\n", missing: false });
    await expect(packagePrompt).resolves.toEqual({
      markdown: "# T-001 task prompt\n",
      missing: false
    });
    await expect(report).resolves.toBe("report body");

    const secondContext = await createTaskWorkspaceReadContext({ projectRoot: root });
    expect(secondContext).not.toBe(firstContext);
    expect(secondContext.promptSourceReader).not.toBe(reader);
    expect(secondContext.promptSourceReader.readProjectPrompt()).not.toBe(projectPrompt);
  });

  it("preserves required and allow-missing prompt semantics", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const { promptSourceReader } = await createTaskWorkspaceReadContext({ projectRoot: root });

    await expect(
      promptSourceReader.readPackagePrompt("nodes/T-001/missing.prompt.md", {
        allowMissing: true
      })
    ).resolves.toEqual({ markdown: "", missing: true });
    await expect(
      promptSourceReader.readPackagePrompt("nodes/T-001/missing.prompt.md")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
