// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspaceRepositoryActions } from "../renderer/task-workspace/TaskWorkspaceRepositoryActions";

afterEach(cleanup);

const labels = {
  openInFileManager: "Open code repository in Finder",
  openInVsCode: "Open in VS Code",
  repositoryActions: "Code repository actions"
};

const vsCodeDetection = {
  available: true,
  label: "Visual Studio Code",
  iconDataUrl: "data:image/png;base64,vscode-icon",
  iconUnavailableReason: null,
  unavailableReason: null
};

describe("TaskWorkspaceRepositoryActions", () => {
  it("opens the linked repository directly in VS Code", async () => {
    const api = {
      detectVsCode: vi.fn(async () => vsCodeDetection),
      openProjectInVsCode: vi.fn(async () => undefined),
      revealProjectInFinder: vi.fn(async () => undefined)
    };
    const onError = vi.fn();
    render(
      <TaskWorkspaceRepositoryActions
        api={api}
        labels={labels}
        onError={onError}
        repositoryRoot="/workspace/source"
      />
    );

    await waitFor(() =>
      expect(screen.getByTitle(labels.openInVsCode)).toHaveProperty("disabled", false)
    );
    const icon = screen.getByTitle(labels.openInVsCode).querySelector("img");
    expect(icon?.getAttribute("src")).toBe(vsCodeDetection.iconDataUrl);
    expect(icon?.className).toContain("size-5");
    expect(screen.getByText("VS Code").className).toContain("leading-none");
    fireEvent.click(screen.getByTitle(labels.openInVsCode));

    await waitFor(() => expect(api.openProjectInVsCode).toHaveBeenCalledWith("/workspace/source"));
    expect(api.revealProjectInFinder).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("offers Finder from the repository actions menu", async () => {
    const api = {
      detectVsCode: vi.fn(async () => vsCodeDetection),
      openProjectInVsCode: vi.fn(async () => undefined),
      revealProjectInFinder: vi.fn(async () => undefined)
    };
    render(
      <TaskWorkspaceRepositoryActions
        api={api}
        labels={labels}
        onError={vi.fn()}
        repositoryRoot="/workspace/source"
      />
    );

    await userEvent.click(screen.getByRole("button", { name: labels.repositoryActions }));
    await userEvent.click(await screen.findByRole("menuitem", { name: labels.openInFileManager }));

    await waitFor(() => expect(api.revealProjectInFinder).toHaveBeenCalledWith("/workspace/source"));
    expect(api.openProjectInVsCode).not.toHaveBeenCalled();
  });

  it("disables repository actions when no source repository is linked", () => {
    render(
      <TaskWorkspaceRepositoryActions
        api={{
          detectVsCode: vi.fn(async () => vsCodeDetection),
          openProjectInVsCode: vi.fn(async () => undefined),
          revealProjectInFinder: vi.fn(async () => undefined)
        }}
        labels={labels}
        onError={vi.fn()}
        repositoryRoot={null}
      />
    );

    expect(screen.getByTitle(labels.openInVsCode)).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: labels.repositoryActions })).toHaveProperty(
      "disabled",
      true
    );
  });
});
