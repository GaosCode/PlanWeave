// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopDevelopmentToolDetection } from "@planweave-ai/runtime";
import { TaskWorkspaceRepositoryActions } from "../renderer/task-workspace/TaskWorkspaceRepositoryActions";

afterEach(cleanup);

const labels = {
  repositoryActions: "Code repository actions"
};

const developmentTools: DesktopDevelopmentToolDetection[] = [
  {
    toolId: "vscode",
    label: "VS Code",
    available: true,
    iconDataUrl: "data:image/png;base64,vscode-icon",
    iconUnavailableReason: null,
    unavailableReason: null
  },
  {
    toolId: "cursor",
    label: "Cursor",
    available: false,
    iconDataUrl: null,
    iconUnavailableReason: null,
    unavailableReason: "Cursor is not installed."
  },
  {
    toolId: "finder",
    label: "Finder",
    available: true,
    iconDataUrl: "data:image/png;base64,finder-icon",
    iconUnavailableReason: null,
    unavailableReason: null
  }
];
const finderTool: DesktopDevelopmentToolDetection = {
  toolId: "finder",
  label: "Finder",
  available: true,
  iconDataUrl: "data:image/png;base64,finder-icon",
  iconUnavailableReason: null,
  unavailableReason: null
};

function repositoryApi(tools = developmentTools) {
  return {
    detectDevelopmentTools: vi.fn(async () => tools),
    openProjectInDevelopmentTool: vi.fn(async () => undefined)
  };
}

describe("TaskWorkspaceRepositoryActions", () => {
  it("opens the linked repository in the first available development tool", async () => {
    const api = repositoryApi();
    const onError = vi.fn();
    render(
      <TaskWorkspaceRepositoryActions
        api={api}
        labels={labels}
        onError={onError}
        repositoryRoot="/workspace/source"
      />
    );

    const primaryAction = await screen.findByTitle("VS Code");
    expect(primaryAction).toHaveProperty("disabled", false);
    expect(primaryAction.querySelector("img")?.getAttribute("src")).toBe(
      developmentTools[0]?.iconDataUrl
    );
    expect(primaryAction.textContent).not.toContain("VS Code");
    fireEvent.click(primaryAction);

    await waitFor(() =>
      expect(api.openProjectInDevelopmentTool).toHaveBeenCalledWith(
        "/workspace/source",
        "vscode"
      )
    );
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("shows only detected tools with native icons in preference order", async () => {
    const api = repositoryApi();
    render(
      <TaskWorkspaceRepositoryActions
        api={api}
        labels={labels}
        onError={vi.fn()}
        repositoryRoot="/workspace/source"
      />
    );

    await screen.findByTitle("VS Code");
    await userEvent.click(screen.getByRole("button", { name: labels.repositoryActions }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["VS Code", "Finder"]);
    expect(items[1]?.querySelector("img")?.getAttribute("src")).toBe(
      finderTool.iconDataUrl
    );

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Finder" }));
    await waitFor(() =>
      expect(api.openProjectInDevelopmentTool).toHaveBeenCalledWith(
        "/workspace/source",
        "finder"
      )
    );
    expect(screen.getByTitle("Finder").querySelector("img")?.getAttribute("src")).toBe(
      finderTool.iconDataUrl
    );
  });

  it("uses Cursor as the primary action when VS Code is not detected", async () => {
    const cursor: DesktopDevelopmentToolDetection = {
      toolId: "cursor",
      label: "Cursor",
      available: true,
      iconDataUrl: "data:image/png;base64,cursor-icon",
      iconUnavailableReason: null,
      unavailableReason: null
    };
    const api = repositoryApi([cursor, finderTool]);
    render(
      <TaskWorkspaceRepositoryActions
        api={api}
        labels={labels}
        onError={vi.fn()}
        repositoryRoot="/workspace/source"
      />
    );

    fireEvent.click(await screen.findByTitle("Cursor"));

    await waitFor(() =>
      expect(api.openProjectInDevelopmentTool).toHaveBeenCalledWith(
        "/workspace/source",
        "cursor"
      )
    );
  });

  it("disables repository actions when no source repository is linked", () => {
    render(
      <TaskWorkspaceRepositoryActions
        api={repositoryApi()}
        labels={labels}
        onError={vi.fn()}
        repositoryRoot={null}
      />
    );

    expect(screen.getByRole("button", { name: labels.repositoryActions })).toHaveProperty(
      "disabled",
      true
    );
  });
});
