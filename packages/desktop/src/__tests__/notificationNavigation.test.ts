import { describe, expect, it } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { createTranslator } from "../renderer/i18n";
import { buildNotificationItems } from "../renderer/notifications";
import { graph } from "./helpers/graphFixtures";
import { autoRunState } from "./helpers/autoRunControlHarness";

const baseInput = {
  fileSyncDiagnostics: [],
  graph: null,
  lastFileChange: null,
  graphScope: null,
  navigationContext: null,
  pendingImportRecoveries: [],
  promptConflicts: [],
  settings: defaultDesktopSettings,
  t: createTranslator("en")
};

describe("notification navigation intents", () => {
  it("keeps latest-record authority as a lookup locator", () => {
    const state = autoRunState({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/authority/results/metadata.json"
    });

    const latest = buildNotificationItems({ ...baseInput, autoRunState: state }).find((item) =>
      item.id.startsWith("latest-record:")
    );

    expect(latest?.navigationIntent).toEqual({
      kind: "run-record-lookup",
      locator: {
        projectRoot: "/projects/authority",
        canvasId: "canvas-authority",
        recordId: "T-001#B-001::RUN-001"
      }
    });
  });

  it("does not create a latest-record intent for a root canvas", () => {
    const state = autoRunState({
      canvasId: null,
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/demo/results/metadata.json"
    });

    const latest = buildNotificationItems({ ...baseInput, autoRunState: state }).find((item) =>
      item.id.startsWith("latest-record:")
    );

    expect(latest?.navigationIntent).toBeUndefined();
  });
});

describe("notification read identities", () => {
  const notificationGraph = { ...graph, dirtyPromptRefs: ["T-ALPHA"] };
  const scopes = [
    { projectRoot: "/项目/a:b", canvasId: "c:d" },
    { projectRoot: "/项目/a:b", canvasId: "other" },
    { projectRoot: "/项目/a", canvasId: "b:c:d" },
    { projectRoot: "/项目/A:b", canvasId: "c:d" }
  ];

  it("isolates same refs across canvases and Unicode/delimiter paths, and persists stable read IDs", () => {
    const build = (
      navigationContext: (typeof scopes)[number],
      readNotificationIds: string[] = []
    ) =>
      buildNotificationItems({
        ...baseInput,
        autoRunState: null,
        graph: notificationGraph,
        graphScope: navigationContext,
        navigationContext,
        settings: { ...defaultDesktopSettings, readNotificationIds }
      });
    const ids = scopes.map((scope) => build(scope)[0].id);
    expect(new Set(ids).size).toBe(scopes.length);
    expect(build(scopes[0], [ids[0]])[0].read).toBe(true);
    expect(build(scopes[1], [ids[0]])[0].read).toBe(false);
    expect(build(scopes[0], ["dirty-T-ALPHA"])[0].read).toBe(false);
    expect(build(scopes[0])[0].navigationIntent).toEqual({
      kind: "task-workspace",
      target: { ...scopes[0], taskId: "T-ALPHA" }
    });
  });

  it("separates event types and exception tuple components", () => {
    const items = buildNotificationItems({
      ...baseInput,
      autoRunState: null,
      graphScope: scopes[0],
      navigationContext: scopes[0],
      graph: {
        ...notificationGraph,
        tasks: graph.tasks.map((task, index) => ({
          ...task,
          taskId: index === 0 ? "T-x" : "T",
          exceptions: [
            { ref: index === 0 ? "y" : "x-y", source: "blocked" as const, reason: "blocked" }
          ]
        }))
      },
      fileSyncDiagnostics: ["T-ALPHA"],
      promptConflicts: [
        { ...scopes[0], taskId: "T-ALPHA", title: "Alpha", draft: "local", remote: "remote" }
      ]
    });
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("uses original file event and execution scope instead of active navigation scope", () => {
    const first = buildNotificationItems({
      ...baseInput,
      graphScope: scopes[0],
      navigationContext: scopes[0],
      autoRunState: autoRunState({
        ...scopes[0],
        error: "failed",
        latestRecordPath: "/same/record"
      }),
      lastFileChange: { ...scopes[0], paths: ["prompt.md"], triggeredAt: "2026-10-04" }
    });
    const late = buildNotificationItems({
      ...baseInput,
      graphScope: scopes[1],
      navigationContext: scopes[1],
      autoRunState: autoRunState({
        ...scopes[0],
        error: "failed",
        latestRecordPath: "/same/record"
      }),
      lastFileChange: { ...scopes[0], paths: ["prompt.md"], triggeredAt: "2026-10-05" },
      settings: { ...defaultDesktopSettings, readNotificationIds: first.map((item) => item.id) }
    });
    expect(late.every((item) => item.read)).toBe(true);
    const differentSource = buildNotificationItems({
      ...baseInput,
      graphScope: scopes[0],
      navigationContext: scopes[0],
      autoRunState: autoRunState({
        ...scopes[1],
        error: "failed",
        latestRecordPath: "/same/record"
      }),
      lastFileChange: { ...scopes[1], paths: ["prompt.md"], triggeredAt: "2026-10-04" },
      settings: { ...defaultDesktopSettings, readNotificationIds: first.map((item) => item.id) }
    });
    expect(differentSource.every((item) => !item.read)).toBe(true);
  });
});
