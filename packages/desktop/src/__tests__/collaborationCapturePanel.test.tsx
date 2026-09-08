// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCapturePanel } from "../renderer/collaboration/CollaborationCapturePanel.js";
import { rendererCapture } from "../renderer/collaboration/collaborationCapture.js";
import type { CollaborationCaptureApi, CaptureTrace } from "../shared/collaborationCapture.js";

afterEach(() => {
  cleanup();
  rendererCapture.stop();
  rendererCapture.bind(null);
  vi.useRealTimers();
});

function fixture() {
  let id = "test";
  const api: CollaborationCaptureApi = {
    start: vi.fn(async (input) => {
      id = input.captureId;
    }),
    stop: vi.fn(
      async (): Promise<CaptureTrace> => ({
        captureId: id,
        startedAt: new Date().toISOString(),
        durationMs: 100,
        scopeTag: "a".repeat(64),
        stopReason: "manual",
        samples: []
      })
    ),
    export: vi.fn(async () => true)
  };
  rendererCapture.bind("scope");
  return api;
}

describe("CollaborationCapturePanel", () => {
  it("starts on demand, reports missing samples honestly, and retries failed export", async () => {
    const api = fixture();
    vi.mocked(api.export).mockRejectedValueOnce(new Error("disk full"));
    render(<CollaborationCapturePanel api={api} language="zh" />);
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("开始采集"));
    await screen.findByText("停止采集");
    rendererCapture.record("pointer_input");
    fireEvent.click(screen.getByText("停止采集"));
    await screen.findByText("导出 JSON");
    expect(screen.getAllByText("未采到").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("导出 JSON"));
    await screen.findByRole("alert");
    expect(screen.queryByText("报告已保存")).toBeNull();
    fireEvent.click(screen.getByText("导出 JSON"));
    await screen.findByText("报告已保存");
    expect(api.export).toHaveBeenCalledWith(
      expect.objectContaining({
        renderer: expect.objectContaining({
          samples: expect.arrayContaining([expect.objectContaining({ stage: "pointer_input" })])
        })
      })
    );
  });

  it("retains captured samples when stopping fails and allows retry", async () => {
    const api = fixture();
    vi.mocked(api.stop).mockRejectedValueOnce(new Error("IPC interrupted"));
    render(<CollaborationCapturePanel api={api} language="zh" />);
    fireEvent.click(screen.getByText("开始采集"));
    await screen.findByText("停止采集");
    rendererCapture.record("pointer_input");
    fireEvent.click(screen.getByText("停止采集"));
    await screen.findByRole("alert");
    expect(rendererCapture.running()).toBe(false);
    fireEvent.click(screen.getByText("停止采集"));
    await screen.findByText("导出 JSON");
    fireEvent.click(screen.getByText("导出 JSON"));
    await screen.findByText("报告已保存");
    expect(api.export).toHaveBeenCalledWith(
      expect.objectContaining({
        renderer: expect.objectContaining({
          samples: expect.arrayContaining([expect.objectContaining({ stage: "pointer_input" })])
        })
      })
    );
  });

  it("rejects missing scope without starting transport", async () => {
    const api = fixture();
    rendererCapture.bind(null);
    render(<CollaborationCapturePanel api={api} language="zh" />);
    fireEvent.click(screen.getByText("开始采集"));
    await screen.findByRole("alert");
    expect(api.start).not.toHaveBeenCalled();
  });

  it("stops when the canvas changes and keeps its report exportable", async () => {
    const api = fixture();
    render(<CollaborationCapturePanel api={api} language="zh" />);
    fireEvent.click(screen.getByText("开始采集"));
    await screen.findByText("停止采集");
    act(() => rendererCapture.bind("other-canvas"));
    await waitFor(() => expect(screen.getByText("导出 JSON")).toBeInTheDocument());
    fireEvent.click(screen.getByText("导出 JSON"));
    await screen.findByText("报告已保存");
    expect(api.export).toHaveBeenCalledWith(
      expect.objectContaining({
        renderer: expect.objectContaining({ stopReason: "scope_changed" })
      })
    );
  });

  it("releases a late transport start after unmount", async () => {
    const api = fixture();
    let resolveStart!: () => void;
    vi.mocked(api.start).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    const view = render(<CollaborationCapturePanel api={api} language="zh" />);
    fireEvent.click(screen.getByText("开始采集"));
    view.unmount();
    await act(async () => {
      resolveStart();
    });
    expect(api.stop).toHaveBeenCalledOnce();
    expect(rendererCapture.running()).toBe(false);
  });
});
