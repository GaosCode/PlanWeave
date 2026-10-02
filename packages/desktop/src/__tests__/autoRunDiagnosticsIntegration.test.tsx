/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("Auto Run diagnostics integration", () => {
  it("shows latest Auto Run summary diagnostics in the desktop diagnostics popover", async () => {
    const diagnostic = {
      code: "auto_run_state_invalid_json",
      message: "Auto Run state could not be parsed.",
      path: "/tmp/demo/.planweave/results/auto-runs/DESKTOP-RUN-0002/state.json"
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      getLatestAutoRunSummaryWithDiagnostics: vi.fn().mockResolvedValue({
        state: null,
        diagnostics: [diagnostic]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [
      { createTranslator },
      { useDesktopProject },
      { useDesktopProjectSession },
      { DesktopDiagnosticsPopover }
    ] = await Promise.all([
      import("../renderer/i18n"),
      import("../renderer/hooks/useDesktopProject"),
      import("../renderer/hooks/useDesktopProjectSession"),
      import("../renderer/run/DesktopDiagnosticsPopover")
    ]);
    const t = createTranslator("en");
    const setError = vi.fn();
    const updateSettings = vi.fn();

    function DiagnosticsHarness() {
      const projectState = useDesktopProject({ planweaveHome: "", setError, t, updateSettings });
      const session = useDesktopProjectSession({
        clearSelectedBlockRecords: vi.fn(),
        language: "en",
        projectState,
        selectBlock: vi.fn().mockResolvedValue(undefined),
        setActiveView: vi.fn(),
        setBlockInspectorOpen: vi.fn(),
        setError,
        setSelectedBlock: vi.fn(),
        setSelectedRunRecord: vi.fn()
      });
      return (
        <DesktopDiagnosticsPopover
          diagnostics={session.autoRunDiagnostics}
          disabled={!session.selectedProject}
          t={t}
        />
      );
    }

    render(<DiagnosticsHarness />);

    await waitFor(() =>
      expect(bridge.getLatestAutoRunSummaryWithDiagnostics).toHaveBeenCalledWith({
        projectRoot: project.rootPath,
        canvasId: "canvas-main"
      })
    );
    const diagnosticsTrigger = await screen.findByRole("button", {
      name: "View desktop diagnostics"
    });
    await userEvent.click(diagnosticsTrigger);

    expect(screen.getByTestId("runtime-diagnostics-section")).toHaveTextContent(
      "Runtime diagnostics (1)"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent(
      "auto_run_state_invalid_json"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent(
      "Auto Run state could not be parsed."
    );
  });
});
