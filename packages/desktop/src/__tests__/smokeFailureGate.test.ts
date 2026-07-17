import { describe, expect, it } from "vitest";
import {
  isRendererUncaughtConsoleMessage,
  rendererUncaughtSmokeEvent,
  smokeOutputFailure
} from "../main/smokeFailureGate";

describe("desktop smoke failure gate", () => {
  it("classifies error-level uncaught renderer exceptions as fatal", () => {
    expect(
      isRendererUncaughtConsoleMessage({
        level: "error",
        message: "Uncaught TypeError: Cannot read properties of null"
      })
    ).toBe(true);
    expect(
      isRendererUncaughtConsoleMessage({ level: "warning", message: "Uncaught warning" })
    ).toBe(false);
    expect(
      isRendererUncaughtConsoleMessage({ level: "error", message: "Expected form validation" })
    ).toBe(false);
  });

  it("fails closed on structured renderer and load failures even after READY", () => {
    const output = [
      JSON.stringify({ event: "PLANWEAVE_DESKTOP_SMOKE_READY" }),
      JSON.stringify({
        event: rendererUncaughtSmokeEvent,
        message: "Uncaught TypeError: injected"
      })
    ].join("\n");
    expect(smokeOutputFailure(output)).toContain("injected");
    expect(smokeOutputFailure(JSON.stringify({ event: "PLANWEAVE_DESKTOP_LOAD_FAILED" }))).toBe(
      "PLANWEAVE_DESKTOP_LOAD_FAILED"
    );
    expect(smokeOutputFailure(JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_GONE" }))).toBe(
      "PLANWEAVE_DESKTOP_RENDERER_GONE"
    );
  });

  it("ignores ordinary renderer console output and malformed lines", () => {
    expect(
      smokeOutputFailure(
        [
          "not json",
          JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_CONSOLE", level: "error" }),
          JSON.stringify({ event: "PLANWEAVE_DESKTOP_SMOKE_READY" })
        ].join("\n")
      )
    ).toBeNull();
  });
});
