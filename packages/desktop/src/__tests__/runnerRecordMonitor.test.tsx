/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizedRunnerEventSchema,
  projectAcpConversation,
  type DesktopBridgeApi,
  type DesktopRunRecord,
  type NormalizedRunnerEvent,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { AcpSessionController } from "../../../runtime/src/autoRun/acpSessionController";
import { acpEventReadModels } from "../../../runtime/src/autoRun/acpEventReadModel";
import { readRunnerRecordReadModel } from "../../../runtime/src/autoRun/runnerRecordReadModel";
import { RunnerRecordMonitor } from "../renderer/inspector/RunnerRecordMonitor";
import { BlockRunRecordCard } from "../renderer/inspector/BlockRunRecordCard";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const acpFixture = join(
  process.cwd(),
  "packages/runtime/src/__tests__/support/acpMockAgent.mjs"
);

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
    body: kind === "message"
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

function model(
  events: NormalizedRunnerEvent[],
  interaction: RunnerRecordReadModel["interaction"] = noInteraction,
  diagnostics: RunnerRecordReadModel["diagnostics"] = []
): RunnerRecordReadModel {
  const last = events.at(-1);
  return {
    events,
    conversation: projectAcpConversation(events),
    diagnostics,
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: last?.sequence ?? 0,
      canonicalIdentity: last ? { identity: last.identity, runner: last.runner } : null,
      terminal: last?.body.kind === "terminal"
    },
    terminal: last?.body.kind === "terminal",
    interaction
  };
}

function api(options: {
  snapshot?: RunnerRecordReadModel | null;
  onSubscribe?: (
    callback: Parameters<DesktopBridgeApi["subscribeRunnerRecord"]>[1]
  ) => void;
  unsubscribe?: () => Promise<void>;
  revealRunnerRecordArtifact?: DesktopBridgeApi["revealRunnerRecordArtifact"];
}): Pick<DesktopBridgeApi, "subscribeRunnerRecord" | "revealRunnerRecordArtifact"> {
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
    revealRunnerRecordArtifact:
      options.revealRunnerRecordArtifact ?? vi.fn(async () => undefined)
  };
}

describe("ACP runner record monitor", () => {
  it("renders and reveals the artifact produced by a real ACP controller run", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-desktop-acp-artifact-"));
    const controller = new AcpSessionController();
    try {
      await controller.execute({
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
      }, { timeoutMs: 1_000 });
      const metadata = JSON.parse(
        await readFile(join(root, "metadata.json"), "utf8")
      ) as Record<string, unknown>;
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
    const bridgeApi = api({
      snapshot: model([event(1, "message", "duplicate"), event(2, "tool_call", "Read file")]),
      onSubscribe: (callback) => { push = callback; }
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
    act(() => push?.({
      updateSequence: 1,
      snapshot: model([event(2, "tool_call", "duplicate live tool")])
    }));
    act(() => push?.({
      updateSequence: 2,
      snapshot: model([event(3, "message", "live answer")])
    }));
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

    act(() => push?.({
      updateSequence: 1,
      snapshot: model([event(2, "message", "early live")])
    }));
    await act(async () => {
      resolve({
        subscriptionId: "test-subscription",
        updateSequence: 0,
        snapshot: model([event(1, "message", "replayed")]),
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
          activeRequests: [{
            requestId: "permission-1",
            interactionId: "permission-1",
            kind: "permission",
            requestedAt: "2026-07-11T00:00:00.000Z",
            summary: "approval required"
          }]
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
      activeRequests: [{
        requestId: "permission-1",
        interactionId: "permission-1",
        kind: "permission",
        requestedAt: "2026-07-11T00:00:00.000Z",
        summary: "Allow reading the project?"
      }]
    };
    const bridgeApi = api({ onSubscribe: (callback) => { push = callback; } });
    const rendered = render(
      <RunnerRecordMonitor
        api={bridgeApi}
        canvasRef={{ projectRoot: "/tmp/project" }}
        initialModel={model([])}
        recordId="T-001#B-001::RUN-001"
        t={createTranslator("en")}
      />
    );

    act(() => push?.({ updateSequence: 1, snapshot: model([interaction], activeInteraction) }));
    expect(await screen.findByText("Allow reading the project?")).toBeInTheDocument();
    expect(screen.getAllByText("Action required").length).toBeGreaterThan(0);

    act(() => push?.({
      updateSequence: 2,
      snapshot: model([interaction], {
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      })
    }));
    expect(screen.queryByText("Action required")).not.toBeInTheDocument();
    expect(screen.getAllByText("Persisted request (not actionable)").length).toBeGreaterThan(0);

    act(() => push?.({
      updateSequence: 3,
      snapshot: model([interaction, event(2, "terminal", "done")], {
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      })
    }));
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
      onSubscribe: (callback) => { push = callback; },
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
    act(() => push?.({
      updateSequence: 1,
      snapshot: model([elicitation], {
        persisted: true,
        active: true,
        stale: false,
        activeRequests: [{
          requestId: "elicitation-1",
          interactionId: "elicitation-1",
          kind: "elicitation",
          requestedAt: "2026-07-11T00:00:02.000Z",
          summary: "Choose a deployment region"
        }]
      })
    }));
    expect(screen.getByText("Choose a deployment region")).toBeInTheDocument();
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
  });
});
