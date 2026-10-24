import "@testing-library/jest-dom/vitest";
import type { DesktopAutoRunEvent } from "@planweave-ai/runtime";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { defaultDesktopSettings } from "../../shared/desktopSettings";
import { resetCommentDraftStoreForTests } from "../../renderer/collaboration/commentDraftStore";
import { TaskInspectorWindow } from "../../renderer/TaskInspectorWindow";
import { BlockInspectorWindow } from "../../renderer/BlockInspectorWindow";
import {
  createInspectorAssigneeFixture,
  inspectorGraph,
  inspectorTask,
  inspectorBlock
} from "./inspectorAssigneeSessionFixture";
import { cleanupRendererTestEnvironment, stubSelectLayoutApis } from "./rendererTestEnvironment";

const ports = vi.hoisted(() => ({
  collaboration: null as PlanWeaveCollaborationApi | null,
  desktop: {
    getGraphViewModel: vi.fn(),
    getTaskDetail: vi.fn(),
    getBlockDetail: vi.fn(),
    listBlockRunRecords: vi.fn(async () => []),
    getReviewAttempts: vi.fn(async () => []),
    getFeedbackRecords: vi.fn(async () => []),
    onAutoRunChanged: vi.fn<(listener: (event: DesktopAutoRunEvent) => void) => () => void>(
      () => () => undefined
    ),
    detectTerminalApps: vi.fn(async () => []),
    getTerminalPreferences: vi.fn(async () => ({ defaultTerminalAppId: null })),
    detectRuntimeTools: vi.fn(async () => ({ tmux: { available: false } }))
  }
}));
vi.mock("../../renderer/bridge", () => ({
  get collaborationBridge() {
    return ports.collaboration;
  },
  bridge: ports.desktop,
  operatorControlBridge: null,
  workspaceExecutionBridge: null
}));
vi.mock("../../renderer/hooks/useDesktopSettingsBridge", () => ({
  useDesktopSettingsBridge: () => ({
    settings: defaultDesktopSettings,
    updateSettingsAndWait: vi.fn()
  })
}));
vi.mock("../../renderer/hooks/useDetectedAgents", () => ({
  useDetectedAgents: () => ({ agentDetections: [] })
}));
vi.mock("../../renderer/hooks/useWorkspaceAgentEndpointCatalog", () => ({
  useWorkspaceAgentEndpointCatalog: () => ({
    endpoints: [],
    refresh: vi.fn(),
    refreshing: false,
    savePreference: vi.fn()
  })
}));

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCommentDraftStoreForTests();
  ports.collaboration = null;
  window.history.replaceState(null, "", "/");
});

export function mountInspector(
  kind: "task" | "block",
  configure?: (fixture: ReturnType<typeof createInspectorAssigneeFixture>) => void,
  graph = inspectorGraph
) {
  stubSelectLayoutApis();
  ports.desktop.onAutoRunChanged.mockClear();
  const fixture = createInspectorAssigneeFixture(kind);
  ports.collaboration = fixture.api;
  ports.desktop.getGraphViewModel.mockResolvedValue(graph);
  ports.desktop.getTaskDetail.mockResolvedValue(inspectorTask);
  ports.desktop.getBlockDetail.mockResolvedValue(inspectorBlock);
  configure?.(fixture);
  window.history.replaceState(
    null,
    "",
    `/?window=${kind}-inspector&projectRoot=%2Finspector&canvasId=canvas-1&taskId=T-1&blockRef=T-1%23B-1&language=en`
  );
  const view = render(kind === "task" ? <TaskInspectorWindow /> : <BlockInspectorWindow />);
  return { ...fixture, ...view, user: userEvent.setup() };
}

export async function expectAuthorities(owner: string, reviewer: string) {
  await waitFor(() => {
    for (const [role, expected] of [
      ["responsibility", owner],
      ["reviewer", reviewer]
    ]) {
      const field = within(screen.getByTestId(`authority-field-${role}`));
      expect(field.getByTestId("assignee-current-label")).toHaveTextContent(expected);
      expect(field.getByTestId("assignee-picker")).toHaveAttribute("data-mode", "ready");
    }
  });
}

export { ports };
