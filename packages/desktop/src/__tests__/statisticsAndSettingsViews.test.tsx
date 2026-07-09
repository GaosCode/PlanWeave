/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSwitchRow } from "../renderer/components/SettingsSwitchRow";
import { createTranslator } from "../renderer/i18n";
import { StatisticsView } from "../renderer/views/StatisticsView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer component interactions", () => {
  it("shows a project-opening empty state for statistics when no project is selected", async () => {
    const handleOpenProject = vi.fn().mockResolvedValue(undefined);

    render(
      <StatisticsView
        handleOpenProject={handleOpenProject}
        selectedProject={null}
        statistics={null}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Open a project to view statistics")).toBeInTheDocument();
    expect(screen.getByText(/task completion, block totals/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Project" }));

    expect(handleOpenProject).toHaveBeenCalledTimes(1);
  });

  it("renders settings rows as switch controls", async () => {
    const onCheckedChange = vi.fn();

    render(
      <SettingsSwitchRow
        checked={false}
        title="Component visibility"
        description="Show this component in the palette."
        onCheckedChange={onCheckedChange}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Component visibility" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
