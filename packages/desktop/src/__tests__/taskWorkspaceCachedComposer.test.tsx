/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { useMemo } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopBridgeApi, RunnerRecordReadModel } from "@planweave-ai/runtime";
import {
  acpSessionIdSchema,
  canvasIdSchema,
  claimRefSchema,
  executorRunIdSchema
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspaceAppRoute } from "../renderer/views/TaskWorkspaceAppRoute";
import { createTranslator } from "../renderer/i18n";
import { taskWorkspaceNavigationIdentity } from "../renderer/taskWorkspaceNavigation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { deferred } from "./helpers/desktopProjectFixtures";
import {
  controllerApi,
  useControlledNavigationHarness
} from "./helpers/taskWorkspaceControllerHarness";
import { navigation, runnerModel } from "./helpers/taskWorkspaceControllerModelFixture";

const useProjectWorkspace = vi.hoisted(() => vi.fn());
const sendAgentPrompt = vi.hoisted(() => vi.fn<DesktopBridgeApi["sendAgentPrompt"]>());
const cancelAgentPromptTurn = vi.hoisted(() => vi.fn<DesktopBridgeApi["cancelAgentPromptTurn"]>());
const getCurrentAgentPromptTurn = vi.hoisted(() =>
  vi.fn<DesktopBridgeApi["getCurrentAgentPromptTurn"]>()
);
vi.mock("../renderer/ProjectWorkspaceProvider", () => ({ useProjectWorkspace }));
vi.mock("../renderer/bridge", () => ({
  bridge: {
    sendAgentPrompt,
    cancelAgentPromptTurn,
    getCurrentAgentPromptTurn,
    detectDevelopmentTools: async () => []
  },
  collaborationBridge: null,
  operatorControlBridge: null,
  workspaceExecutionBridge: null
}));

const a = "T-001#B-001::RUN-001";
const b = "T-001#B-001::RUN-002";
type Api = ReturnType<typeof controllerApi>["api"];

function model(recordId: string, sessionSuffix = ""): RunnerRecordReadModel {
  const runId = recordId.split("::")[1];
  const base = runnerModel(runId);
  return {
    ...base,
    terminal: true,
    cursor: { ...base.cursor, terminal: true },
    intervention: {
      ...base.intervention,
      prompt: {
        available: true,
        reason: null,
        inFlight: false,
        identity: {
          ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
          recordId,
          executorRunId: executorRunIdSchema.parse(runId),
          claimRef: claimRefSchema.parse("T-001#B-001"),
          sessionId: acpSessionIdSchema.parse(`session-${runId}${sessionSuffix}`)
        }
      }
    }
  };
}

function fixture() {
  const models = new Map([
    [a, model(a)],
    [b, model(b)]
  ]);
  let canvasId = canvasIdSchema.parse("canvas-main");
  const { api } = controllerApi({ readModel: (id) => models.get(id) ?? null });
  const header = api.getTaskWorkspace.getMockImplementation()!;
  api.getTaskWorkspace.mockImplementation(async (input) => {
    const value = await header(input);
    value.project.canvasId = canvasId;
    return value;
  });
  const list = api.listTaskWorkspaceRuns.getMockImplementation()!;
  api.listTaskWorkspaceRuns.mockImplementation(async () => {
    const page = await list();
    page.canvasId = canvasId;
    for (const item of page.items) {
      const prompt = models.get(item.run.record.recordId)!.intervention.prompt;
      item.run.capabilities.prompt = prompt;
      item.run.metadata.agentSessionId = prompt.identity!.sessionId;
      item.run.metadata.terminalState = "succeeded";
    }
    return page;
  });
  const detail = api.getTaskWorkspaceRunDetail.getMockImplementation()!;
  api.getTaskWorkspaceRunDetail.mockImplementation(async (input) => {
    const value = await detail(input);
    value.canvasId = canvasId;
    value.item.run.capabilities.prompt = models.get(input.recordId)!.intervention.prompt;
    value.item.run.metadata.agentSessionId = value.item.run.capabilities.prompt.identity!.sessionId;
    value.record.agentSessionId = value.item.run.metadata.agentSessionId;
    value.item.run.metadata.terminalState = "succeeded";
    return value;
  });
  const setCanvas = (next: string) => {
    canvasId = canvasIdSchema.parse(next);
    for (const value of models.values()) {
      value.intervention.prompt.identity!.ref.canvasId = next;
      value.cursor.canonicalIdentity!.identity.canvasId = canvasId;
    }
  };
  return { api, models, setCanvas };
}

