/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import {
  type WorkspaceCanvasCommandBridge,
  useWorkspaceCanvasCommands
} from "../renderer/hooks/useWorkspaceCanvasCommands";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection";

const locator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};
const t = createTranslator("en");

function projection(readOnly = false): WorkspaceCanvasProjection {
  return {
    locator,
    status: "accepted",
    authorityMode: readOnly ? "offline_cache_readonly" : "server_authoritative",
    readOnly,
    cachedAt: readOnly ? "2026-08-22T00:00:00.000Z" : null,
    conflict: null,
    rejectCode: null,
    replica: {
      authorityId: "workspace:workspace-1:project-1:canvas-1",
      bindingKind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      revision: 4,
      contentDigest: "a".repeat(64),
      canEdit: !readOnly,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Workspace plan",
        graphVersion: "1",
        packageFingerprint: `pkg-${"b".repeat(64)}`,
        tasks: [],
        edges: [],
        sharedResourceGroups: [],
        diagnostics: [],
        layout: {
          version: "desktop-layout/v1",
          projectId: "project-1",
          nodes: [],
          updatedAt: "2026-08-22T00:00:00.000Z"
        },
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }
  };
}

function bridge(initial: WorkspaceCanvasProjection) {
  const submitWorkspaceCanvasCommand = vi.fn().mockResolvedValue(initial);
  const api: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn().mockResolvedValue(initial),
    submitWorkspaceCanvasCommand,
    reconnectWorkspaceCanvasSession: vi.fn().mockResolvedValue(initial),
    closeWorkspaceCanvasSession: vi.fn().mockResolvedValue(undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
  };
  return { api, submitWorkspaceCanvasCommand };
}

afterEach(cleanupRendererTestEnvironment);

describe("useWorkspaceCanvasCommands", () => {
  it("does not call a collaboration adapter for a Local Canvas", () => {
    const openWorkspaceCanvasSession = vi.fn();
    const api: WorkspaceCanvasCommandBridge = {
      openWorkspaceCanvasSession,
      submitWorkspaceCanvasCommand: vi.fn(),
      reconnectWorkspaceCanvasSession: vi.fn(),
      closeWorkspaceCanvasSession: vi.fn(),
      onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
    };
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api,
        locator: null,
        sessionConnected: true,
        t
      })
    );

    expect(result.current.enabled).toBe(false);
    expect(result.current.offline).toBe(false);
    expect(openWorkspaceCanvasSession).not.toHaveBeenCalled();
  });

  it("submits Workspace mutations through the Workspace session", async () => {
    const port = bridge(projection());
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api: port.api,
        locator,
        sessionConnected: true,
        t
      })
    );
    await waitFor(() => expect(result.current.projection?.revision).toBe(4));

    await act(async () => {
      await expect(
        result.current.submit({
          intent: {
            kind: "update_layout",
            nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
            updatedAt: "2026-08-22T00:00:00.000Z"
          }
        })
      ).resolves.toMatchObject({ ok: true });
    });
    expect(port.submitWorkspaceCanvasCommand).toHaveBeenCalledTimes(1);
  });

  it("renders an offline cached snapshot read-only and rejects mutations", async () => {
    const port = bridge(projection(true));
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api: port.api,
        locator,
        sessionConnected: false,
        t
      })
    );
    await waitFor(() => expect(result.current.projection?.revision).toBe(4));

    expect(result.current.offline).toBe(true);
    expect(result.current.projection?.canEdit).toBe(false);
    await expect(
      result.current.submit({
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
          updatedAt: "2026-08-22T00:00:00.000Z"
        }
      })
    ).resolves.toMatchObject({ ok: false });
    expect(port.submitWorkspaceCanvasCommand).not.toHaveBeenCalled();
  });
});
