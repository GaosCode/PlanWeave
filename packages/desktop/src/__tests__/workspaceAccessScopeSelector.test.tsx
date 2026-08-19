/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAccessScopeSelector } from "../renderer/collaboration/WorkspaceAccessScopeSelector";
import { createTranslator } from "../renderer/i18n";

function installSelectDomStubs() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

const options = [
  {
    key: "project-a\0default",
    projectId: "project-a",
    canvasId: "default",
    projectLabel: "tiny-notes-agent-board",
    canvasLabel: "default"
  },
  {
    key: "project-b\0canvas-2",
    projectId: "project-b",
    canvasId: "canvas-2",
    projectLabel: "PlanWeave",
    canvasLabel: "Task Canvas"
  }
];

describe("WorkspaceAccessScopeSelector", () => {
  beforeEach(() => {
    installSelectDomStubs();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the shared Select control instead of a native dropdown", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WorkspaceAccessScopeSelector
        options={options}
        selectedKey={options[0]?.key ?? null}
        loading={false}
        error={null}
        busy={false}
        t={createTranslator("en")}
        onSelect={onSelect}
      />
    );

    expect(screen.queryByRole("combobox")).toBeVisible();
    expect(document.querySelector("select")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-access-scope-select")).toHaveTextContent(
      "tiny-notes-agent-board / default"
    );

    await user.click(screen.getByTestId("workspace-access-scope-select"));
    await user.click(await screen.findByRole("option", { name: "PlanWeave / Task Canvas" }));
    expect(onSelect).toHaveBeenCalledWith(options[1]?.key);
  });
});
