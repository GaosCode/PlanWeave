/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizedRunnerEventSchema,
  desktopAgentPromptIdentitySchema,
  projectAcpConversation,
  projectAcpTimeline,
  runnerRecordReadModelSchema,
  type DesktopBridgeApi,
  type DesktopRunRecord,
  type NormalizedRunnerEvent,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { AcpSessionController } from "../../../runtime/src/autoRun/acpSessionController";
import { acpEventReadModels } from "../../../runtime/src/autoRun/acpEventReadModel";
import { readRunnerRecordReadModel } from "../../../runtime/src/autoRun/runnerRecordReadModel";
import { RunnerRecordMonitor } from "../renderer/inspector/RunnerRecordMonitor";
import { AcpConversationTimeline } from "../renderer/inspector/AcpConversationTimeline";
import { BlockRunRecordCard } from "../renderer/inspector/BlockRunRecordCard";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const acpFixture = join(process.cwd(), "packages/runtime/src/__tests__/support/acpMockAgent.mjs");

function event(sequence: number, kind: "message" | "tool_call" | "terminal", content: string) {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: {
      projectId: "project-1",
      canvasId: "canvas-a",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: "SESSION-001",
      desktopRunId: "DESKTOP-001",
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body:
      kind === "message"
        ? {
            kind,
            role: "assistant",
            messageId: `message-${sequence}`,
            chunk: true,
            content,
            redaction: { classes: [], replaced: 0 }
          }
        : kind === "tool_call"
          ? {
              kind,
              callId: `tool-${sequence}`,
              title: content,
              status: "in_progress",
              content: null
            }
          : {
              kind,
              outcome: {
                version: "planweave.runner/v1",
                state: "succeeded",
                exitCode: 0,
                finishedAt: "2026-07-11T00:00:01.000Z",
                diagnostic: null,
                artifactValidated: true
              }
            }
  });
}

function detailEvent(sequence: number, body: NormalizedRunnerEvent["body"]) {
  const base = event(sequence, "message", `message ${sequence}`);
  return normalizedRunnerEventSchema.parse({ ...base, body });
}

const noInteraction = {
  persisted: false,
  active: false,
  stale: false,
  activeRequests: []
} satisfies RunnerRecordReadModel["interaction"];
const noIntervention = {
  prompt: {
    available: false,
    reason: "No ACP session is available.",
    identity: null,
    inFlight: false
  },
  cancel: {
    available: false,
    reason: "No live owned ACP session is available.",
    identity: null
  }
} satisfies RunnerRecordReadModel["intervention"];

function actionIdentity(requestId: string) {
  return {
    scope: "/tmp/project",
    executorRunId: "RUN-001",
    desktopRunId: "DESKTOP-001",
    runSessionId: "SESSION-001",
    claimRef: "T-001#B-001",
    sessionId: "session-1",
    requestId
  } as RunnerRecordReadModel["interaction"]["activeRequests"][number]["identity"];
}

function model(
  events: NormalizedRunnerEvent[],
  interaction: RunnerRecordReadModel["interaction"] = noInteraction,
  diagnostics: RunnerRecordReadModel["diagnostics"] = [],
  intervention: RunnerRecordReadModel["intervention"] = noIntervention
): RunnerRecordReadModel {
  const last = events.at(-1);
  return {
    events,
    conversation: projectAcpConversation(events),
    timeline: projectAcpTimeline(events),
    diagnostics,
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: last?.sequence ?? 0,
      canonicalIdentity: last ? { identity: last.identity, runner: last.runner } : null,
      terminal: last?.body.kind === "terminal"
    },
    terminal: last?.body.kind === "terminal",
    intervention,
    interaction
  };
}

