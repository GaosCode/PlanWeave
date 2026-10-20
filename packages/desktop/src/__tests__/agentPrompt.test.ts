/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DesktopAgentPromptIdentity, DesktopBridgeApi } from "@planweave-ai/runtime";
import { useAgentPrompt } from "../renderer/hooks/useAgentPrompt";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
afterEach(cleanupRendererTestEnvironment);
import { buildAgentScopePrompt, writeAgentScopePromptToClipboard } from "../renderer/agentPrompt";

const project = {
  projectId: "P-001",
  rootPath: "/tmp/plan-project",
  sourceRoot: "/tmp/source-root",
  workspaceRoot: "/tmp/plan-project"
};

describe("agent scope prompt", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  it("builds canvas scope without skill or status summary", () => {
    expect(
      buildAgentScopePrompt({
        project,
        canvasId: "default",
        packageDir: "canvases/default/package"
      })
    ).toBe(
      "projectId: P-001\nprojectRoot: /tmp/plan-project\nworkspaceRoot: /tmp/plan-project\ncanvasId: default\npackageDir: /tmp/plan-project/canvases/default/package\nsourceRoot: /tmp/source-root"
    );
  });

  it("adds task_id only when task scope is present", () => {
    const prompt = buildAgentScopePrompt({
      project,
      canvasId: "default",
      packageDir: "/tmp/absolute-package",
      taskId: "T-001"
    });

    expect(prompt).toBe(
      "projectId: P-001\nprojectRoot: /tmp/plan-project\nworkspaceRoot: /tmp/plan-project\ncanvasId: default\npackageDir: /tmp/absolute-package\nsourceRoot: /tmp/source-root\ntask_id: T-001"
    );
    expect(prompt).not.toContain("skill");
    expect(prompt).not.toContain("status");
  });

  it("keeps workspace and packageDir when projectRoot matches sourceRoot", () => {
    const externalProject = {
      projectId: "P-EXT",
      rootPath: "/tmp/source-root",
      sourceRoot: "/tmp/source-root",
      workspaceRoot: "/tmp/.planweave/P-EXT"
    };

    expect(
      buildAgentScopePrompt({
        project: externalProject,
        canvasId: "default",
        packageDir: "canvases/default/package"
      })
    ).toContain(
      "workspaceRoot: /tmp/.planweave/P-EXT\ncanvasId: default\npackageDir: /tmp/.planweave/P-EXT/canvases/default/package"
    );
  });

  it("rejects unavailable packageDir instead of writing an unusable prompt", async () => {
    expect(() => buildAgentScopePrompt({ project, canvasId: "default", packageDir: "" })).toThrow(
      "Cannot build agent prompt because packageDir is unavailable."
    );

    await expect(
      writeAgentScopePromptToClipboard({ project, canvasId: "default", packageDir: "" })
    ).rejects.toThrow("Cannot build agent prompt because packageDir is unavailable.");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("agent prompt operation ownership", () => {
  it.each([
    "send",
    "cancel"
  ] as const)("ignores late %s failures and settlement while B owns another turn", async (failureKind) => {
    const first: DesktopAgentPromptIdentity = {
      ref: { projectRoot: "/project", canvasId: "main" },
      recordId: "A",
      executorRunId: "run-A",
      claimRef: "T-001#B-001",
      sessionId: "session-A"
    };
    const second = { ...first, recordId: "B" };
    let fail!: (error: Error) => void;
    let finishB!: (state: Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>) => void;
    const firstPending = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const secondPending = new Promise<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>(
      (resolve) => {
        finishB = resolve;
      }
    );
    let finishA!: (state: Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>) => void;
    const firstSend = new Promise<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>(
      (resolve) => {
        finishA = resolve;
      }
    );
    const sendAgentPrompt = vi.fn<DesktopBridgeApi["sendAgentPrompt"]>((request) =>
      request.identity.recordId === "B"
        ? secondPending
        : failureKind === "send"
          ? firstPending
          : firstSend
    );
    const api = { sendAgentPrompt, cancelAgentPromptTurn: vi.fn(() => firstPending) };
    const view = renderHook(
      ({ identity }) =>
        useAgentPrompt({ api, identity, runtimeInFlight: false, completedContinuation: true }),
      { initialProps: { identity: first } }
    );
    let a!: Promise<boolean>;
    let cancel!: Promise<boolean>;
    act(() => {
      a = view.result.current.send("A");
    });
    if (failureKind === "cancel")
      act(() => {
        cancel = view.result.current.cancel();
      });
    view.rerender({ identity: second });
    let b!: Promise<boolean>;
    act(() => {
      b = view.result.current.send("B");
    });
    await act(async () => {
      fail(new Error("A failed late"));
      await (failureKind === "send" ? a : cancel);
    });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.inFlight).toBe(true);
    expect(view.result.current.cancelling).toBe(false);
    expect(view.result.current.turnCancellable).toBe(true);
    const requests = sendAgentPrompt.mock.calls;
    await act(async () => {
      const terminal = (identity: (typeof requests)[number][0]["identity"]) => ({
        identity,
        phase: "terminal" as const,
        terminal: "succeeded" as const,
        cancellable: false,
        cancellationRequested: false
      });
      finishA(terminal(requests[0]![0].identity));
      finishB(terminal(requests[1]![0].identity));
      await Promise.all([a, b]);
    });
    expect(view.result.current.inFlight).toBe(false);
  });

  it.each([
    "projectRoot",
    "canvasId",
    "recordId",
    "executorRunId",
    "claimRef",
    "sessionId"
  ] as const)("isolates %s while A is pending and restores A without allowing a duplicate turn", async (field) => {
    const first: DesktopAgentPromptIdentity = {
      ref: { projectRoot: "/project", canvasId: "main" },
      recordId: "A",
      executorRunId: "run-A",
      claimRef: "T-001#B-001",
      sessionId: "session-A"
    };
    const second =
      field === "projectRoot" || field === "canvasId"
        ? { ...first, ref: { ...first.ref, [field]: `${first.ref[field]}-B` } }
        : { ...first, [field]: `${first[field]}-B` };
    let finish!: (state: Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>(
      (resolve) => {
        finish = resolve;
      }
    );
    const sendAgentPrompt = vi
      .fn<DesktopBridgeApi["sendAgentPrompt"]>((request) =>
        Promise.resolve({
          identity: request.identity,
          phase: "terminal",
          terminal: "succeeded",
          cancellable: false,
          cancellationRequested: false
        })
      )
      .mockReturnValueOnce(pending);
    const api = { sendAgentPrompt };
    const view = renderHook(
      ({ identity }) =>
        useAgentPrompt({
          api,
          identity,
          runtimeInFlight: false,
          completedContinuation: true
        }),
      { initialProps: { identity: first } }
    );
    let firstRequest!: Promise<boolean>;
    act(() => {
      firstRequest = view.result.current.send("A text");
    });
    view.rerender({ identity: second });
    expect(view.result.current.inFlight).toBe(false);
    let secondRequest!: Promise<boolean>;
    act(() => {
      secondRequest = view.result.current.send("B text");
    });
    expect(sendAgentPrompt).toHaveBeenCalledTimes(2);
    view.rerender({ identity: { ...first, ref: { ...first.ref } } });
    expect(view.result.current.inFlight).toBe(true);
    await act(async () => {
      expect(await view.result.current.send("duplicate A")).toBe(false);
    });
    expect(sendAgentPrompt).toHaveBeenCalledTimes(2);
    const request = sendAgentPrompt.mock.calls[0]![0];
    await act(async () => {
      finish({
        identity: request.identity,
        phase: "terminal",
        terminal: "succeeded",
        cancellable: false,
        cancellationRequested: false
      });
      await Promise.all([firstRequest, secondRequest]);
    });
    expect(view.result.current.inFlight).toBe(false);
  });
});
