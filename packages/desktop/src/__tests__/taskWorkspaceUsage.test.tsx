/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspaceUsage } from "../renderer/task-workspace/inspector/TaskWorkspaceUsage";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  taskWorkspaceInspectorFixture,
  taskWorkspaceUsageLabelsFixture as labels
} from "./helpers/taskWorkspaceInspectorFixture";

afterEach(cleanupRendererTestEnvironment);

describe("TaskWorkspaceUsage", () => {
  it("labels reasoning and mode separately even when their values match", () => {
    const fixture = taskWorkspaceInspectorFixture();
    const configuration = fixture.selectedRun.item.run.actualConfiguration;
    if (!configuration.available) throw new Error("Expected an available configuration.");
    configuration.protocol.modes = {
      currentModeId: "high",
      availableModes: [{ id: "high", name: "High", description: null }]
    };
    configuration.fields.mode = {
      available: true,
      value: "high",
      source: { kind: "session_mode", optionId: null },
      reason: null
    };
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );
    expect(screen.getByText(labels.reasoning)).not.toHaveClass("sr-only");
    expect(screen.getByText(labels.mode)).not.toHaveClass("sr-only");
    expect(screen.getAllByText("high")).toHaveLength(2);
  });

  it("shows remote context usage through the same ring and labels cumulative session tokens separately", () => {
    const fixture = taskWorkspaceInspectorFixture();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
        remoteTelemetry={{
          executionAttemptId: "remote-attempt",
          sessionId: "remote-session",
          loadSession: true,
          actualConfiguration: {
            available: false,
            reason: "Remote configuration was not reported."
          },
          currentContext: {
            aggregation: "snapshot",
            sequence: 1,
            observedAt: "2026-09-05T00:00:00.000Z",
            usedTokens: 200,
            contextWindowTokens: 1000,
            cost: null
          },
          cumulativeUsage: {
            semantics: "cumulative_session_total",
            totalTokens: 4000,
            inputTokens: 3000,
            outputTokens: 1000,
            thoughtTokens: null,
            cachedReadTokens: null,
            cachedWriteTokens: null
          }
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: /Context usage: 200 \/ 1,000 tokens/ })
    ).toHaveAccessibleName(/20%/);
    expect(screen.getByText("Session tokens (cumulative): 4,000")).toBeInTheDocument();
    expect(screen.queryByText("gpt-5")).not.toBeInTheDocument();
  });

  it("shows the actual model and reasoning when the agent name is hovered", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: "Agent: codex" });
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Model")).toBeInTheDocument();
    expect(within(tooltip).getByText("gpt-5")).toBeInTheDocument();
    expect(within(tooltip).getByText("Reasoning")).toBeInTheDocument();
    expect(within(tooltip).getByText("high")).toBeInTheDocument();
  });

  it("explains when an older run did not record its actual configuration", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const reason = "No authoritative ACP session configuration snapshot was recorded for this run.";
    const selectedRun = {
      ...fixture.selectedRun,
      item: {
        ...fixture.selectedRun.item,
        run: {
          ...fixture.selectedRun.item.run,
          actualConfiguration: { available: false as const, reason }
        }
      }
    };
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage labels={labels} selectedRun={selectedRun} workspace={fixture.workspace} />
    );

    await user.hover(screen.getByRole("button", { name: "Agent: codex" }));

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getAllByText("Unavailable")).toHaveLength(2);
    expect(within(tooltip).getAllByText(reason)).toHaveLength(2);
  });

  it("shows only the latest context snapshot in a hover tooltip", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: /Context usage: 18,300 \/ 25,800 tokens/ });
    expect(trigger).toHaveAccessibleName(/Latest snapshot only/);
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Context usage")).toBeInTheDocument();
    expect(within(tooltip).getByText("18,300 / 25,800 tokens")).toBeInTheDocument();
    expect(within(tooltip).getByText("71% used")).toBeInTheDocument();
    expect(screen.queryByText("Current run")).not.toBeInTheDocument();
    expect(screen.queryByText("Task total")).not.toBeInTheDocument();
    expect(screen.queryByText("USD 0.42")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows unavailable context on keyboard focus without opening a dialog", async () => {
    const fixture = taskWorkspaceInspectorFixture({ contextSnapshot: false });
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: "Context usage: Unavailable" });
    await user.tab();
    expect(screen.getByRole("button", { name: "Agent: codex" })).toHaveFocus();
    await user.tab();
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders authoritative zero snapshots and durations instead of treating zero as unavailable", async () => {
    const fixture = taskWorkspaceInspectorFixture({ zeroMetrics: true });
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", {
      name: /Context usage: 0 \/ 25,800 tokens; 0% used/
    });
    expect(trigger).toHaveTextContent("0%");
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("0 / 25,800 tokens")).toBeInTheDocument();
    expect(within(tooltip).getByText("0% used")).toBeInTheDocument();
    expect(screen.queryByText("USD 0.00")).not.toBeInTheDocument();
  });
});