function api(options: {
  snapshot?: RunnerRecordReadModel | null;
  onSubscribe?: (callback: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1]) => void;
  unsubscribe?: () => Promise<void>;
  revealRunnerRecordArtifact?: DesktopBridgeApi["revealRunnerRecordArtifact"];
  respondToAgentRequest?: DesktopBridgeApi["respondToAgentRequest"];
  cancelAgentRun?: DesktopBridgeApi["cancelAgentRun"];
  sendAgentPrompt?: DesktopBridgeApi["sendAgentPrompt"];
}): Pick<DesktopBridgeApi, "subscribeRunnerRecord" | "revealRunnerRecordArtifact"> &
  Partial<Pick<DesktopBridgeApi, "respondToAgentRequest" | "cancelAgentRun" | "sendAgentPrompt">> {
  return {
    subscribeRunnerRecord: vi.fn(async (_input, callback) => {
      options.onSubscribe?.(callback);
      return {
        subscriptionId: "test-subscription",
        updateSequence: 0,
        snapshot: options.snapshot ?? null,
        unsubscribe: options.unsubscribe ?? vi.fn(async () => undefined)
      };
    }),
    revealRunnerRecordArtifact: options.revealRunnerRecordArtifact ?? vi.fn(async () => undefined),
    ...(options.respondToAgentRequest
      ? { respondToAgentRequest: options.respondToAgentRequest }
      : {}),
    ...(options.cancelAgentRun ? { cancelAgentRun: options.cancelAgentRun } : {}),
    ...(options.sendAgentPrompt ? { sendAgentPrompt: options.sendAgentPrompt } : {})
  };
}