function Harness({
  api,
  recordId = a,
  scope = "project-1",
  canvas = "canvas-main"
}: {
  api: Api;
  recordId?: string;
  scope?: string;
  canvas?: string;
}) {
  const currentNavigation = useMemo(() => {
    const target = navigation(recordId);
    return taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: canvasIdSchema.parse(canvas),
        taskId: target.taskId,
        blockRef: target.blockRef,
        recordId
      },
      target.source
    );
  }, [recordId, canvas]);
  const controller = useControlledNavigationHarness(api, currentNavigation);
  useProjectWorkspace.mockReturnValue({
    shell: { t: createTranslator("en"), selectedProject: { projectId: scope } },
    taskWorkspace: controller
  });
  return (
    <>
      <button type="button" onClick={controller.refresh}>
        Refresh runtime
      </button>
      <output data-testid="selected-record">
        {controller.selectedRun?.item.run.record.recordId}
      </output>
      <TaskWorkspaceAppRoute />
    </>
  );
}

function input() {
  return screen.getByRole("textbox", { name: "Message the agent" });
}
function edit(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}
function send() {
  fireEvent.keyDown(input(), { key: "Enter" });
}
async function selected(recordId: string) {
  await waitFor(() => expect(screen.getByTestId("selected-record")).toHaveTextContent(recordId));
  await waitFor(() => expect(input()).toBeEnabled());
}
function terminal(request: Parameters<DesktopBridgeApi["sendAgentPrompt"]>[0], cancelled = false) {
  return {
    identity: request.identity,
    phase: "terminal" as const,
    terminal: cancelled ? ("cancelled" as const) : ("succeeded" as const),
    cancellable: false,
    cancellationRequested: cancelled
  };
}

beforeEach(() => {
  sendAgentPrompt.mockReset();
  cancelAgentPromptTurn.mockReset();
  getCurrentAgentPromptTurn.mockReset().mockResolvedValue({ found: false, reason: "not_found" });
});
afterEach(cleanupRendererTestEnvironment);

async function warmed() {
  const value = fixture();
  const view = render(<Harness api={value.api} />);
  await selected(a);
  view.rerender(<Harness api={value.api} recordId={b} />);
  await selected(b);
  view.rerender(<Harness api={value.api} />);
  await selected(a);
  expect(value.api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);
  const textarea = input();
  const choose = async (recordId: string) => {
    view.rerender(<Harness api={value.api} recordId={recordId} />);
    await waitFor(() => expect(screen.getByTestId("selected-record")).toHaveTextContent(recordId));
    expect(input()).toBe(textarea);
    expect(value.api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);
  };
  return { ...value, view, choose };
}

