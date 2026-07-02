/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { DesktopDiagnosticsPopover } from "../renderer/run/DesktopDiagnosticsPopover";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("DesktopDiagnosticsPopover", () => {
  it("opens with performance diagnostics expanded when diagnostics exist", async () => {
    render(
      <DesktopDiagnosticsPopover
        diagnostics={[{ code: "desktop_projection_slow_part", message: "Desktop projection project aggregation took 12 ms.", path: "project" }]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("desktop-diagnostics-popover")).toBeVisible();
    expect(screen.getByTestId("performance-diagnostics-section")).toHaveTextContent("Performance diagnostics");
    expect(screen.getByTestId("desktop-performance-diagnostic")).toHaveTextContent("desktop_projection_slow_part");
    expect(screen.getByTestId("desktop-performance-diagnostic")).toHaveTextContent("Desktop projection project aggregation took 12 ms.");
  });

  it("disables the trigger while project actions are unavailable", () => {
    render(<DesktopDiagnosticsPopover diagnostics={[]} disabled={true} t={t} />);

    expect(screen.getByRole("button", { name: "View desktop diagnostics" })).toBeDisabled();
  });
});
