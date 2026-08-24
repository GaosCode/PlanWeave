// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationOperationDiagnosticsPopover } from "../renderer/collaboration/CollaborationOperationDiagnosticsPopover.js";
import type { CollaborationOperationDiagnostics } from "../shared/collaborationOperationDiagnostics.js";

afterEach(cleanup);

function diagnostics(
  activeName: string | null = "startup.restorePersistedWorkspace"
): CollaborationOperationDiagnostics {
  return {
    schemaVersion: "planweave.collaboration.operations/v1",
    capturedAt: "2026-08-24T00:00:05.000Z",
    startup: {
      phase: activeName ? "restoring" : "ready",
      startedAt: "2026-08-24T00:00:00.000Z",
      settledAt: activeName ? null : "2026-08-24T00:00:04.000Z",
      errorCode: null
    },
    coordinationQueue: {
      active: activeName
        ? {
            operationId: "coordination-1",
            name: activeName,
            phase: "running",
            queuedAt: "2026-08-24T00:00:00.000Z",
            startedAt: "2026-08-24T00:00:01.000Z",
            finishedAt: null,
            errorCode: null
          }
        : null,
      queued: [],
      recent: [],
      depth: activeName ? 1 : 0
    }
  };
}

describe("CollaborationOperationDiagnosticsPopover", () => {
  it("does not touch the diagnostics bridge outside developer mode", () => {
    const api = {
      getCollaborationOperationDiagnostics: vi.fn(async () => diagnostics()),
      onCollaborationOperationDiagnosticsChanged: vi.fn(() => () => undefined)
    };

    const { container } = render(
      <CollaborationOperationDiagnosticsPopover enabled={false} api={api} />
    );

    expect(container.childElementCount).toBe(0);
    expect(api.getCollaborationOperationDiagnostics).not.toHaveBeenCalled();
  });

  it("shows the active request immediately and follows push updates", async () => {
    let listener: ((next: CollaborationOperationDiagnostics) => void) | undefined;
    const api = {
      getCollaborationOperationDiagnostics: vi.fn(async () => diagnostics()),
      onCollaborationOperationDiagnosticsChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    };

    render(<CollaborationOperationDiagnosticsPopover enabled api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("collaboration-operation-diagnostics").textContent).toContain(
        "startup.restorePersistedWorkspace"
      )
    );
    act(() => listener?.(diagnostics(null)));
    await waitFor(() =>
      expect(screen.getByTestId("collaboration-operation-diagnostics").textContent).not.toContain(
        "startup.restorePersistedWorkspace"
      )
    );
    expect(screen.getByTestId("collaboration-operation-diagnostics").textContent).toMatch(
      /queue idle|队列空闲/
    );
  });

  it("does not let an older initial read overwrite a newer push update", async () => {
    let resolveInitial: ((value: CollaborationOperationDiagnostics) => void) | undefined;
    let listener: ((next: CollaborationOperationDiagnostics) => void) | undefined;
    const api = {
      getCollaborationOperationDiagnostics: vi.fn(
        () =>
          new Promise<CollaborationOperationDiagnostics>((resolve) => {
            resolveInitial = resolve;
          })
      ),
      onCollaborationOperationDiagnosticsChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    };

    render(<CollaborationOperationDiagnosticsPopover enabled api={api} />);
    act(() => listener?.(diagnostics(null)));
    await waitFor(() =>
      expect(screen.getByTestId("collaboration-operation-diagnostics").textContent).toMatch(
        /queue idle|队列空闲/
      )
    );
    await act(async () => resolveInitial?.(diagnostics()));

    expect(screen.getByTestId("collaboration-operation-diagnostics").textContent).not.toContain(
      "startup.restorePersistedWorkspace"
    );
  });
});
