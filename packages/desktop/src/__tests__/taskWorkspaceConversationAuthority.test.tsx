/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { runnerRecordReadModelSchema, type DesktopBridgeApi } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import {
  TaskWorkspaceComposer,
  TaskWorkspaceConversation
} from "../renderer/task-workspace/conversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  conversationProps,
  readModel,
  record,
  recordId,
  selection
} from "./helpers/taskWorkspaceConversationFixture";

afterEach(cleanupRendererTestEnvironment);

const t = createTranslator("en");

describe("Task Workspace conversation authority", () => {
  it("does not expose an ACP composer for an authoritative CLI selection with a stale ACP model", () => {
    const staleModel = readModel();
    const selectedRun = selection({ model: null, runnerKind: "cli" });
    render(
      <TaskWorkspaceComposer
        api={{ sendAgentPrompt: vi.fn(async () => undefined) }}
        liveStatus="live"
        runnerModel={staleModel}
        selectedRun={selectedRun}
        t={t}
      />
    );

    expect(screen.queryByLabelText("Message the agent")).not.toBeInTheDocument();
    expect(screen.getByText(/CLI runs do not provide an ACP composer/)).toBeInTheDocument();
  });

  it("blocks prompt actions when only the project root differs from the selected capability", () => {
    const selectedModel = readModel();
    const selectedRun = selection({ model: selectedModel });
    const liveModel = runnerRecordReadModelSchema.parse({
      ...selectedModel,
      intervention: {
        ...selectedModel.intervention,
        prompt: {
          ...selectedModel.intervention.prompt,
          identity: {
            ...selectedModel.intervention.prompt.identity,
            ref: { projectRoot: "/projects/other", canvasId: "canvas-main" }
          }
        }
      }
    });
    const sendAgentPrompt = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        api={{ sendAgentPrompt }}
        liveStatus="live"
        runnerModel={liveModel}
        selectedRun={selectedRun}
        t={t}
      />
    );

    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendAgentPrompt).not.toHaveBeenCalled();
  });

  it("blocks prompt actions when only the canvas differs from the selected capability", () => {
    const selectedModel = readModel();
    const selectedRun = selection({ model: selectedModel });
    const liveModel = runnerRecordReadModelSchema.parse({
      ...selectedModel,
      intervention: {
        ...selectedModel.intervention,
        prompt: {
          ...selectedModel.intervention.prompt,
          identity: {
            ...selectedModel.intervention.prompt.identity,
            ref: { projectRoot: "/projects/demo", canvasId: "canvas-other" }
          }
        }
      }
    });
    const sendAgentPrompt = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        api={{ sendAgentPrompt }}
        liveStatus="live"
        runnerModel={liveModel}
        selectedRun={selectedRun}
        t={t}
      />
    );

    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(sendAgentPrompt).not.toHaveBeenCalled();
  });

  it("blocks cancel actions when only the action scope differs from the selected capability", () => {
    const selectedModel = readModel();
    const selectedRun = selection({ model: selectedModel });
    const liveModel = runnerRecordReadModelSchema.parse({
      ...selectedModel,
      intervention: {
        ...selectedModel.intervention,
        cancel: {
          ...selectedModel.intervention.cancel,
          identity: { ...selectedModel.intervention.cancel.identity, scope: "/projects/other" }
        }
      }
    });
    const cancelAgentRun = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        api={{ cancelAgentRun }}
        liveStatus="live"
        runnerModel={liveModel}
        selectedRun={selectedRun}
        t={t}
      />
    );

    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it("blocks prompt and cancel actions when only their ACP session differs from the selected capabilities", () => {
    const selectedModel = readModel();
    const selectedRun = selection({ model: selectedModel });
    const liveModel = runnerRecordReadModelSchema.parse({
      ...selectedModel,
      intervention: {
        prompt: {
          ...selectedModel.intervention.prompt,
          identity: {
            ...selectedModel.intervention.prompt.identity,
            sessionId: "ACP-SESSION-OTHER"
          }
        },
        cancel: {
          ...selectedModel.intervention.cancel,
          identity: {
            ...selectedModel.intervention.cancel.identity,
            sessionId: "ACP-SESSION-OTHER"
          }
        }
      }
    });
    const sendAgentPrompt = vi.fn(async () => undefined);
    const cancelAgentRun = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        api={{ cancelAgentRun, sendAgentPrompt }}
        liveStatus="live"
        runnerModel={liveModel}
        selectedRun={selectedRun}
        t={t}
      />
    );

    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(sendAgentPrompt).not.toHaveBeenCalled();
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "loading",
      patch: { liveStatus: "loading" as const },
      message: "Loading the selected ACP conversation…",
      alert: false
    },
    {
      name: "unavailable",
      patch: {
        liveStatus: "unavailable" as const,
        liveUnavailableReason: "ACP stream is unavailable."
      },
      message: "ACP stream is unavailable.",
      alert: false
    },
    {
      name: "subscription error",
      patch: { liveStatus: "error" as const, subscriptionError: "ACP stream failed." },
      message: "ACP stream failed.",
      alert: true
    }
  ])("renders the authoritative ACP $name state without exposing CLI controls", ({
    alert,
    message,
    patch
  }) => {
    const selectedRun = selection({ model: null, runnerKind: "acp" });
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selectedRun, null, patch)}
        api={null}
        t={t}
      />
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    if (alert) expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByTestId("task-workspace-cli-run")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open terminal" })).not.toBeInTheDocument();
  });

  it("shows real CLI projections and opens the selected record in a real terminal", async () => {
    const selectedRun = selection({ active: false, model: null, runnerKind: "cli" });
    const openTerminal = vi.fn(async () => ({ appId: "terminal" as const, cwd: "/projects/demo" }));
    const api = {
      detectTerminalApps: vi.fn(async () => [
        {
          appId: "terminal" as const,
          label: "Terminal",
          available: true,
          iconDataUrl: null,
          unavailableReason: null
        }
      ]),
      getTerminalPreferences: vi.fn(async () => ({ defaultTerminalAppId: "terminal" as const })),
      openTerminal,
      updateTerminalPreferences: vi.fn(async (patch) => ({
        defaultTerminalAppId: patch.defaultTerminalAppId ?? "terminal"
      }))
    } satisfies Partial<DesktopBridgeApi>;
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selectedRun, null)}
        api={api}
        canvasRef={{ projectRoot: "/projects/demo", canvasId: "canvas-main" }}
        t={t}
      />
    );

    expect(screen.getByRole("heading", { name: "CLI result" })).toBeInTheDocument();
    expect(screen.getByText("real stdout summary")).toBeInTheDocument();
    expect(screen.getByText("real stderr summary")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message the agent")).not.toBeInTheDocument();
    await act(async () => undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal" }));
    await vi.waitFor(() =>
      expect(openTerminal).toHaveBeenCalledWith({
        ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        recordId,
        appId: "terminal"
      })
    );
  });

  it("does not fall back to reportMarkdown when the CLI display projection is empty", () => {
    const selectedRun = selection({ active: false, model: null, runnerKind: "cli" });
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selectedRun, null, {
          selectedRecord: record(null, {
            displayMarkdown: "",
            reportMarkdown: "## Hidden persisted report",
            stdoutSummary: "",
            stderrSummary: ""
          })
        })}
        api={null}
        t={t}
      />
    );

    expect(
      screen.queryByRole("heading", { name: "Hidden persisted report" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden persisted report")).not.toBeInTheDocument();
    expect(screen.getByText("No run report")).toBeInTheDocument();
  });
});
