/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  normalizedRunnerEventSchema,
  runnerRecordReadModelSchema,
  type DesktopBridgeApi
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import {
  TaskWorkspaceComposer,
  TaskWorkspaceConversation
} from "../renderer/task-workspace/conversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  activeIdentity,
  conversationProps,
  readModel,
  record,
  recordId,
  selection,
  timestamp
} from "./helpers/taskWorkspaceConversationFixture";

afterEach(cleanupRendererTestEnvironment);

const t = createTranslator("en");

describe("Task Workspace conversation", () => {
  it("uses a flat Codex-style presentation without role chrome or structured-item indentation", () => {
    const model = readModel({ timeline: [
      { sequence: 1, timestamp, kind: "message", role: "assistant", content: "## Assistant result\n\nFlat assistant Markdown" },
      { sequence: 2, timestamp, kind: "message", role: "user", content: "Keep this focused" },
      { sequence: 3, timestamp, kind: "tool", callId: "workspace-tool", title: "Inspect workspace", toolKind: "read", status: "completed", input: null, output: null },
      { sequence: 4, timestamp, kind: "output", stream: "terminal", content: "workspace output" }
    ] });
    const { container } = render(
      <TaskWorkspaceConversation {...conversationProps(selection({ model }), model)} api={null} t={t} />
    );

    const assistantMessage = screen.getByText("Flat assistant Markdown").closest("article");
    const userMessage = screen.getByText("Keep this focused").closest("article");
    const tool = screen.getByTestId("workspace-tool-event");
    const output = screen.getByText("Terminal output").closest("details");

    expect(assistantMessage).toHaveClass("w-full");
    expect(userMessage).toHaveClass("justify-end");
    expect(tool).not.toHaveClass("ml-10");
    expect(tool).not.toHaveClass("rounded-lg", "border", "bg-background", "shadow-sm");
    expect(screen.getByRole("button", { name: /Inspect workspace/ })).not.toHaveAttribute("aria-expanded");
    expect(output).not.toHaveClass("ml-10");
    expect(container.querySelector(".lucide-bot")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-user")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-conversation-content")).toHaveClass("max-w-3xl");
  });

  it("aligns the composer with the conversation column and masks with the conversation layer", () => {
    const model = readModel();
    render(
      <>
        <TaskWorkspaceConversation
          {...conversationProps(selection({ model }), model)}
          api={null}
          t={t}
        />
        <TaskWorkspaceComposer
          {...conversationProps(selection({ model }), model)}
          api={null}
          t={t}
        />
      </>
    );

    const viewport = screen.getByTestId("task-workspace-conversation-viewport");
    const conversation = screen.getByTestId("task-workspace-conversation-content");
    const composer = screen.getByTestId("task-workspace-composer");
    const composerSurface = screen.getByTestId("task-workspace-composer-surface");

    expect(viewport).toHaveClass("px-5", "[scrollbar-gutter:stable_both-edges]");
    expect(conversation).toHaveClass("mx-auto", "w-full", "max-w-3xl");
    expect(composer).toHaveClass("w-full", "px-5", "before:top-2", "before:bg-app-canvas");
    expect(composer).not.toHaveClass("max-w-3xl", "px-4", "bg-background");
    expect(composerSurface).toHaveClass("mx-auto", "w-full", "max-w-3xl");
  });

  it("reuses the projected ACP timeline for safe wide-screen Markdown", () => {
    const model = readModel();
    render(<TaskWorkspaceConversation {...conversationProps(selection({ model }), model)} api={null} t={t} />);

    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("shared projected timeline")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation and tools · Implement workspace" })).toBeInTheDocument();
    expect(screen.queryByText(/planweave\.runner-event/)).not.toBeInTheDocument();
  });

  it("renders a local artifact as a typed light-blue file link with its full path on hover", async () => {
    const artifact = {
      version: "planweave.runner/v1" as const,
      kind: "implementation" as const,
      relativePath: "report.md",
      sha256: "a".repeat(64),
      sizeBytes: 310,
      mediaType: "text/markdown" as const
    };
    const artifactPath = "/Users/mrbrain/code/PlanWeave/report.md";
    const baseModel = readModel();
    const artifactEvent = normalizedRunnerEventSchema.parse({
      version: "planweave.runner-event/v1",
      sequence: 2,
      timestamp,
      identity: {
        projectId: "project-1",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: "RUN-SESSION-001",
        desktopRunId: "DESKTOP-001",
        executorRunId: "RUN-001"
      },
      runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
      correlation: { sessionId: "ACP-SESSION-001" },
      body: { kind: "artifact", artifact }
    });
    const tsxArtifact = {
      ...artifact,
      relativePath: "TaskWorkspaceHeader.tsx",
      sha256: "b".repeat(64)
    };
    const tsxArtifactEvent = normalizedRunnerEventSchema.parse({
      ...artifactEvent,
      sequence: 3,
      body: { kind: "artifact", artifact: tsxArtifact }
    });
    const model = runnerRecordReadModelSchema.parse({
      ...baseModel,
      events: [artifactEvent, tsxArtifactEvent],
      timeline: [
        { sequence: 1, timestamp, kind: "message", role: "assistant", content: "Before artifact" },
        { sequence: 2, timestamp, kind: "artifact", artifact },
        { sequence: 3, timestamp, kind: "artifact", artifact: tsxArtifact },
        { sequence: 4, timestamp, kind: "message", role: "assistant", content: "After artifact" }
      ]
    });
    const revealRunnerRecordArtifact = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selection({ model }), model, {
          selectedRecord: record(model, { reportPath: artifactPath })
        })}
        api={{ revealRunnerRecordArtifact }}
        t={t}
      />
    );

    const link = screen.getByRole("button", { name: "report.md" });
    expect(link).toHaveClass("text-sky-500", "dark:text-sky-400", "inline-flex");
    expect(link.querySelector('[data-file-type="md"]')).toHaveTextContent("MD");
    const tsxLink = screen.getByRole("button", { name: "TaskWorkspaceHeader.tsx" });
    expect(tsxLink.querySelector('[data-file-type="tsx"]')).toBeInTheDocument();
    expect(screen.queryByText("Artifact")).not.toBeInTheDocument();
    expect(screen.queryByText("310 B")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in file manager" })).not.toBeInTheDocument();
    const before = screen.getByText("Before artifact");
    const after = screen.getByText("After artifact");
    expect(before.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.hover(link);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(artifactPath);

    await user.click(link);
    expect(revealRunnerRecordArtifact).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      recordId,
      artifact
    );
  });

  it("expands lightweight tool payloads without restoring card chrome", () => {
    const model = readModel({ timeline: [
      {
        sequence: 1,
        timestamp,
        kind: "tool",
        callId: "empty-structures",
        title: "Inspect empty structures",
        toolKind: "read",
        status: "completed",
        input: "{}",
        output: "[]"
      },
      {
        sequence: 2,
        timestamp,
        kind: "tool",
        callId: "empty-string",
        title: "Inspect empty string",
        toolKind: "read",
        status: "completed",
        input: "\"\"",
        output: null
      }
    ] });
    render(<TaskWorkspaceConversation {...conversationProps(selection({ model }), model)} api={null} t={t} />);

    const tool = screen.getAllByTestId("workspace-tool-event")[0];
    const trigger = screen.getByRole("button", { name: /Inspect empty structures/ });
    const details = screen.getAllByTestId("workspace-tool-details")[0];
    expect(tool).not.toHaveClass("rounded-lg", "border", "shadow-sm");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(details).toHaveClass("grid-rows-[0fr]", "opacity-0");
    expect(screen.getByText("Inspect empty structures")).toHaveClass("group-hover/tool:text-foreground");
    expect(tool.querySelector(".lucide-chevron-right")).toHaveClass("opacity-0", "group-hover/tool:opacity-100");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(details).toHaveClass("grid-rows-[1fr]", "opacity-100");
    expect(tool.querySelector(".lucide-chevron-right")).toHaveClass("rotate-90");

    expect(screen.getByText("{}")).toBeInTheDocument();
    expect(screen.getByText("[]")).toBeInTheDocument();
    expect(screen.getByText("Empty string")).toBeInTheDocument();
  });

  it("responds to the selected runnerModel permission request with its exact identity", () => {
    const identity = activeIdentity("permission-1");
    const model = readModel({ activeRequests: [{
      kind: "permission",
      requestId: "permission-1",
      interactionId: "interaction-1",
      requestedAt: timestamp,
      summary: "Allow the agent to run tests?",
      identity,
      availability: { available: true, reason: null },
      permissionOptions: [
        { optionId: "approve-once", label: "Approve once", decision: "approve" },
        { optionId: "deny", label: "Deny", decision: "deny" }
      ]
    }] });
    const respondToAgentRequest = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selection({ model }), model)}
        api={{ respondToAgentRequest }}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(respondToAgentRequest).toHaveBeenCalledWith(
      model.interaction.activeRequests[0]!.identity,
      "approve-once"
    );
  });

  it("keeps elicitation and authentication requests in the high-priority interaction region", () => {
    const elicitationIdentity = activeIdentity("elicitation-1");
    const authenticationIdentity = activeIdentity("authentication-1");
    const model = readModel({ activeRequests: [
      {
        kind: "elicitation",
        requestId: "elicitation-1",
        interactionId: "interaction-elicitation",
        requestedAt: timestamp,
        summary: "Choose the release channel.",
        identity: elicitationIdentity,
        availability: { available: true, reason: null },
        elicitationSchema: {
          type: "object",
          required: ["channel"],
          properties: { channel: { type: "string", title: "Release channel" } }
        }
      },
      {
        kind: "authentication",
        requestId: "authentication-1",
        interactionId: "interaction-authentication",
        requestedAt: timestamp,
        summary: "Authenticate in the agent-owned browser.",
        identity: authenticationIdentity,
        availability: { available: false, reason: "Authentication is agent-managed." }
      }
    ] });
    const respondToAgentRequest = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceConversation
        {...conversationProps(selection({ model }), model)}
        api={{ respondToAgentRequest }}
        t={t}
      />
    );

    const interactions = screen.getByTestId("task-workspace-interactions");
    expect(interactions).toHaveTextContent("Choose the release channel.");
    expect(interactions).toHaveTextContent("Authenticate in the agent-owned browser.");
    fireEvent.change(screen.getByLabelText(/Release channel/), { target: { value: "stable" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(respondToAgentRequest).toHaveBeenCalledWith(
      model.interaction.activeRequests[0]!.identity,
      { action: "accept", content: { channel: "stable" } }
    );
  });

  it("restores a historical run scroll position without live auto-follow", () => {
    const scrollTo = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const model = readModel();
      const selectedRun = selection({ active: false, model });
      const onRunScrollTopChange = vi.fn();
      render(
        <TaskWorkspaceConversation
          {...conversationProps(selectedRun, model, {
            getRunScrollTop: () => 135,
            onRunScrollTopChange
          })}
          api={null}
          t={t}
        />
      );
      const viewport = screen.getByTestId("task-workspace-conversation-viewport");
      expect(viewport.scrollTop).toBe(135);
      expect(scrollTo).not.toHaveBeenCalled();
      fireEvent.scroll(viewport, { target: { scrollTop: 210 } });
      expect(onRunScrollTopChange).toHaveBeenCalledWith(recordId, 210);
      expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
      else delete HTMLElement.prototype.scrollTo;
    }
  });

  it("preserves a user's live scroll position across cursor rerenders until Jump to latest restores following", () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperties(HTMLElement.prototype, {
      scrollTo: { configurable: true, value: scrollTo },
      scrollHeight: { configurable: true, get: () => 2_000 },
      clientHeight: { configurable: true, get: () => 400 }
    });
    try {
      const initialModel = readModel();
      const selectedRun = selection({ model: initialModel });
      const positions = new Map<string, number>();
      const getRunScrollTop = vi.fn((id: string) => positions.get(id) ?? 0);
      const onRunScrollTopChange = vi.fn((id: string, top: number) => positions.set(id, top));
      const rendered = render(
        <TaskWorkspaceConversation
          {...conversationProps(selectedRun, initialModel, { getRunScrollTop, onRunScrollTopChange })}
          api={null}
          t={t}
        />
      );
      const viewport = screen.getByRole("region", { name: "Conversation and tools · Implement workspace" });
      expect(viewport.scrollTop).toBe(2_000);

      viewport.scrollTop = 300;
      fireEvent.scroll(viewport);
      expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
      const callsAfterUserScroll = scrollTo.mock.calls.length;

      const updatedModel = readModel({
        afterSequence: 2,
        timeline: [
          ...initialModel.timeline,
          { sequence: 2, timestamp, kind: "message", role: "assistant", content: "New live event" }
        ]
      });
      rendered.rerender(
        <TaskWorkspaceConversation
          {...conversationProps(selectedRun, updatedModel, { getRunScrollTop, onRunScrollTopChange })}
          api={null}
          t={t}
        />
      );
      expect(scrollTo).toHaveBeenCalledTimes(callsAfterUserScroll);
      expect(viewport.scrollTop).toBe(300);

      fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
      expect(viewport.scrollTop).toBe(2_000);
      expect(scrollTo.mock.calls.length).toBeGreaterThan(callsAfterUserScroll);
    } finally {
      if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
      else delete HTMLElement.prototype.scrollTo;
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      else delete HTMLElement.prototype.scrollHeight;
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      else delete HTMLElement.prototype.clientHeight;
    }
  });

  it("sends and stops only with exact selected session identities and renders no retry or resume action", async () => {
    const model = readModel();
    const selectedRun = selection({ model });
    const sendAgentPrompt = vi.fn(async () => undefined);
    const cancelAgentRun = vi.fn(async () => undefined);
    render(
      <TaskWorkspaceComposer
        accessory={<span>Authoritative usage</span>}
        api={{ cancelAgentRun, sendAgentPrompt }}
        liveStatus="live"
        runnerModel={model}
        selectedRun={selectedRun}
        t={t}
      />
    );

    const input = screen.getByLabelText("Message the agent");
    expect(screen.getByTestId("task-workspace-composer")).toHaveClass("pointer-events-auto");
    expect(input.className).toContain("resize-none");
    expect(input.className).not.toContain("resize-y");
    fireEvent.change(input, { target: { value: "Continue with the focused fix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(sendAgentPrompt).toHaveBeenCalledWith(
      model.intervention.prompt.identity,
      "Continue with the focused fix"
    ));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(cancelAgentRun).toHaveBeenCalledWith(model.intervention.cancel.identity);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue session/i })).not.toBeInTheDocument();
    expect(screen.getByText("Authoritative usage")).toBeInTheDocument();
  });

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
    render(<TaskWorkspaceComposer api={{ sendAgentPrompt }} liveStatus="live" runnerModel={liveModel} selectedRun={selectedRun} t={t} />);

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
    render(<TaskWorkspaceComposer api={{ sendAgentPrompt }} liveStatus="live" runnerModel={liveModel} selectedRun={selectedRun} t={t} />);

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
    render(<TaskWorkspaceComposer api={{ cancelAgentRun }} liveStatus="live" runnerModel={liveModel} selectedRun={selectedRun} t={t} />);

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
          identity: { ...selectedModel.intervention.prompt.identity, sessionId: "ACP-SESSION-OTHER" }
        },
        cancel: {
          ...selectedModel.intervention.cancel,
          identity: { ...selectedModel.intervention.cancel.identity, sessionId: "ACP-SESSION-OTHER" }
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
      patch: { liveStatus: "unavailable" as const, liveUnavailableReason: "ACP stream is unavailable." },
      message: "ACP stream is unavailable.",
      alert: false
    },
    {
      name: "subscription error",
      patch: { liveStatus: "error" as const, subscriptionError: "ACP stream failed." },
      message: "ACP stream failed.",
      alert: true
    }
  ])("renders the authoritative ACP $name state without exposing CLI controls", ({ alert, message, patch }) => {
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
      detectTerminalApps: vi.fn(async () => [{
        appId: "terminal" as const,
        label: "Terminal",
        available: true,
        iconDataUrl: null,
        unavailableReason: null
      }]),
      getTerminalPreferences: vi.fn(async () => ({ defaultTerminalAppId: "terminal" as const })),
      openTerminal,
      updateTerminalPreferences: vi.fn(async (patch) => ({ defaultTerminalAppId: patch.defaultTerminalAppId ?? "terminal" }))
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
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledWith({
      ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      recordId,
      appId: "terminal"
    }));
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

    expect(screen.queryByRole("heading", { name: "Hidden persisted report" })).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden persisted report")).not.toBeInTheDocument();
    expect(screen.getByText("No run report")).toBeInTheDocument();
  });
});
