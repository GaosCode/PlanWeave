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

  it("shows total recorded implementation time with its timing coverage", () => {
    render(
      <StatisticsView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        selectedProject={{}}
        statistics={{
          taskTotal: 80,
          implementedTaskCount: 80,
          implementedRatio: 1,
          taskThroughput: 80,
          blockTotal: 156,
          completedBlockCount: 156,
          averageImplementationTimeMs: 508_000,
          totalImplementationTimeMs: 6_608_000,
          timedImplementationRunCount: 13,
          reviewPassedCount: 67,
          reviewPassedRatio: 1,
          feedbackEnvelopeCount: 45,
          reworkCount: 45,
          estimatedRemainingBlocks: 0
        }}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Total Recorded Time")).toBeInTheDocument();
    expect(screen.getByText("1h 50m 08s")).toBeInTheDocument();
    expect(screen.getByText("13 timed runs")).toBeInTheDocument();
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
