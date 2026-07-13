/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import type { DesktopRunRecord } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appViewHistoryChangedEvent } from "../renderer/hooks/useAppViewHistory";
import { useRecordWorkspaceNavigation } from "../renderer/task-workspace/useRecordWorkspaceNavigation";
import type { AppHistoryRoute } from "../renderer/hooks/useAppViewHistory";
import { deferred } from "./helpers/desktopProjectFixtures";

const locator = {
  projectRoot: "/projects/authority",
  canvasId: "canvas-authority",
  recordId: "T-001#B-001::RUN-001",
  expectedBlockRef: "T-001#B-001"
};

const searchRoute: AppHistoryRoute = { view: "search" };

function runRecord(): DesktopRunRecord {
  return {
    recordId: locator.recordId,
    ref: locator.expectedBlockRef,
    taskId: "T-001",
    blockId: "B-001",
    runId: "RUN-001",
    executor: "codex",
    adapter: "codex",
    executionCwd: "/projects/authority",
    projectRoot: locator.projectRoot,
    agentSessionId: null,
    codexSessionId: null,
    tmuxSessionId: null,
    tmuxAttachCommand: null,
    tmuxReadOnlyAttachCommand: null,
    exitCode: 0,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:01:00.000Z",
    promptPath: "/projects/authority/prompt.md",
    reportPath: "/projects/authority/report.md",
    metadataPath: "/projects/authority/metadata.json",
    stdoutSummary: "",
    stderrSummary: "",
    promptMarkdown: "# Prompt",
    reportMarkdown: "# Report",
    displayMarkdown: "# Report",
    displayMarkdownSource: "report",
    metadata: {},
    runnerReadModel: null
  };
}

function contexts(search: string) {
  return { autoRun: "auto-run", notifications: "notifications", search };
}

afterEach(cleanup);

describe("record workspace navigation lifecycle", () => {
  it("drops a deferred resolution after leaving and returning to the same source route", async () => {
    const lookup = deferred<DesktopRunRecord>();
    const openTarget = vi.fn();
    const { result, rerender } = renderHook(
      (props: { route: AppHistoryRoute }) =>
        useRecordWorkspaceNavigation({
          getRunRecord: vi.fn(() => lookup.promise),
          openTarget,
          route: props.route,
          sourceContextKeys: contexts("query-a")
        }),
      { initialProps: { route: searchRoute } }
    );
    const pending = result.current("search", locator);

    act(() => globalThis.dispatchEvent(new Event(appViewHistoryChangedEvent)));
    rerender({ route: { view: "graph" } });
    act(() => globalThis.dispatchEvent(new Event(appViewHistoryChangedEvent)));
    rerender({ route: { view: "search" } });
    await act(async () => {
      lookup.resolve(runRecord());
      await pending;
    });

    expect(openTarget).not.toHaveBeenCalled();
  });

  it("drops a deferred rejection after the same source view changes context", async () => {
    const lookup = deferred<DesktopRunRecord>();
    const openTarget = vi.fn();
    const { result, rerender } = renderHook(
      (props: { searchContext: string }) =>
        useRecordWorkspaceNavigation({
          getRunRecord: vi.fn(() => lookup.promise),
          openTarget,
          route: searchRoute,
          sourceContextKeys: contexts(props.searchContext)
        }),
      { initialProps: { searchContext: "query-a" } }
    );
    const pending = result.current("search", locator);

    rerender({ searchContext: "query-b" });
    lookup.reject(new Error("stale lookup failed"));

    await expect(pending).resolves.toBeUndefined();
    expect(openTarget).not.toHaveBeenCalled();
  });
});

describe("current record workspace navigation", () => {
  it("publishes a current lookup exactly once", async () => {
    const lookup = deferred<DesktopRunRecord>();
    const openTarget = vi.fn();
    const { result } = renderHook(() =>
      useRecordWorkspaceNavigation({
        getRunRecord: vi.fn(() => lookup.promise),
        openTarget,
        route: searchRoute,
        sourceContextKeys: contexts("query-a")
      })
    );
    const pending = result.current("search", locator);

    await act(async () => {
      lookup.resolve(runRecord());
      await pending;
    });

    expect(openTarget).toHaveBeenCalledOnce();
    expect(openTarget).toHaveBeenCalledWith("search", {
      projectRoot: locator.projectRoot,
      canvasId: locator.canvasId,
      taskId: "T-001",
      blockRef: locator.expectedBlockRef,
      recordId: locator.recordId
    });
  });

  it("keeps a lookup current while the same search authority hydrates body results", async () => {
    const lookup = deferred<DesktopRunRecord>();
    const openTarget = vi.fn();
    const { result, rerender } = renderHook(
      (_props: { hydrationPhase: "body_loading" | "complete" }) =>
        useRecordWorkspaceNavigation({
          getRunRecord: vi.fn(() => lookup.promise),
          openTarget,
          route: searchRoute,
          sourceContextKeys: contexts("project-a/query-a/all/all-kinds")
        }),
      { initialProps: { hydrationPhase: "body_loading" as const } }
    );
    const pending = result.current("search", locator);

    rerender({ hydrationPhase: "complete" });
    await act(async () => {
      lookup.resolve(runRecord());
      await pending;
    });

    expect(openTarget).toHaveBeenCalledOnce();
  });
});
