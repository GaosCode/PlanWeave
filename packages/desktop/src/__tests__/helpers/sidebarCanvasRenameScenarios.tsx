import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { DesktopBridgeApi, DesktopPackageFileChangeEvent } from "@planweave-ai/runtime";
import { desktopCommandBridge } from "../../renderer/desktopCommandBridge";
import { deferred, layout, projectSnapshot } from "./desktopProjectFixtures";
import { graph } from "./graphFixtures";
import { RenameSidebar, openRename } from "./sidebarRenameHarness";

const currentSnapshot = () =>
  projectSnapshot({
    graph: { ...graph, projectTitle: "Renamed canvas graph" },
    layout: { ...layout, updatedAt: "2026-10-30T08:00:00.000Z" },
    projectPromptMarkdown: "# Renamed canvas prompt"
  });

export function sidebarCanvasRenameScenarios({
  api,
  listeners,
  onError
}: {
  api: () => DesktopBridgeApi;
  listeners: () => Set<(event: DesktopPackageFileChangeEvent) => void>;
  onError: ReturnType<typeof vi.fn>;
}) {
  const begin = async () => {
    const view = render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const oldWatch = vi.mocked(api().watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!oldWatch) throw new Error("Expected initial watch");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api().getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    const input = await openRename("canvas");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed canvas{Enter}");
    await waitFor(() => expect(api().getDesktopProjectSnapshot).toHaveBeenCalledTimes(2));
    return { view, output, gate, oldWatch, input };
  };
  const deliver = (reference: Parameters<DesktopBridgeApi["watchPackageFiles"]>[0]) => {
    const event = {
      ...reference,
      paths: ["package/manifest.json"],
      triggeredAt: "2026-10-30T08:00:00Z"
    };
    act(() => {
      for (const listener of listeners()) listener(event);
    });
    return event;
  };
  const assertCurrent = (output: HTMLElement) => {
    expect(output).toHaveTextContent('"graph":"Renamed canvas graph"');
    expect(output).toHaveTextContent('"layoutUpdatedAt":"2026-10-30T08:00:00.000Z"');
    expect(output).toHaveTextContent('"prompt":"# Renamed canvas prompt"');
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
  };

  it.each([
    { visibility: "collapse", completion: "resolve" },
    { visibility: "collapse", completion: "reject" },
    { visibility: "settings", completion: "resolve" },
    { visibility: "settings", completion: "reject" },
    { visibility: "sidebar-unmount", completion: "resolve" },
    { visibility: "sidebar-unmount", completion: "reject" }
  ] as const)("finishes canvas rename snapshot $completion across $visibility", async ({
    visibility,
    completion
  }) => {
    const { view, output, gate, oldWatch } = await begin();
    view.rerender(
      <RenameSidebar
        onError={onError}
        collapsed={visibility === "collapse"}
        activeView={visibility === "settings" ? "settings" : "graph"}
        sidebarVisible={visibility !== "sidebar-unmount"}
      />
    );
    await act(async () => {
      if (completion === "resolve") gate.resolve(currentSnapshot());
      else gate.reject(new Error("Current canvas snapshot failed"));
    });
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    if (completion === "reject")
      expect(screen.getByRole("alert")).toHaveTextContent("Current canvas snapshot failed");
    view.rerender(<RenameSidebar onError={onError} />);
    if (completion === "reject") {
      vi.mocked(api().getDesktopProjectSnapshot).mockResolvedValueOnce(currentSnapshot());
      await userEvent.click(screen.getByRole("button", { name: /Renamed canvas\s*2/ }));
    }
    await waitFor(() => assertCurrent(output));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api()).onPackageFileChanged(observed);
    deliver(oldWatch);
    expect(observed).not.toHaveBeenCalled();
    const reference = vi.mocked(api().watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!reference) throw new Error("Expected current canvas watch");
    expect(reference.registrationId).not.toBe(oldWatch.registrationId);
    expect(observed).not.toHaveBeenCalled();
    const event = deliver(reference);
    expect(observed).toHaveBeenCalledExactlyOnceWith(event);
    view.unmount();
    deliver(reference);
    expect(observed).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps a current canvas load error editable and recovers by reopening the canvas", async () => {
    const { gate, input, output } = await begin();
    await act(async () => gate.reject(new Error("Current rename data failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Current rename data failed");
    expect(input).toHaveValue("Renamed canvas");
    expect(input).not.toHaveAttribute("readonly");
    expect(output).toHaveTextContent('"loading":false');
    vi.mocked(api().getDesktopProjectSnapshot).mockResolvedValueOnce(currentSnapshot());
    await userEvent.type(input, "{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /Renamed canvas\s*2/ }));
    await waitFor(() => expect(input).not.toBeInTheDocument());
    assertCurrent(output);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a newer catalog error when the admitted canvas snapshot finishes", async () => {
    const { gate, output } = await begin();
    vi.mocked(api().listProjects).mockRejectedValueOnce(new Error("New catalog request failed"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh projects" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("New catalog request failed")
    );
    await act(async () => gate.resolve(currentSnapshot()));
    assertCurrent(output);
    expect(screen.getByRole("alert")).toHaveTextContent("New catalog request failed");
  });

  it.each([
    "new-editor",
    "project-failure",
    "canvas-failure"
  ] as const)("preserves admitted canvas data and draft after %s", async (mode) => {
    const { output, gate, input: oldInput } = await begin();
    await userEvent.type(oldInput, "{Escape}");
    const projectEditor = mode === "project-failure";
    fireEvent.contextMenu(
      screen.getByRole("button", { name: projectEditor ? "Demo project" : /Renamed canvas\s*2/ })
    );
    await userEvent.click(
      await screen.findByText(projectEditor ? "Rename project" : "Rename task canvas")
    );
    const input = screen.getByRole("textbox", {
      name: projectEditor ? "Project name" : "Task canvas name"
    });
    await userEvent.clear(input);
    await userEvent.type(input, "New draft");
    if (mode !== "new-editor") {
      if (projectEditor)
        vi.mocked(api().renameProject).mockRejectedValueOnce(new Error("New write failed"));
      else vi.mocked(api().renameTaskCanvas).mockRejectedValueOnce(new Error("New write failed"));
      await userEvent.type(input, "{Enter}");
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("New write failed"));
    }
    await act(async () => gate.resolve(currentSnapshot()));
    assertCurrent(output);
    expect(input).toHaveValue("New draft");
    expect(input).not.toHaveAttribute("readonly");
    if (mode === "new-editor") expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    else expect(screen.getByRole("alert")).toHaveTextContent("New write failed");
    const reference = vi.mocked(api().watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!reference) throw new Error("Expected current canvas watch");
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api()).onPackageFileChanged(observed);
    const event = deliver(reference);
    expect(observed).toHaveBeenCalledExactlyOnceWith(event);
    unsubscribe();
    if (mode !== "new-editor") {
      await userEvent.type(input, "{Enter}");
      await waitFor(() => expect(input).not.toBeInTheDocument());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  });

  it.each(
    (
      [
        "project",
        "canvas",
        "Home",
        "refresh",
        "project-rename",
        "canvas-rename",
        "unmount"
      ] as const
    ).flatMap((transition) =>
      (["resolve", "reject"] as const).map((completion) => ({ transition, completion }))
    )
  )("isolates old canvas snapshot $completion after $transition", async ({
    transition,
    completion
  }) => {
    const { view, output, gate, oldWatch, input: oldInput } = await begin();
    vi.mocked(api().getDesktopProjectSnapshot).mockResolvedValue(currentSnapshot());
    if (transition === "project")
      view.rerender(<RenameSidebar onError={onError} targetProjectId="P-002" />);
    else if (transition === "canvas")
      view.rerender(<RenameSidebar onError={onError} targetCanvasId="canvas-other" />);
    else if (transition === "Home")
      view.rerender(<RenameSidebar onError={onError} home="/tmp/other-rename-home" />);
    else if (transition === "refresh")
      await userEvent.click(screen.getByRole("button", { name: "Refresh canvas data" }));
    else if (transition === "project-rename" || transition === "canvas-rename") {
      await userEvent.type(oldInput, "{Escape}");
      fireEvent.contextMenu(
        screen.getByRole("button", {
          name: transition === "project-rename" ? "Demo project" : /Renamed canvas\s*2/
        })
      );
      await userEvent.click(
        await screen.findByText(
          transition === "project-rename" ? "Rename project" : "Rename task canvas"
        )
      );
      const input = screen.getByRole("textbox", {
        name: transition === "project-rename" ? "Project name" : "Task canvas name"
      });
      await userEvent.clear(input);
      await userEvent.type(input, "Replacement save{Enter}");
    } else view.unmount();
    if (transition !== "unmount")
      await waitFor(() => expect(output).toHaveTextContent('"graph":"Renamed canvas graph"'));
    const current = output.textContent;
    onError.mockClear();
    await act(async () => {
      if (completion === "resolve")
        gate.resolve(
          projectSnapshot({ graph: { ...graph, projectTitle: "Obsolete canvas graph" } })
        );
      else gate.reject(new Error("Obsolete canvas error"));
    });
    if (transition === "refresh") assertCurrent(output);
    else if (transition !== "unmount") expect(output.textContent).toBe(current);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onError.mock.calls.filter(([error]) => error !== null)).toHaveLength(0);
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api()).onPackageFileChanged(observed);
    deliver(oldWatch);
    expect(observed).not.toHaveBeenCalled();
    unsubscribe();
    view.unmount();
  });
}
