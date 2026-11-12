/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopProjectSummary, ProjectDoctorReport } from "@planweave-ai/runtime";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsProjectDoctorSection } from "../renderer/settings/SettingsProjectDoctorSection";

const bridgeMock = vi.hoisted(() => ({
  checkProjectDoctor: vi.fn(),
  repairProjectDoctor: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({ bridge: bridgeMock }));

const project: DesktopProjectSummary = {
  projectId: "project-a",
  name: "Project A",
  kind: "external",
  rootPath: "/tmp/project-a",
  sourceRoot: "/tmp/project-a",
  workspaceRoot: "/tmp/.planweave/project-a",
  activeCanvasId: "default",
  taskCanvases: []
};

const projectB: DesktopProjectSummary = {
  ...project,
  projectId: "project-b",
  name: "Project B",
  rootPath: "/tmp/project-b",
  sourceRoot: "/tmp/project-b",
  workspaceRoot: "/tmp/.planweave/project-b"
};

const report: ProjectDoctorReport = {
  ok: false,
  repaired: false,
  errors: [
    {
      code: "result_index_drift",
      message: "Result index is stale.",
      path: "canvases/default/results/T-001/index.json",
      source: "canvas_doctor"
    }
  ],
  warnings: [],
  canvasReports: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function renderSection(
  selectedProject: DesktopProjectSummary | null = project,
  setError = vi.fn()
) {
  return render(
    <SettingsProjectDoctorSection
      selectedProject={selectedProject}
      setError={setError}
      t={createTranslator("en")}
    />
  );
}

function DoctorRoute({ showDoctor }: { showDoctor: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error ? <div role="alert">{error}</div> : null}
      {showDoctor ? (
        <SettingsProjectDoctorSection
          selectedProject={project}
          setError={setError}
          t={createTranslator("en")}
        />
      ) : (
        <button type="button" onClick={() => setError("Current view error")}>
          Show current view error
        </button>
      )}
    </>
  );
}

beforeEach(() => {
  bridgeMock.checkProjectDoctor.mockReset();
  bridgeMock.checkProjectDoctor.mockResolvedValue(report);
  bridgeMock.repairProjectDoctor.mockReset();
  bridgeMock.repairProjectDoctor.mockResolvedValue({ ...report, repaired: true });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true)
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsProjectDoctorSection", () => {
  it("runs Check without invoking Repair", async () => {
    renderSection();

    await userEvent.click(screen.getByTestId("project-doctor-check"));

    expect(bridgeMock.checkProjectDoctor).toHaveBeenCalledWith({ projectId: "project-a" });
    expect(bridgeMock.repairProjectDoctor).not.toHaveBeenCalled();
    expect(await screen.findByText("result_index_drift")).toBeInTheDocument();
  });

  it("does not call the bridge when repair confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    renderSection();
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    await userEvent.click(screen.getByTestId("project-doctor-repair"));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(bridgeMock.repairProjectDoctor).not.toHaveBeenCalled();
  });

  it("confirms exactly once and sends the literal confirmation for repair", async () => {
    renderSection();
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    await userEvent.click(screen.getByTestId("project-doctor-repair"));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(bridgeMock.repairProjectDoctor).toHaveBeenCalledWith(
      { projectId: "project-a" },
      { confirmation: "repair_project_runtime_drift" }
    );
    expect(await screen.findByText("Repair applied")).toBeInTheDocument();
  });

  it("shows no-project state and prevents actions", async () => {
    renderSection(null);

    expect(
      screen.getByText("Select a registered project before running Project Doctor.")
    ).toBeVisible();
    expect(screen.getByTestId("project-doctor-check")).toBeDisabled();
    expect(screen.getByTestId("project-doctor-repair")).toBeDisabled();
  });

  it("shows bridge failures instead of presenting a successful report", async () => {
    bridgeMock.checkProjectDoctor.mockRejectedValueOnce(new Error("Project registry read failed"));
    renderSection();

    await userEvent.click(screen.getByTestId("project-doctor-check"));

    expect(await screen.findByText("Project registry read failed")).toBeVisible();
  });

  it.each([
    "check",
    "repair"
  ] as const)("keeps the current view's error when a pending %s fails after Doctor unmounts", async (operation) => {
    const pending = deferred<ProjectDoctorReport>();
    const { rerender } = render(<DoctorRoute showDoctor />);
    if (operation === "repair") {
      await userEvent.click(screen.getByTestId("project-doctor-check"));
      bridgeMock.repairProjectDoctor.mockReturnValueOnce(pending.promise);
    } else {
      bridgeMock.checkProjectDoctor.mockReturnValueOnce(pending.promise);
    }
    await userEvent.click(screen.getByTestId(`project-doctor-${operation}`));
    const request =
      operation === "repair" ? bridgeMock.repairProjectDoctor : bridgeMock.checkProjectDoctor;
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("project-doctor-check")).toBeDisabled();

    rerender(<DoctorRoute showDoctor={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Show current view error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Current view error");
    await act(async () => {
      pending.reject(new Error("Retired Doctor error"));
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Current view error");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the re-entered project's check busy when a retired repair completes under StrictMode", async () => {
    const pendingRepair = deferred<ProjectDoctorReport>();
    const pendingCheck = deferred<ProjectDoctorReport>();
    const route = (showDoctor: boolean) => (
      <StrictMode>
        <DoctorRoute showDoctor={showDoctor} />
      </StrictMode>
    );
    const { rerender } = render(route(true));
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    bridgeMock.repairProjectDoctor.mockReturnValueOnce(pendingRepair.promise);
    await userEvent.click(screen.getByTestId("project-doctor-repair"));
    expect(bridgeMock.repairProjectDoctor).toHaveBeenCalledTimes(1);

    rerender(route(false));
    rerender(route(true));
    bridgeMock.checkProjectDoctor.mockReturnValueOnce(pendingCheck.promise);
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    expect(bridgeMock.checkProjectDoctor).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("project-doctor-check")).toBeDisabled();

    await act(async () => {
      pendingRepair.resolve({ ...report, repaired: true });
    });
    expect(screen.queryByText("Repair applied")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-doctor-check")).toBeDisabled();
    expect(screen.getByTestId("project-doctor-repair")).toBeDisabled();

    await act(async () => {
      pendingCheck.reject(new Error("Current Doctor error"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Current Doctor error");
    expect(screen.getByTestId("settings-section-project-doctor")).toHaveTextContent(
      "Current Doctor error"
    );
    expect(screen.getByTestId("project-doctor-check")).toBeEnabled();
    expect(bridgeMock.repairProjectDoctor).toHaveBeenCalledTimes(1);
  });

  it("invalidates an earlier project's report and ignores its late check result", async () => {
    const pendingA = deferred<ProjectDoctorReport>();
    const pendingB = deferred<ProjectDoctorReport>();
    bridgeMock.checkProjectDoctor.mockImplementationOnce(() => pendingA.promise);
    bridgeMock.checkProjectDoctor.mockImplementationOnce(() => pendingB.promise);
    const setError = vi.fn();
    const { rerender } = renderSection(project, setError);
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    rerender(
      <SettingsProjectDoctorSection
        selectedProject={projectB}
        setError={setError}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("project-doctor-repair")).toBeDisabled();
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    await act(async () => {
      pendingA.resolve(report);
    });
    expect(screen.getByTestId("project-doctor-check")).toBeDisabled();
    expect(screen.queryByText("result_index_drift")).not.toBeInTheDocument();
    await act(async () => {
      pendingB.resolve({
        ...report,
        errors: [
          {
            code: "project_b_index_drift",
            message: "Project B index is stale.",
            source: "canvas_doctor"
          }
        ]
      });
    });
    expect(await screen.findByText("project_b_index_drift")).toBeInTheDocument();
    expect(screen.getByTestId("project-doctor-repair")).toBeEnabled();
  });

  it("clears a prior report and global error before a failing re-check", async () => {
    const setError = vi.fn();
    const { rerender } = renderSection(project, setError);
    await userEvent.click(screen.getByTestId("project-doctor-check"));
    expect(await screen.findByText("result_index_drift")).toBeInTheDocument();
    const failedCheck = deferred<ProjectDoctorReport>();
    bridgeMock.checkProjectDoctor.mockImplementationOnce(() => failedCheck.promise);
    await userEvent.click(screen.getByTestId("project-doctor-check"));

    expect(screen.queryByText("result_index_drift")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-doctor-repair")).toBeDisabled();
    expect(setError).toHaveBeenLastCalledWith(null);
    failedCheck.reject(new Error("Check failed"));
    expect(await screen.findByText("Check failed")).toBeVisible();
    expect(setError).toHaveBeenLastCalledWith("Check failed");

    rerender(
      <SettingsProjectDoctorSection
        selectedProject={projectB}
        setError={setError}
        t={createTranslator("en")}
      />
    );
    await waitFor(() => expect(setError).toHaveBeenLastCalledWith(null));
  });
});
