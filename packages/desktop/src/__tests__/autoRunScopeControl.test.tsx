/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { AutoRunScopeControl } from "../renderer/run/AutoRunScopeControl";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("AutoRunScopeControl", () => {
  it("disables scope selection without an active project", () => {
    render(
      <AutoRunScopeControl
        autoRunScopeMode="project"
        hasProject={false}
        selectedBlockPresent={false}
        selectedTaskPanelId={null}
        setAutoRunScopeMode={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("keeps unavailable selected-task and selected-block scopes disabled", async () => {
    stubSelectLayoutApis();
    render(
      <AutoRunScopeControl
        autoRunScopeMode="project"
        hasProject={true}
        selectedBlockPresent={false}
        selectedTaskPanelId={null}
        setAutoRunScopeMode={vi.fn()}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Selected Task" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("option", { name: "Selected Block" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});
