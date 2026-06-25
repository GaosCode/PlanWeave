import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimBlock, claimNext } from "../taskManager/index.js";
import { createRunSession, getRunSession, resetRuntimeState } from "../runSessions/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readState } from "../state.js";
import type { RuntimeState } from "../types.js";
import { resolveProjectCanvasWorkspace, writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

describe("resetRuntimeState", () => {
  it("refuses active work unless forced", async () => {
    const { root } = await createTestWorkspace();
    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });

    await expect(resetRuntimeState({ projectRoot: root })).rejects.toThrow("Cannot reset runtime state while active work exists");
  });

  it("refuses raw active refs even when they are stale for the current manifest", async () => {
    const { root, init } = await createTestWorkspace();
    const staleState: RuntimeState = {
      ...(await readState(init.workspace.stateFile)),
      currentRefs: ["T-404#B-001"]
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(staleState, null, 2)}\n`, "utf8");

    await expect(resetRuntimeState({ projectRoot: root })).rejects.toThrow("currentRefs=T-404#B-001");
  });

  it("resets canvas state from the current manifest and preserves package and results", async () => {
    const { root, init } = await createTestWorkspace();
    const resultPath = join(init.workspace.resultsDir, "kept.txt");
    await mkdir(init.workspace.resultsDir, { recursive: true });
    await writeFile(resultPath, "existing result\n", "utf8");
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });

    const result = await resetRuntimeState({ projectRoot: root, force: true });
    const state = await readJsonFile<RuntimeState>(init.workspace.stateFile);

    expect(result).toEqual({
      statePath: init.workspace.stateFile,
      forced: true,
      previousCurrentRefs: ["T-001#B-001"],
      previousCurrentFeedbackId: null,
      previousCurrentReviewBlockRef: null,
      previousInProgressRefs: ["T-001#B-001"],
      sessionId: null
    });
    expect(state.currentRefs).toEqual([]);
    expect(state.currentFeedbackId).toBeNull();
    expect(state.currentReviewBlockRef).toBeNull();
    expect(state.blocks["T-001#B-001"]).toMatchObject({ status: "ready", lastRunId: null });
    expect(state.blocks["T-001#R-001"]).toMatchObject({ status: "planned", lastRunId: null });
    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(resultPath, "utf8")).resolves.toBe("existing result\n");
  });

  it("returns active feedback and review summary when forced", async () => {
    const { root, init } = await createTestWorkspace();
    const activeState: RuntimeState = {
      ...(await readState(init.workspace.stateFile)),
      currentRefs: [],
      currentFeedbackId: "FE-001",
      currentReviewBlockRef: "T-001#R-001",
      feedback: {
        "FE-001": {
          status: "in_progress",
          sourceReviewBlockRef: "T-001#R-001",
          latestSubmissionId: null,
          content: "Fix tests."
        }
      }
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(activeState, null, 2)}\n`, "utf8");

    const result = await resetRuntimeState({ projectRoot: root, force: true });

    expect(result).toMatchObject({
      previousCurrentRefs: [],
      previousCurrentFeedbackId: "FE-001",
      previousCurrentReviewBlockRef: "T-001#R-001",
      previousInProgressRefs: []
    });
  });

  it("appends reset event and updates session summary when a session is supplied", async () => {
    const { root } = await createTestWorkspace();
    const session = await createRunSession({ projectRoot: root, kind: "reset" });

    const result = await resetRuntimeState({ projectRoot: root, session });
    const detail = await getRunSession(root, session.sessionId);

    expect(result.sessionId).toBe(session.sessionId);
    expect(detail.session).toMatchObject({
      sessionId: session.sessionId,
      phase: "resetting",
      reset: expect.objectContaining({ performed: true, forced: false })
    });
    expect(detail.events.map((event) => event.type)).toEqual(["session_started", "reset_completed"]);
  });

  it("rejects invalid session ids before writing reset state", async () => {
    const { root, init } = await createTestWorkspace();
    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });

    await expect(resetRuntimeState({ projectRoot: root, force: true, sessionId: "../SESSION-0001" })).rejects.toThrow("Invalid run session id");

    const state = await readState(init.workspace.stateFile);
    expect(state.currentRefs).toEqual(["T-001#B-001"]);
    expect(state.blocks["T-001#B-001"]).toMatchObject({ status: "in_progress" });
  });

  it("lets claim-next return the first ready block after reset", async () => {
    const { root } = await createTestWorkspace();
    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });
    await resetRuntimeState({ projectRoot: root, force: true });

    await expect(claimNext({ projectRoot: root })).resolves.toMatchObject({
      kind: "block",
      ref: "T-001#B-001",
      reason: "claimed"
    });
  });

  it("resets only the selected non-default canvas workspace", async () => {
    const { root, init } = await createTestWorkspace();
    const secondaryManifest = basicManifest();
    const secondaryPackageDir = join(init.workspace.workspaceRoot, "canvases", "secondary", "package");
    await writeJsonFile(join(secondaryPackageDir, "manifest.json"), secondaryManifest);
    await writePromptFiles(secondaryPackageDir, secondaryManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          title: "Default",
          packageDir: "canvases/default/package",
          stateFile: "canvases/default/state.json",
          resultsDir: "canvases/default/results"
        },
        {
          id: "secondary",
          type: "canvas",
          title: "Secondary",
          packageDir: "canvases/secondary/package",
          stateFile: "canvases/secondary/state.json",
          resultsDir: "canvases/secondary/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });
    const secondary = await resolveProjectCanvasWorkspace(root, "secondary");
    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });
    await claimBlock({ projectRoot: secondary, ref: "T-001#B-001" });

    await resetRuntimeState({ projectRoot: secondary, force: true });

    expect((await readState(init.workspace.stateFile)).currentRefs).toEqual(["T-001#B-001"]);
    expect((await readState(secondary.stateFile)).currentRefs).toEqual([]);
    expect((await readState(secondary.stateFile)).blocks["T-001#B-001"]).toMatchObject({ status: "ready" });
  });
});
