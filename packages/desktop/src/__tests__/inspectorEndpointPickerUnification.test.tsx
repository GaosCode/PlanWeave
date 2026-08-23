/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopBlockDetail, DesktopTaskDetail } from "@planweave-ai/runtime";
import { changeAgentEndpointSelection } from "../renderer/collaboration/changeAgentEndpoint";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import {
  AgentEndpointSelect,
  inheritAgentEndpointValue
} from "../renderer/collaboration/AgentEndpointSelect";
import { TaskInspector } from "../renderer/inspector/TaskInspector";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { createTranslator } from "../renderer/i18n";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const localCodex: AvailableAgentEndpoint = {
  id: "local:codex",
  source: "local",
  executorName: "codex",
  displayName: "Codex",
  locationName: "",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.codex"],
  localExecutorName: "codex"
};

const localGrok: AvailableAgentEndpoint = {
  id: "local:grok",
  source: "local",
  executorName: "grok",
  displayName: "Grok",
  locationName: "",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.grok"],
  localExecutorName: "grok"
};

const remoteGrok: AvailableAgentEndpoint = {
  id: "remote:endpoint-grok",
  source: "remote",
  executorName: "grok",
  displayName: "Grok",
  locationName: "LINANIML",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.grok"],
  remoteEndpointId: "endpoint-grok"
};

const incompatibleRemotePi: AvailableAgentEndpoint = {
  id: "remote:endpoint-pi",
  source: "remote",
  executorName: "pi",
  displayName: "Pi",
  locationName: "VM-0-3-ubuntu",
  available: false,
  unavailableReason: "agent_endpoint_incompatible",
  capabilities: ["acp.pi"],
  remoteEndpointId: "endpoint-pi"
};

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walkTsFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("changeAgentEndpointSelection", () => {
  it("atomically writes manifest executor and preference for an explicit endpoint", async () => {
    const changeLogicalExecutor = vi.fn().mockResolvedValue(true);
    const savePreference = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();

    await changeAgentEndpointSelection({
      endpointId: remoteGrok.id,
      endpoints: [localCodex, remoteGrok],
      preferenceKey: '["/proj","default","task","T-001"]',
      changeLogicalExecutor,
      savePreference,
      setError
    });

    expect(changeLogicalExecutor).toHaveBeenCalledWith("grok");
    expect(savePreference).toHaveBeenCalledWith('["/proj","default","task","T-001"]', remoteGrok);
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps an equivalent ACP executor unchanged when only the endpoint location changes", async () => {
    const changeLogicalExecutor = vi.fn().mockResolvedValue(true);
    const savePreference = vi.fn().mockResolvedValue(undefined);

    await changeAgentEndpointSelection({
      endpointId: localGrok.id,
      endpoints: [localGrok],
      preferenceKey: '["remote","w","p","c","task","T-001"]',
      currentLogicalExecutorName: "grok-acp",
      changeLogicalExecutor,
      savePreference,
      setError: vi.fn()
    });

    expect(changeLogicalExecutor).not.toHaveBeenCalled();
    expect(savePreference).toHaveBeenCalledWith('["remote","w","p","c","task","T-001"]', localGrok);
  });

  it("clears block executor and block preference when inheriting the task", async () => {
    const changeLogicalExecutor = vi.fn().mockResolvedValue(true);
    const savePreference = vi.fn().mockResolvedValue(undefined);

    await changeAgentEndpointSelection({
      endpointId: inheritAgentEndpointValue,
      endpoints: [localCodex, remoteGrok],
      preferenceKey: '["/proj","default","block","T-001#B-001"]',
      allowInherit: true,
      changeLogicalExecutor,
      savePreference,
      setError: vi.fn()
    });

    expect(changeLogicalExecutor).toHaveBeenCalledWith(null);
    expect(savePreference).toHaveBeenCalledWith('["/proj","default","block","T-001#B-001"]', null);
  });

  it("writes block.executor and block-scope preference for an explicit block selection", async () => {
    const changeLogicalExecutor = vi.fn().mockResolvedValue(true);
    const savePreference = vi.fn().mockResolvedValue(undefined);
    const blockPreferenceKey = '["/proj","default","block","T-001#B-001"]';

    await changeAgentEndpointSelection({
      endpointId: localGrok.id,
      endpoints: [localCodex, localGrok],
      preferenceKey: blockPreferenceKey,
      allowInherit: true,
      changeLogicalExecutor,
      savePreference,
      setError: vi.fn()
    });

    expect(changeLogicalExecutor).toHaveBeenCalledWith("grok");
    expect(savePreference).toHaveBeenCalledWith(blockPreferenceKey, localGrok);
  });
});