describe("ACP runner record monitor", () => {
  it("renders assistant markdown safely and keeps user turns visually distinct", () => {
    const assistant = detailEvent(1, {
      kind: "message",
      role: "assistant",
      messageId: "assistant-1",
      chunk: false,
      content:
        "## Result\n\n- one\n- two\n\n`inline`\n\n```ts\nconst value = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| mode | ACP |\n\n<script>window.bad = true</script>",
      redaction: { classes: [], replaced: 0 }
    });
    const user = detailEvent(2, {
      kind: "message",
      role: "user",
      messageId: "user-1",
      chunk: false,
      content: "Please continue",
      redaction: { classes: [], replaced: 0 }
    });
    const rendered = render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([assistant, user])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("const value = 1;")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("modeACP");
    expect(screen.getByText("Please continue")).toBeInTheDocument();
    expect(screen.getByText(/<script>window.bad/)).toBeInTheDocument();
    expect(rendered.container.querySelector("script")).toBeNull();
  });

  it("keeps a long projected timeline usable without rendering raw token events", () => {
    const events = Array.from({ length: 160 }, (_, index) =>
      detailEvent(index + 1, {
        kind: "message",
        role: "assistant",
        messageId: `assistant-${index}`,
        chunk: false,
        content: `Message ${index + 1}`,
        redaction: { classes: [], replaced: 0 }
      })
    );
    render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model(events)}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(screen.getAllByRole("article")).toHaveLength(160);
    expect(screen.getByText("Message 160")).toBeInTheDocument();
    const viewport = screen.getByTestId("acp-conversation-viewport");
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    });
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("auto-follows an in-place timeline item update when the authoritative cursor advances", () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo
    });
    try {
      const t = createTranslator("en");
      const initial = [
        {
          sequence: 1,
          timestamp: "2026-07-11T00:00:00.000Z",
          kind: "tool" as const,
          callId: "tool-1",
          title: "Run tests",
          status: "in_progress" as const,
          input: null,
          output: "first"
        }
      ];
      const rendered = render(<AcpConversationTimeline changeKey={1} timeline={initial} t={t} />);
      const callsAfterInitialRender = scrollTo.mock.calls.length;
      rendered.rerender(
        <AcpConversationTimeline
          changeKey={2}
          timeline={[{ ...initial[0], status: "completed", output: "updated" }]}
          t={t}
        />
      );

      expect(scrollTo.mock.calls.length).toBeGreaterThan(callsAfterInitialRender);
    } finally {
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
      } else {
        delete HTMLElement.prototype.scrollTo;
      }
    }
  });

  it("continues a finished ACP session from the composer and preserves Shift+Enter", async () => {
    const identity = desktopAgentPromptIdentitySchema.parse({
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1"
    });
    const sendAgentPrompt = vi.fn(async () => undefined);
    const bridgeApi = api({ sendAgentPrompt });
    render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "canvas-a" }}
        initialModel={model([event(1, "terminal", "done")], noInteraction, [], {
          prompt: { available: true, reason: null, identity, inFlight: false },
          cancel: noIntervention.cancel
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    const input = screen.getByLabelText("Message the agent");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Continue with tests" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(sendAgentPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sendAgentPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendAgentPrompt).toHaveBeenCalledWith(identity, "Continue with tests");
    await vi.waitFor(() => expect(input).toHaveValue(""));
    expect(bridgeApi.subscribeRunnerRecord).toHaveBeenCalledTimes(1);
  });

  it("submits a prompt at most once before React commits the disabled state", async () => {
    const identity = desktopAgentPromptIdentitySchema.parse({
      ref: { projectRoot: "/tmp/project" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1"
    });
    let resolveSend!: () => void;
    const sendAgentPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        })
    );
    render(
      <RunnerRecordMonitor
        api={api({ sendAgentPrompt })}
        initialModel={model([], noInteraction, [], {
          prompt: { available: true, reason: null, identity, inFlight: false },
          cancel: noIntervention.cancel
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    const input = screen.getByLabelText("Message the agent");
    fireEvent.change(input, { target: { value: "Only once" } });
    const send = screen.getByRole("button", { name: "Send message" });
    act(() => {
      send.click();
      send.click();
    });

    expect(sendAgentPrompt).toHaveBeenCalledTimes(1);
    await act(async () => resolveSend());
  });

  it("reopens a terminal prompt subscription while a follow-up is in flight", () => {
    const identity = desktopAgentPromptIdentitySchema.parse({
      ref: { projectRoot: "/tmp/project" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1"
    });
    const bridgeApi = api({});
    render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([event(1, "terminal", "done")], noInteraction, [], {
          prompt: {
            available: false,
            reason: "A follow-up prompt is already running.",
            identity,
            inFlight: true
          },
          cancel: noIntervention.cancel
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(bridgeApi.subscribeRunnerRecord).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Agent is working…")).toBeInTheDocument();
  });

  it("explains why a session cannot accept another prompt", () => {
    render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(screen.getAllByText("No ACP session is available.").length).toBeGreaterThan(0);
  });

  it("aggregates tool updates into one collapsible card with readable input and output", () => {
    const call = detailEvent(1, {
      kind: "tool_call",
      callId: "read-1",
      title: "Read file",
      status: "in_progress",
      content: null,
      rawInput: {
        content: '{"path":"README.md"}',
        redaction: { classes: [], replaced: 0 }
      }
    });
    const update = detailEvent(2, {
      kind: "tool_update",
      callId: "read-1",
      status: "completed",
      rawOutput: {
        content: '{"bytes":42}',
        redaction: { classes: [], replaced: 0 }
      }
    });
    render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([call, update])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(screen.getAllByText("Read file")).toHaveLength(1);
    fireEvent.click(screen.getByText("Read file"));
    expect(screen.getByText("path: README.md")).toBeInTheDocument();
    expect(screen.getByText("bytes: 42")).toBeInTheDocument();
  });

  it("renders and reveals the artifact produced by a real ACP controller run", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-desktop-acp-artifact-"));
    const controller = new AcpSessionController();
    try {
      await controller.execute(
        {
          kind: "implementation",
          identity: {
            scope: root,
            desktopRunId: "DESKTOP-001",
            runSessionId: "SESSION-001",
            executorRunId: "RUN-001",
            claimRef: "T-001#B-001"
          },
          runDir: root,
          metadataPath: join(root, "metadata.json"),
          prompt: "artifact-implementation",
          cwd: root,
          launch: { command: process.execPath, args: [acpFixture, "artifact-implementation"] },
          executorName: "mock-acp",
          agentId: "codex",
          taskId: "T-001",
          metadataIdentity: { blockId: "B-001" },
          projectId: "project-1",
          canvasId: "canvas-a"
        },
        { timeoutMs: 1_000 }
      );
      const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const readModel = await readRunnerRecordReadModel({ runDir: root, metadata });
      if (!readModel) throw new Error("Expected an ACP runner read model.");
      expect(readModel?.events.some((event) => event.body.kind === "artifact")).toBe(true);
      const revealRunnerRecordArtifact = vi.fn(async () => undefined);
      render(
        <RunnerRecordMonitor
          api={api({ revealRunnerRecordArtifact })}
          canvasRef={{ projectRoot: "/tmp/project", canvasId: "canvas-a" }}
          initialModel={readModel}
          recordId="T-001#B-001::RUN-001"
          t={createTranslator("en")}
        />
      );

      expect(screen.getByText(/implementation: report.md/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show in file manager" }));
      expect(revealRunnerRecordArtifact).toHaveBeenCalledWith(
        { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        "T-001#B-001::RUN-001",
        expect.objectContaining({ kind: "implementation", relativePath: "report.md" })
      );
    } finally {
      acpEventReadModels.release(root);
    }
  });

  it("merges reopen replay and live events by sequence without duplicates", async () => {
    let push: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
    const initial = model([event(1, "message", "first")]);
    const current = model([event(1, "message", "first"), event(2, "tool_call", "Read file")]);
    const bridgeApi = api({
      snapshot: current,
      onSubscribe: (callback) => {
        push = callback;
      }
    });
    render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "canvas-a" }}
        initialModel={initial}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText("Read file")).toBeInTheDocument();
    expect(screen.getAllByText("first")).toHaveLength(1);
    expect(screen.queryByText("duplicate")).not.toBeInTheDocument();
    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 1,
        snapshot: current
      })
    );
    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 2,
        snapshot: model([
          event(1, "message", "first"),
          event(2, "tool_call", "Read file"),
          event(3, "message", "live answer")
        ])
      })
    );
    expect(screen.getAllByText("Read file")).toHaveLength(1);
    expect(screen.getByText("live answer")).toBeInTheDocument();
  });

  it("keeps live events that arrive before the replay request resolves", async () => {
    let push: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
    let resolve!: (value: Awaited<ReturnType<DesktopBridgeApi["subscribeRunnerRecord"]>>) => void;
    const subscribeRunnerRecord = vi.fn((_input, callback) => {
      push = callback;
      return new Promise<Awaited<ReturnType<DesktopBridgeApi["subscribeRunnerRecord"]>>>((done) => {
        resolve = done;
      });
    });
    render(
      <RunnerRecordMonitor
        api={{ subscribeRunnerRecord }}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 1,
        snapshot: model([event(2, "message", "early live")])
      })
    );
    await act(async () => {
      resolve({
        subscriptionId: "test-subscription",
        updateSequence: 1,
        snapshot: model([event(1, "message", "replayed"), event(2, "message", "early live")]),
        unsubscribe: vi.fn(async () => undefined)
      });
    });

    expect(screen.getByText("replayed")).toBeInTheDocument();
    expect(screen.getByText("early live")).toBeInTheDocument();
  });

  it("shows stale persisted interaction separately from live pending interaction", () => {
    const { rerender } = render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([], {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    expect(screen.getByText("Persisted request (not actionable)")).toBeInTheDocument();

    rerender(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([], {
          persisted: true,
          active: true,
          stale: false,
          activeRequests: [
            {
              requestId: "permission-1",
              interactionId: "permission-1",
              kind: "permission",
              requestedAt: "2026-07-11T00:00:00.000Z",
              summary: "approval required",
              identity: actionIdentity("permission-1"),
              availability: { available: false, reason: "unsupported in test" },
              permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }]
            }
          ]
        })}
        recordId="T-001#B-001::RUN-002"
        t={createTranslator("en")}
      />
    );
    expect(screen.getByText("Action required")).toBeInTheDocument();
  });

  it("uses authoritative live snapshots for request appearance, resolution, terminal, and reopen", async () => {
    let push: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
    const interaction = detailEvent(1, {
      kind: "interaction",
      interaction: {
        version: "planweave.runner/v1",
        interactionId: "permission-1",
        requestId: "permission-1",
        kind: "permission",
        requestedAt: "2026-07-11T00:00:00.000Z",
        summary: "Allow reading the project?",
        status: "pending",
        actionable: false,
        nonActionableReason: "persisted_history"
      }
    });
    const activeInteraction: RunnerRecordReadModel["interaction"] = {
      persisted: true,
      active: true,
      stale: false,
      activeRequests: [
        {
          requestId: "permission-1",
          interactionId: "permission-1",
          kind: "permission",
          requestedAt: "2026-07-11T00:00:00.000Z",
          summary: "Allow reading the project?",
          identity: actionIdentity("permission-1"),
          availability: { available: true, reason: null },
          permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }]
        }
      ]
    };
    const bridgeApi = api({
      onSubscribe: (callback) => {
        push = callback;
      }
    });
    const rendered = render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 1,
        snapshot: model([interaction], activeInteraction)
      })
    );
    expect((await screen.findAllByText("Allow reading the project?")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Action required").length).toBeGreaterThan(0);

    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 2,
        snapshot: model([interaction], {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        })
      })
    );
    expect(screen.queryByText("Action required")).not.toBeInTheDocument();
    expect(screen.getAllByText("Persisted request (not actionable)").length).toBeGreaterThan(0);

    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 3,
        snapshot: model([interaction, event(2, "terminal", "done")], {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        })
      })
    );
    expect(screen.getByText("Finished")).toBeInTheDocument();
    rendered.unmount();

    const reopenedApi = api({});
    render(
      <RunnerRecordMonitor
        api={reopenedApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([interaction, event(2, "terminal", "done")], {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    expect(screen.getAllByText("Persisted request (not actionable)").length).toBeGreaterThan(0);
    expect(reopenedApi.subscribeRunnerRecord).not.toHaveBeenCalled();
  });

  it("renders replay and live usage, artifact links, and elicitation details read-only", async () => {
    let push: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1] | null = null;
    const revealRunnerRecordArtifact = vi.fn(async () => undefined);
    const artifact = detailEvent(2, {
      kind: "artifact",
      artifact: {
        version: "planweave.runner/v1",
        kind: "implementation",
        relativePath: "report.md",
        sha256: "a".repeat(64),
        sizeBytes: 42,
        mediaType: "text/markdown"
      }
    });
    const replay = model([
      detailEvent(1, {
        kind: "usage_update",
        usedTokens: 120,
        contextWindowTokens: 8_192,
        cost: { amount: 0.01, currency: "USD" }
      }),
      artifact
    ]);
    const bridgeApi = api({
      snapshot: replay,
      onSubscribe: (callback) => {
        push = callback;
      },
      revealRunnerRecordArtifact
    });
    render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "canvas-a" }}
        initialModel={model([])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText(/Used tokens: 120/)).toBeInTheDocument();
    expect(screen.getByText(/implementation: report.md/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in file manager" }));
    expect(revealRunnerRecordArtifact).toHaveBeenCalledWith(
      { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      "T-001#B-001::RUN-001",
      artifact.body.kind === "artifact" ? artifact.body.artifact : null
    );

    const elicitation = detailEvent(3, {
      kind: "interaction",
      interaction: {
        version: "planweave.runner/v1",
        interactionId: "elicitation-1",
        requestId: "elicitation-1",
        kind: "elicitation",
        requestedAt: "2026-07-11T00:00:02.000Z",
        summary: "Choose a deployment region",
        status: "pending",
        actionable: false,
        nonActionableReason: "persisted_history"
      }
    });
    act(() =>
      push?.({
        kind: "snapshot",
        updateSequence: 1,
        snapshot: model([elicitation], {
          persisted: true,
          active: true,
          stale: false,
          activeRequests: [
            {
              requestId: "elicitation-1",
              interactionId: "elicitation-1",
              kind: "elicitation",
              requestedAt: "2026-07-11T00:00:02.000Z",
              summary: "Choose a deployment region",
              identity: actionIdentity("elicitation-1"),
              availability: { available: false, reason: "read only test" },
              elicitationSchema: { type: "object" }
            }
          ]
        })
      })
    );
    expect(screen.getAllByText("Choose a deployment region").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /approve|deny|respond/i })).not.toBeInTheDocument();
  });

  it("deduplicates replay diagnostics by code, line, and message", async () => {
    const diagnostic = { code: "sequence_gap" as const, line: 4, message: "missing sequence" };
    render(
      <RunnerRecordMonitor
        api={api({ snapshot: model([], noInteraction, [diagnostic]) })}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([], noInteraction, [diagnostic])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    expect(await screen.findAllByText(/missing sequence/)).toHaveLength(1);
  });

  it("bounds long diagnostics inside the monitor", () => {
    const longDiagnostic = {
      code: "corrupt_line" as const,
      line: 7,
      message: `Unsupported ACP session update: ${"unbroken".repeat(80)}`
    };
    render(
      <RunnerRecordMonitor
        api={null}
        initialModel={model([], noInteraction, [longDiagnostic])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("runner-record-monitor")).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("runner-record-diagnostics")).toHaveClass(
      "max-h-48",
      "overflow-y-auto"
    );
    expect(screen.getByText(/Unsupported ACP session update/)).toHaveClass(
      "whitespace-pre-wrap",
      "[overflow-wrap:anywhere]"
    );
  });

  it("submits an exact permission response once and waits for an authoritative snapshot", async () => {
    let resolveResponse!: () => void;
    const respondToAgentRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const bridgeApi = api({ respondToAgentRequest });
    const active: RunnerRecordReadModel["interaction"] = {
      persisted: true,
      active: true,
      stale: false,
      activeRequests: [
        {
          requestId: "permission-1",
          interactionId: "permission-1",
          kind: "permission",
          requestedAt: "2026-07-11T00:00:00.000Z",
          summary: "Allow command?",
          identity: actionIdentity("permission-1"),
          availability: { available: true, reason: null },
          permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }]
        }
      ]
    };
    const rendered = render(
      <RunnerRecordMonitor
        api={bridgeApi}
        initialModel={model([], active)}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(respondToAgentRequest).toHaveBeenCalledTimes(1);
    expect(respondToAgentRequest).toHaveBeenCalledWith(actionIdentity("permission-1"), "allow");
    expect(allow).toBeDisabled();
    await act(async () => resolveResponse());
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();

    rendered.rerender(
      <RunnerRecordMonitor
        api={bridgeApi}
        initialModel={model([], {
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        })}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument()
    );
  });

  it("does not route persisted permission identities through the live response bridge", () => {
    const respondToAgentRequest = vi.fn(async () => undefined);
    const persistedModel = runnerRecordReadModelSchema.parse({
      ...model([]),
      actualConfiguration: { available: false, reason: "Unavailable in test." },
      interaction: {
        persisted: true,
        active: true,
        stale: false,
        activeRequests: [
          {
            requestId: "permission-persisted",
            interactionId: "permission-persisted",
            kind: "permission",
            requestedAt: "2026-07-11T00:00:00.000Z",
            summary: "Allow persisted command?",
            identity: {
              projectId: "project-1",
              canvasId: "default",
              claimRef: "T-001#B-001",
              executorRunId: "RUN-001",
              sessionId: "session-1",
              requestId: "permission-persisted",
              ownerLeaseId: "11111111-1111-4111-8111-111111111111",
              ownerGeneration: 1
            },
            availability: { available: true, reason: null },
            permissionOptions: [
              { optionId: "allow", label: "Allow persisted", decision: "approve" }
            ]
          }
        ]
      }
    });
    render(
      <RunnerRecordMonitor
        api={api({ respondToAgentRequest })}
        initialModel={persistedModel}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Persisted request (not actionable)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow persisted" })).not.toBeInTheDocument();
    expect(respondToAgentRequest).not.toHaveBeenCalled();
  });

  it("routes exact cancellation and Preview elicitation through separate controls", () => {
    const respondToAgentRequest = vi.fn(async () => undefined);
    const cancelAgentRun = vi.fn(async () => undefined);
    const requestIdentity = actionIdentity("elicitation-1");
    const { requestId: _requestId, ...sessionIdentity } = requestIdentity;
    render(
      <RunnerRecordMonitor
        api={api({ respondToAgentRequest, cancelAgentRun })}
        initialModel={model(
          [],
          {
            persisted: true,
            active: true,
            stale: false,
            activeRequests: [
              {
                requestId: "elicitation-1",
                interactionId: "elicitation-1",
                kind: "elicitation",
                requestedAt: "2026-07-11T00:00:00.000Z",
                summary: "Choose values",
                identity: requestIdentity,
                availability: { available: true, reason: null },
                elicitationSchema: { type: "object" }
              }
            ]
          },
          [],
          {
            prompt: noIntervention.prompt,
            cancel: { available: true, reason: null, identity: sessionIdentity }
          }
        )}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(cancelAgentRun).toHaveBeenCalledWith(sessionIdentity);
    fireEvent.change(screen.getByLabelText("Preview elicitation response (JSON)"), {
      target: { value: '{"region":"eu"}' }
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(respondToAgentRequest).toHaveBeenCalledWith(requestIdentity, {
      action: "accept",
      content: { region: "eu" }
    });
  });

  it("does not subscribe terminal replay and tears down a live subscription on unmount", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const terminalApi = api({});
    const terminal = render(
      <RunnerRecordMonitor
        api={terminalApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([event(1, "terminal", "done")])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );
    expect(terminalApi.subscribeRunnerRecord).not.toHaveBeenCalled();
    terminal.unmount();

    const liveApi = api({ unsubscribe });
    const live = render(
      <RunnerRecordMonitor
        api={liveApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([event(1, "message", "running")])}
        recordId="T-001#B-001::RUN-002"
        t={createTranslator("en")}
      />
    );
    await screen.findByText("running");
    live.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("hides terminal and tmux controls for ACP records", () => {
    const runnerReadModel = model([event(1, "message", "ACP output")]);
    const record: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "codex-acp",
      adapter: null,
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: "session-1",
      codexSessionId: null,
      tmuxSessionId: "must-not-render",
      tmuxAttachCommand: "tmux attach must-not-render",
      tmuxReadOnlyAttachCommand: "tmux attach -r must-not-render",
      exitCode: null,
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: null,
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/metadata.json",
      stdoutSummary: "terminal stdout must not render",
      stderrSummary: "terminal stderr must not render",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {},
      runnerReadModel
    };

    render(
      <BlockRunRecordCard
        canvasRef={null}
        selectedRunRecord={record}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("ACP output")).toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText(/terminal stdout must not render/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open tmux terminal" })).not.toBeInTheDocument();
    expect(screen.queryByText("Run report")).not.toBeInTheDocument();
    expect(screen.queryByText("No run report")).not.toBeInTheDocument();
  });

  it("keeps the traditional run report for non-ACP records", () => {
    const record: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-002",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      executor: "codex",
      adapter: null,
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: null,
      tmuxAttachCommand: null,
      tmuxReadOnlyAttachCommand: null,
      exitCode: 0,
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "2026-07-11T00:00:01.000Z",
      promptPath: null,
      reportPath: "/tmp/project/report.md",
      metadataPath: "/tmp/project/metadata.json",
      stdoutSummary: null,
      stderrSummary: null,
      promptMarkdown: "",
      reportMarkdown: "# Completed",
      displayMarkdown: "# Completed",
      displayMarkdownSource: "report",
      metadata: {},
      runnerReadModel: null
    };

    render(
      <BlockRunRecordCard
        canvasRef={null}
        selectedRunRecord={record}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Run report")).toBeInTheDocument();
    expect(screen.getByText("# Completed")).toBeInTheDocument();
  });
});
