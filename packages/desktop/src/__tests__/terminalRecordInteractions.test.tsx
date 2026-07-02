/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { BlockRunRecordCard } from "../renderer/inspector/BlockRunRecordCard";
import { createTranslator } from "../renderer/i18n";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopRunRecord,
  DesktopTerminalAppDetection
} from "@planweave-ai/runtime";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const terminalApps: DesktopTerminalAppDetection[] = [
  {
    appId: "terminal",
    label: "Terminal",
    available: true,
    iconDataUrl: null,
    unavailableReason: null
  },
  {
    appId: "iterm2",
    label: "iTerm2",
    available: true,
    iconDataUrl: "data:image/png;base64,aXRlcm0=",
    unavailableReason: null
  },
  {
    appId: "ghostty",
    label: "Ghostty",
    available: false,
    iconDataUrl: null,
    unavailableReason: "Ghostty is not installed."
  }
];

describe("desktop renderer component interactions", () => {
  it("labels successful agent stderr as terminal output instead of an error", () => {
    const runRecord: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "opencode",
      adapter: "opencode-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: "ses_123",
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
      exitCode: 0,
      startedAt: null,
      finishedAt: "2026-05-23T01:49:38.307Z",
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      stdoutSummary: "",
      stderrSummary: "> build · mimo-v2.5-pro → Read README.md ← Write CHECKLIST.md Wrote file successfully.",
      promptMarkdown: "",
      reportMarkdown: "## Implementation Report",
      displayMarkdown: "## Implementation Report",
      displayMarkdownSource: "report",
      metadata: {}
    };

    const { rerender } = render(<BlockRunRecordCard selectedRunRecord={runRecord} setSelectedRunRecord={vi.fn()} t={createTranslator("zh-CN")} />);

    expect(screen.getByText(/终端输出:/)).toBeInTheDocument();
    expect(screen.getByText(/只读监控命令:/)).toBeInTheDocument();
    expect(screen.getByText("tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234")).toBeInTheDocument();
    expect(screen.queryByText(/错误输出:/)).not.toBeInTheDocument();

    rerender(
      <BlockRunRecordCard
        selectedRunRecord={{ ...runRecord, recordId: "T-001#B-001::RUN-LEGACY", runId: "RUN-LEGACY", exitCode: undefined as unknown as number | null }}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByText(/终端输出:/)).toBeInTheDocument();
    expect(screen.queryByText(/错误输出:/)).not.toBeInTheDocument();
  });

  it("opens a tmux run record through the selected terminal app without passing shell commands", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(undefined);
    const onOpenRunTerminal = vi.fn().mockResolvedValue(undefined);
    const onTerminalDefaultAppChange = vi.fn().mockResolvedValue(undefined);
    const runRecord: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "codex",
      adapter: "codex-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
      exitCode: null,
      startedAt: "2026-05-23T01:49:38.307Z",
      finishedAt: null,
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      stdoutSummary: "",
      stderrSummary: "",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {}
    };

    render(
      <BlockRunRecordCard
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "default" }}
        defaultTerminalAppId="iterm2"
        onOpenTerminal={onOpenTerminal}
        onOpenRunTerminal={onOpenRunTerminal}
        onTerminalDefaultAppChange={onTerminalDefaultAppChange}
        selectedRunRecord={runRecord}
        setSelectedRunRecord={vi.fn()}
        terminalAvailability={{
          recordId: "T-001#B-001::RUN-001",
          tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
          available: true,
          unavailableReason: null
        }}
        terminalApps={terminalApps}
        tmuxAvailable={true}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Open tmux terminal" }));

    expect(onTerminalDefaultAppChange).toHaveBeenCalledWith("iterm2");
    expect(onOpenRunTerminal).toHaveBeenCalledWith("T-001#B-001::RUN-001", "iterm2");
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(onOpenRunTerminal.mock.calls[0][0]).not.toContain("tmux attach");
  });

  it("opens a regular terminal when tmux is unavailable", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(undefined);
    const onOpenRunTerminal = vi.fn().mockResolvedValue(undefined);
    const runRecord: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "codex",
      adapter: "codex-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
      exitCode: null,
      startedAt: "2026-05-23T01:49:38.307Z",
      finishedAt: null,
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      stdoutSummary: "",
      stderrSummary: "",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {}
    };

    render(
      <BlockRunRecordCard
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "default" }}
        defaultTerminalAppId="terminal"
        onOpenTerminal={onOpenTerminal}
        onOpenRunTerminal={onOpenRunTerminal}
        selectedRunRecord={runRecord}
        setSelectedRunRecord={vi.fn()}
        terminalAvailability={{
          recordId: "T-001#B-001::RUN-001",
          tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
          available: true,
          unavailableReason: null
        }}
        terminalApps={terminalApps}
        tmuxAvailable={false}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(onOpenTerminal).toHaveBeenCalledWith("T-001#B-001::RUN-001", "terminal");
    expect(onOpenRunTerminal).not.toHaveBeenCalled();
  });

  it("opens a regular terminal for stale tmux run record metadata", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(undefined);
    const onOpenRunTerminal = vi.fn().mockResolvedValue(undefined);
    const runRecord: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-STALE",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-STALE",
      executor: "codex",
      adapter: "codex-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-STALE-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-STALE-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-STALE-abcd1234",
      exitCode: 0,
      startedAt: "2026-05-23T01:49:38.307Z",
      finishedAt: "2026-05-23T01:59:38.307Z",
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-STALE/metadata.json",
      stdoutSummary: "",
      stderrSummary: "",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {}
    };

    render(
      <BlockRunRecordCard
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "default" }}
        defaultTerminalAppId="terminal"
        onOpenTerminal={onOpenTerminal}
        onOpenRunTerminal={onOpenRunTerminal}
        selectedRunRecord={runRecord}
        setSelectedRunRecord={vi.fn()}
        terminalAvailability={{
          recordId: "T-001#B-001::RUN-STALE",
          tmuxSessionId: "planweave-T-001-B-001-RUN-STALE-abcd1234",
          available: false,
          unavailableReason: "tmux_session_not_running"
        }}
        terminalApps={terminalApps}
        tmuxAvailable={true}
        t={createTranslator("en")}
      />
    );

    const button = screen.getByRole("button", { name: "Open terminal" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Open terminal: Terminal - This tmux session is no longer running.");
    await userEvent.click(button);
    expect(onOpenTerminal).toHaveBeenCalledWith("T-001#B-001::RUN-STALE", "terminal");
    expect(onOpenRunTerminal).not.toHaveBeenCalled();
  });

  it("opens the latest block run record that has a tmux session", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(undefined);
    const onOpenRunTerminal = vi.fn().mockResolvedValue(undefined);
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: null,
      effectiveExecutor: "codex",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: "RUN-NEW",
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const blockRunRecords: DesktopBlockRunRecordSummary[] = [
      {
        recordId: "T-001#B-001::RUN-NEW",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-NEW",
        executor: "codex",
        adapter: "codex-exec",
        executionCwd: "/tmp/project",
        projectRoot: "/tmp/project",
        agentSessionId: null,
        codexSessionId: null,
        tmuxSessionId: null,
        tmuxAttachCommand: null,
        tmuxReadOnlyAttachCommand: null,
        exitCode: 0,
        startedAt: "2026-05-24T01:49:38.307Z",
        finishedAt: "2026-05-24T01:59:38.307Z",
        promptPath: null,
        reportPath: null,
        metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-NEW/metadata.json",
        stdoutSummary: "",
        stderrSummary: ""
      },
      {
        recordId: "T-001#B-001::RUN-TMUX",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-TMUX",
        executor: "codex",
        adapter: "codex-exec",
        executionCwd: "/tmp/project",
        projectRoot: "/tmp/project",
        agentSessionId: null,
        codexSessionId: null,
        tmuxSessionId: "planweave-T-001-B-001-RUN-TMUX-abcd1234",
        tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-TMUX-abcd1234",
        tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-TMUX-abcd1234",
        exitCode: 0,
        startedAt: "2026-05-23T01:49:38.307Z",
        finishedAt: "2026-05-23T01:59:38.307Z",
        promptPath: null,
        reportPath: null,
        metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-TMUX/metadata.json",
        stdoutSummary: "",
        stderrSummary: ""
      }
    ];

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={blockRunRecords}
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "default" }}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        onOpenRunTerminal={onOpenRunTerminal}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        terminalApps={terminalApps}
        terminalAvailabilityByRecordId={{
          "T-001#B-001::RUN-NEW": {
            recordId: "T-001#B-001::RUN-NEW",
            tmuxSessionId: null,
            available: false,
            unavailableReason: "no_tmux_session"
          },
          "T-001#B-001::RUN-TMUX": {
            recordId: "T-001#B-001::RUN-TMUX",
            tmuxSessionId: "planweave-T-001-B-001-RUN-TMUX-abcd1234",
            available: true,
            unavailableReason: null
          }
        }}
        terminalDefaultAppId="terminal"
        tmuxAvailable={true}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Open tmux terminal" }));

    expect(onOpenRunTerminal).toHaveBeenCalledWith("T-001#B-001::RUN-TMUX", "terminal");
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("opens a regular terminal from the latest block run when no live tmux session exists", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(undefined);
    const onOpenRunTerminal = vi.fn().mockResolvedValue(undefined);
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: null,
      effectiveExecutor: "codex",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: "RUN-NEW",
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const blockRunRecords: DesktopBlockRunRecordSummary[] = [
      {
        recordId: "T-001#B-001::RUN-NEW",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-NEW",
        executor: "codex",
        adapter: "codex-exec",
        executionCwd: "/tmp/project",
        projectRoot: "/tmp/project",
        agentSessionId: null,
        codexSessionId: null,
        tmuxSessionId: null,
        tmuxAttachCommand: null,
        tmuxReadOnlyAttachCommand: null,
        exitCode: 0,
        startedAt: "2026-05-24T01:49:38.307Z",
        finishedAt: "2026-05-24T01:59:38.307Z",
        promptPath: null,
        reportPath: null,
        metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-NEW/metadata.json",
        stdoutSummary: "",
        stderrSummary: ""
      },
      {
        recordId: "T-001#B-001::RUN-STALE",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-STALE",
        executor: "codex",
        adapter: "codex-exec",
        executionCwd: "/tmp/project",
        projectRoot: "/tmp/project",
        agentSessionId: null,
        codexSessionId: null,
        tmuxSessionId: "planweave-T-001-B-001-RUN-STALE-abcd1234",
        tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-STALE-abcd1234",
        tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-STALE-abcd1234",
        exitCode: 0,
        startedAt: "2026-05-23T01:49:38.307Z",
        finishedAt: "2026-05-23T01:59:38.307Z",
        promptPath: null,
        reportPath: null,
        metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-STALE/metadata.json",
        stdoutSummary: "",
        stderrSummary: ""
      }
    ];

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={blockRunRecords}
        canvasRef={{ projectRoot: "/tmp/project", canvasId: "default" }}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        onOpenRunTerminal={onOpenRunTerminal}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        terminalApps={terminalApps}
        terminalAvailabilityByRecordId={{
          "T-001#B-001::RUN-STALE": {
            recordId: "T-001#B-001::RUN-STALE",
            tmuxSessionId: "planweave-T-001-B-001-RUN-STALE-abcd1234",
            available: false,
            unavailableReason: "tmux_session_not_running"
          }
        }}
        terminalDefaultAppId="terminal"
        tmuxAvailable={true}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(onOpenTerminal).toHaveBeenCalledWith("T-001#B-001::RUN-NEW", "terminal");
    expect(onOpenRunTerminal).not.toHaveBeenCalled();
  });
});