describe("inspector endpoint picker uniqueness", () => {
  it("shows an unassigned Workspace placeholder and never exposes internal reason codes", async () => {
    stubSelectLayoutApis();

    render(
      <AgentEndpointSelect
        ariaLabel="Agent Endpoint"
        endpoints={[incompatibleRemotePi]}
        onValueChange={vi.fn()}
        selectedEndpointId="unassigned:codex"
        selectedUnknownLabel="Choose a Workspace execution device"
        unavailableLabel="Unavailable"
      />
    );

    expect(screen.getByRole("combobox", { name: "Agent Endpoint" })).toHaveTextContent(
      "Choose a Workspace execution device"
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Agent Endpoint" }));
    expect(await screen.findByRole("option", { name: /Pi · VM-0-3-ubuntu/i })).toHaveTextContent(
      "Unavailable"
    );
    expect(screen.queryByText("agent_endpoint_incompatible")).not.toBeInTheDocument();
  });

  it("renders TaskInspector executor choice as a single Agent Endpoint selector", async () => {
    stubSelectLayoutApis();
    const onAgentEndpointChange = vi.fn();
    const selectedTask: DesktopTaskDetail = {
      taskId: "T-001",
      graphVersion: "pgv-task",
      title: "Task",
      status: "ready",
      executor: "codex",
      promptMarkdown: "# Task",
      promptHash: "hash-task",
      promptMissing: false,
      acceptance: [],
      blockOrder: []
    };

    render(
      <TaskInspector
        agentEndpoints={[localCodex, localGrok, remoteGrok]}
        error={null}
        graph={null}
        onAgentEndpointChange={onAgentEndpointChange}
        onClose={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedAgentEndpointId="local:codex"
        selectedTask={selectedTask}
        setSelectedTask={vi.fn()}
        t={createTranslator("en")}
      />
    );

    const selectors = screen.getAllByRole("combobox", { name: "Agent Endpoint" });
    expect(selectors).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Agent" })).not.toBeInTheDocument();

    await userEvent.click(selectors[0]!);
    await userEvent.click(await screen.findByRole("option", { name: /Grok · LINANIML/i }));
    expect(onAgentEndpointChange).toHaveBeenCalledWith("remote:endpoint-grok");
  });

  it("renders BlockInspector executor choice as a single Agent Endpoint selector with inherit", async () => {
    stubSelectLayoutApis();
    const onAgentEndpointChange = vi.fn();
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement",
      status: "ready",
      executor: null,
      effectiveExecutor: "codex",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };

    render(
      <BlockInspector
        agentEndpoints={[localCodex, remoteGrok]}
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["codex", "grok"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onAgentEndpointChange={onAgentEndpointChange}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedAgentEndpointId={inheritAgentEndpointValue}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    const selectors = screen.getAllByRole("combobox", { name: "Agent Endpoint" });
    expect(selectors).toHaveLength(1);

    await userEvent.click(selectors[0]!);
    expect(await screen.findByRole("option", { name: /Inherit/i })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: /Grok · LINANIML/i }));
    expect(onAgentEndpointChange).toHaveBeenCalledWith("remote:endpoint-grok");
  });
});

describe("no parallel UI executor write paths", () => {
  it("keeps UI executor writes behind changeAgentEndpointSelection / changeEndpoint", () => {
    const rendererRoot = join(process.cwd(), "packages/desktop/src/renderer");
    const files = walkTsFiles(rendererRoot);
    const violations: string[] = [];

    const allowedDirectLogicalWriteFiles = new Set([
      // Low-level manifest writers used only as the first half of changeEndpoint.
      join(rendererRoot, "hooks/useTaskExecutorActions.ts"),
      join(rendererRoot, "hooks/useSelectedBlock.ts"),
      join(rendererRoot, "task-workspace/useTaskWorkspaceExecutorActions.ts"),
      join(rendererRoot, "BlockInspectorWindow.tsx"),
      join(rendererRoot, "TaskInspectorWindow.tsx")
    ]);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const relative = file.slice(rendererRoot.length + 1);

      if (
        /saveSelectedTaskExecutor\s*=/.test(source) ||
        /saveSelectedTaskExecutor\s*\(/.test(source)
      ) {
        violations.push(`${relative}: saveSelectedTaskExecutor UI entry`);
      }

      if (
        relative.includes("inspector/TaskInspector.tsx") &&
        /buildExecutorOptionViews|SelectItem.*executor/.test(source)
      ) {
        violations.push(`${relative}: logical executor dropdown still present`);
      }

      if (
        /updateTaskExecutor\(|updateBlockExecutor\(/.test(source) &&
        !allowedDirectLogicalWriteFiles.has(file) &&
        !relative.endsWith("changeAgentEndpoint.ts")
      ) {
        // UI surfaces must not call bridge executor writers except through the
        // documented atomic changeEndpoint half-writers listed above.
        if (
          relative.endsWith("tsx") ||
          relative.includes("hooks/") ||
          relative.includes("task-workspace/")
        ) {
          violations.push(
            `${relative}: direct update*Executor outside changeEndpoint half-writers`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
