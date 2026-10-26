/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import type { DesktopStatistics } from "@planweave-ai/runtime";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSwitchRow } from "../renderer/components/SettingsSwitchRow";
import { createTranslator } from "../renderer/i18n";
import { StatisticsView } from "../renderer/views/StatisticsView";
import { TodoView } from "../renderer/views/TodoView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer component interactions", () => {
  describe.each(["en", "zh-CN"] as const)("statistics Task completion in %s", (language) => {
    it.each([
      {
        name: "uneven Task sizes: one completed Task with one Block and one incomplete Task with nine Blocks",
        taskTotal: 2,
        implementedTaskCount: 1,
        implementedRatio: 0.5,
        blockTotal: 10,
        completedBlockCount: 1,
        percentage: "50%",
        fraction: "1/2",
        remainingBlocks: 9
      },
      {
        name: "zero Tasks",
        taskTotal: 0,
        implementedTaskCount: 0,
        implementedRatio: 0,
        blockTotal: 0,
        completedBlockCount: 0,
        percentage: "0%",
        fraction: "0/0",
        remainingBlocks: 0
      },
      {
        name: "all Tasks completed",
        taskTotal: 2,
        implementedTaskCount: 2,
        implementedRatio: 1,
        blockTotal: 10,
        completedBlockCount: 10,
        percentage: "100%",
        fraction: "2/2",
        remainingBlocks: 0
      }
    ])("keeps percentage, fraction, unit and accessible value aligned for $name", (testCase) => {
      const statistics: DesktopStatistics = {
        taskTotal: testCase.taskTotal,
        implementedTaskCount: testCase.implementedTaskCount,
        implementedRatio: testCase.implementedRatio,
        taskThroughput: testCase.implementedTaskCount,
        blockTotal: testCase.blockTotal,
        completedBlockCount: testCase.completedBlockCount,
        averageImplementationTimeMs: null,
        totalImplementationTimeMs: null,
        timedImplementationRunCount: 0,
        reviewPassedCount: 0,
        reviewPassedRatio: 0,
        feedbackEnvelopeCount: 0,
        reworkCount: 0,
        estimatedRemainingBlocks: testCase.remainingBlocks
      };

      render(
        <StatisticsView
          handleOpenProject={vi.fn().mockResolvedValue(undefined)}
          selectedProject={{}}
          statistics={statistics}
          t={createTranslator(language)}
        />
      );

      const summary = within(screen.getByText("Implemented Ratio").parentElement!.parentElement!);
      expect(summary.getByText(testCase.percentage)).toBeInTheDocument();
      expect(summary.getByText(testCase.fraction)).toBeInTheDocument();
      expect(summary.getByText("Tasks")).toBeInTheDocument();
      expect(summary.queryByText(language === "en" ? "Blocks" : "任务块")).not.toBeInTheDocument();
      const progress = summary.getByRole("progressbar", { name: "Tasks" });
      expect(progress).toHaveAttribute("aria-valuenow", String(testCase.implementedRatio * 100));
      expect(progress).toHaveAttribute("aria-valuemin", "0");
      expect(progress).toHaveAttribute("aria-valuemax", "100");
      expect(progress).toHaveAttribute(
        "aria-valuetext",
        `${testCase.percentage} (${testCase.fraction} Tasks)`
      );
      expect(screen.getByText("Remaining").parentElement).toHaveTextContent(
        `Remaining${testCase.remainingBlocks}`
      );
    });
  });

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
    expect(screen.queryByText("Statistics")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Statistics" })).toBeInTheDocument();
  });

  it("does not repeat the selected Todo navigation label in the content", () => {
    render(
      <TodoView
        executionPlan={null}
        handleBlockSelect={vi.fn().mockResolvedValue(undefined)}
        t={createTranslator("en")}
        todoGroups={null}
      />
    );

    expect(screen.queryByText("Todo")).not.toBeInTheDocument();
    expect(screen.getByText("Ready queue")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Todo" })).toBeInTheDocument();
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