describe("cached Task Workspace composer through the production controller and route", () => {
  it("retains A/B drafts in the same cached mounted tree", async () => {
    const { choose } = await warmed();
    edit("A original");
    await choose(b);
    expect(input()).toHaveValue("");
    edit("B draft");
    await choose(a);
    expect(input()).toHaveValue("A original");
    await choose(b);
    expect(input()).toHaveValue("B draft");
  });

  it("keeps B text when A succeeds after B is visibly selected", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    const { choose } = await warmed();
    edit("A sent");
    send();
    expect(sendAgentPrompt).toHaveBeenCalledOnce();
    await choose(b);
    edit("B must survive");
    await act(async () => pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0])));
    expect(screen.getByTestId("selected-record")).toHaveTextContent(b);
    expect(input()).toHaveValue("B must survive");
    await choose(a);
    expect(input()).toHaveValue("");
  });

  it("keeps newer A edits after success while another identity is selected", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    const { choose } = await warmed();
    edit("A sent");
    send();
    // Editing remains a draft operation even while sending is disabled.
    edit("A newer revision");
    await choose(b);
    edit("B draft");
    await act(async () => pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0])));
    expect(input()).toHaveValue("B draft");
    await choose(a);
    expect(input()).toHaveValue("A newer revision");
  });

  it.each([
    "failure",
    "cancelled"
  ] as const)("keeps A draft after %s without changing B", async (outcome) => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    const { choose } = await warmed();
    edit("A retained");
    send();
    await choose(b);
    edit("B retained");
    await act(async () => {
      if (outcome === "failure") pending.reject(new Error("A delayed failure"));
      else pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0], true));
    });
    expect(input()).toHaveValue("B retained");
    expect(screen.queryByText(/A delayed failure/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
    await choose(a);
    expect(input()).toHaveValue("A retained");
  });

  it("allows B send while A is pending and prevents a second A turn after a cached return", async () => {
    const pendingA = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    const pendingB = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation((request) =>
      request.identity.recordId === a ? pendingA.promise : pendingB.promise
    );
    const { choose, view, api } = await warmed();
    edit("A pending");
    send();
    await choose(b);
    edit("B pending");
    send();
    expect(sendAgentPrompt).toHaveBeenCalledTimes(2);
    await choose(a);
    expect(input()).toHaveValue("A pending");
    expect(input()).toBeDisabled();
    view.rerender(<Harness api={api} />);
    expect(input()).toHaveValue("A pending");
    send();
    expect(sendAgentPrompt).toHaveBeenCalledTimes(2);
    await act(async () => pendingB.resolve(terminal(sendAgentPrompt.mock.calls[1][0])));
    expect(input()).toBeDisabled();
    await act(async () => pendingA.resolve(terminal(sendAgentPrompt.mock.calls[0][0])));
    expect(input()).toHaveValue("");
  });

  it("ignores late recovery and cancel rejection after B is visibly selected", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    const cancel = deferred<Awaited<ReturnType<DesktopBridgeApi["cancelAgentPromptTurn"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    cancelAgentPromptTurn.mockImplementation(() => cancel.promise);
    const { choose } = await warmed();
    edit("A retained");
    send();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(cancelAgentPromptTurn).toHaveBeenCalledOnce();
    await choose(b);
    edit("B retained");
    await act(async () => cancel.reject(new Error("A late cancel")));
    expect(input()).toHaveValue("B retained");
    expect(screen.queryByText(/A late cancel/)).not.toBeInTheDocument();
    await act(async () => pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0], true)));
    const recovery = deferred<Awaited<ReturnType<DesktopBridgeApi["getCurrentAgentPromptTurn"]>>>();
    getCurrentAgentPromptTurn.mockImplementationOnce(() => recovery.promise);
    await choose(a);
    await choose(b);
    await act(async () => recovery.reject(new Error("A late recovery")));
    expect(input()).toHaveValue("B retained");
    expect(screen.queryByText(/A late recovery/)).not.toBeInTheDocument();
    await choose(a);
    expect(input()).toHaveValue("A retained");
  });

  it.each([
    "project",
    "canvas",
    "unmount"
  ] as const)("retires drafts and pending callbacks after %s replacement", async (kind) => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    const { view, api, setCanvas } = await warmed();
    edit("retired draft");
    send();
    if (kind === "unmount") {
      view.unmount();
      render(<Harness api={api} />);
    } else {
      if (kind === "canvas") {
        setCanvas("canvas-new");
      }
      view.rerender(
        <Harness
          api={api}
          scope={kind === "project" ? "project-2" : "project-1"}
          canvas={kind === "canvas" ? "canvas-new" : "canvas-main"}
        />
      );
    }
    await selected(a);
    expect(input()).toHaveValue("");
    edit("new owner draft");
    await act(async () => pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0])));
    expect(input()).toHaveValue("new owner draft");
    expect(input()).toBeEnabled();
  });

  it("keeps pending state on a rebuilt runtime model and isolates a replacement session in the same tree", async () => {
    const pending = deferred<Awaited<ReturnType<DesktopBridgeApi["sendAgentPrompt"]>>>();
    sendAgentPrompt.mockImplementation(() => pending.promise);
    const { api, models } = await warmed();
    const listener = api.subscribeRunnerRecord.mock.calls.findLast(
      ([input]) => input.recordId === a
    )![1];
    edit("old session sent");
    send();
    const rebuilt = model(a);
    rebuilt.cursor.afterSequence = 1;
    await act(async () => listener({ kind: "snapshot", updateSequence: 1, snapshot: rebuilt }));
    expect(input()).toHaveValue("old session sent");
    expect(input()).toBeDisabled();
    send();
    expect(sendAgentPrompt).toHaveBeenCalledOnce();
    const replacement = model(a, "-replacement");
    replacement.cursor.afterSequence = 2;
    models.set(a, replacement);
    fireEvent.click(screen.getByRole("button", { name: "Refresh runtime" }));
    await waitFor(() => expect(input()).toBeEnabled());
    expect(input()).toHaveValue("");
    edit("new session draft");
    await act(async () => pending.resolve(terminal(sendAgentPrompt.mock.calls[0][0])));
    expect(input()).toHaveValue("new session draft");
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
  });

  it("preserves the draft across an uncached null-model interval", async () => {
    const { view, api, models } = await warmed();
    edit("A draft before loading");
    const uncachedId = "T-001#B-001::RUN-003";
    models.set(uncachedId, model(uncachedId));
    const read = api.getTaskWorkspaceRunDetail.getMockImplementation()!;
    const loading = deferred<Awaited<ReturnType<typeof read>>>();
    api.getTaskWorkspaceRunDetail.mockImplementationOnce(() => loading.promise);
    view.rerender(<Harness api={api} recordId={uncachedId} />);
    expect(screen.queryByRole("textbox", { name: "Message the agent" })).not.toBeInTheDocument();
    view.rerender(<Harness api={api} />);
    await selected(a);
    expect(input()).toHaveValue("A draft before loading");
    await act(async () => loading.resolve(await read({ recordId: uncachedId })));
    expect(screen.getByTestId("selected-record")).toHaveTextContent(a);
    expect(input()).toHaveValue("A draft before loading");
  });
});
