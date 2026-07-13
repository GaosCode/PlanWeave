/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAutoRunControlTestEnvironment,
  createTranslator,
  loadAutoRunControl,
  renderAutoRunControlHook
} from "./helpers/autoRunControlHarness";

afterEach(() => {
  cleanupAutoRunControlTestEnvironment();
});

describe("auto run control hook floating position", () => {
  it("uses an initial floating control position when provided", async () => {
    const { result } = await renderAutoRunControlHook({
      initialPosition: { left: 44, top: 55 }
    });

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 44px, calc(100% - 12px))",
      top: "clamp(12px, 55px, calc(100% - 12px))"
    });
  });

  it("updates floating control position from controlled settings changes", async () => {
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result, rerender } = renderHook(
      ({ position }) =>
        useAutoRunControl({
          autoRunState: null,
          openRunWorkspace: vi.fn(),
          position,
          selectedCanvasId: "canvas-main",
          selectedBlock: null,
          selectedProject: null,
          selectedTaskPanelId: null,
          setAutoRunState: vi.fn(),
          setError: vi.fn(),
          t: createTranslator("zh-CN"),
          tmuxMonitoringEnabled: false
        }),
      {
        initialProps: {
          position: null as { left: number; top: number } | null
        }
      }
    );

    expect(result.current.autoRunControlStyle).toMatchObject({ right: 20, bottom: 20 });

    rerender({ position: { left: 72, top: 88 } });

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 72px, calc(100% - 12px))",
      top: "clamp(12px, 88px, calc(100% - 12px))"
    });
  });

  it("keeps a persisted floating control position reachable when the graph surface shrinks", async () => {
    let surfaceWidth = 1000;
    let surfaceHeight = 700;
    const surface = document.createElement("div");
    const control = document.createElement("div");
    surface.setAttribute("data-graph-surface", "");
    surface.append(control);
    document.body.append(surface);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: surfaceWidth,
        height: surfaceHeight,
        right: surfaceWidth,
        bottom: surfaceHeight,
        x: 0,
        y: 0,
        toJSON: vi.fn()
      })
    });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 860,
        top: 600,
        width: 140,
        height: 64,
        right: 1000,
        bottom: 664,
        x: 860,
        y: 600,
        toJSON: vi.fn()
      })
    });

    const { result } = await renderAutoRunControlHook({
      initialPosition: { left: 860, top: 600 }
    });

    await act(async () => {
      result.current.autoRunControlRef(control);
    });

    await waitFor(() => {
      expect(result.current.autoRunControlStyle).toMatchObject({ left: "848px", top: "600px" });
    });

    surfaceWidth = 420;
    surfaceHeight = 240;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.autoRunControlStyle).toMatchObject({ left: "268px", top: "164px" });
    });
  });

  it("clamps floating control drag position and commits it when dragging stops", async () => {
    const onPositionCommit = vi.fn();

    const surface = document.createElement("div");
    const control = document.createElement("div");
    const button = document.createElement("button");
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 500,
        height: 300,
        right: 500,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: vi.fn()
      })
    });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 900,
        top: 900,
        width: 100,
        height: 50,
        right: 1000,
        bottom: 950,
        x: 900,
        y: 900,
        toJSON: vi.fn()
      })
    });
    Object.defineProperty(button, "closest", {
      configurable: true,
      value: (selector: string) => {
        if (selector === "[data-auto-run-control]") {
          return control;
        }
        if (selector === "[data-graph-surface]") {
          return surface;
        }
        return null;
      }
    });
    Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(button, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true)
    });
    Object.defineProperty(button, "releasePointerCapture", { configurable: true, value: vi.fn() });

    const { result } = await renderAutoRunControlHook({
      initialPosition: { left: 900, top: 900 },
      onPositionCommit
    });

    const startEvent = {
      clientX: 910,
      clientY: 910,
      currentTarget: button,
      pointerId: 7
    } as React.PointerEvent<HTMLButtonElement>;
    const moveEvent = {
      clientX: 800,
      clientY: 600,
      currentTarget: button,
      pointerId: 7
    } as React.PointerEvent<HTMLButtonElement>;

    await act(async () => {
      result.current.startAutoRunControlDrag(startEvent);
    });
    await act(async () => {
      result.current.moveAutoRunControl(moveEvent);
    });

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 388px, calc(100% - 12px))",
      top: "clamp(12px, 238px, calc(100% - 12px))"
    });
    expect(onPositionCommit).not.toHaveBeenCalled();

    await act(async () => {
      result.current.stopAutoRunControlDrag(moveEvent);
    });

    expect(onPositionCommit).toHaveBeenCalledWith({ left: 388, top: 238 });
    expect(button.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
