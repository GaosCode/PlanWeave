/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  runnerRecordReadModelSchema,
  type DesktopBridgeApi,
  type RunnerInteractionIdentity,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { RunnerRecordMonitor } from "../renderer/inspector/RunnerRecordMonitor";
import { TaskWorkspaceInteractionCards } from "../renderer/task-workspace/conversation/TaskWorkspaceInteractionCards";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { readModel, recordId, timestamp } from "./helpers/taskWorkspaceConversationFixture";

const t = createTranslator("en");
const canvasRef = { projectRoot: "/projects/demo", canvasId: "canvas-main" };
const ownerLeaseId = "11111111-1111-4111-8111-111111111111";

afterEach(cleanupRendererTestEnvironment);

function persistedPermission(
  availability: { available: boolean; reason: string | null } = {
    available: true,
    reason: null
  },
  identityOverrides: Partial<RunnerInteractionIdentity> = {}
) {
  const identity = {
    projectId: "project-1",
    canvasId: "default",
    claimRef: "T-001#B-001",
    executorRunId: "RUN-001",
    sessionId: "ACP-SESSION-001",
    requestId: "permission-persisted",
    ownerLeaseId,
    ownerGeneration: 1,
    ...identityOverrides
  };
  return {
    kind: "permission" as const,
    requestId: identity.requestId,
    interactionId: identity.requestId,
    requestedAt: timestamp,
    summary: "Allow the persisted operation?",
    identity,
    availability,
    permissionOptions: [
      { optionId: "approve-once", label: "Approve once", decision: "approve" as const },
      { optionId: "deny-once", label: "Deny once", decision: "deny" as const }
    ]
  };
}

function modelWithPermission(
  availability?: Parameters<typeof persistedPermission>[0]
): RunnerRecordReadModel {
  return readModel({ activeRequests: [persistedPermission(availability)] });
}

function deferredReceipt() {
  let resolve!: (
    result: Awaited<ReturnType<DesktopBridgeApi["respondToRunnerInteraction"]>>
  ) => void;
  const promise = new Promise<Awaited<ReturnType<DesktopBridgeApi["respondToRunnerInteraction"]>>>(
    (promiseResolve) => {
      resolve = promiseResolve;
    }
  );
  return { promise, resolve };
}

function receipt(
  decision: Parameters<DesktopBridgeApi["respondToRunnerInteraction"]>[2]
): Awaited<ReturnType<DesktopBridgeApi["respondToRunnerInteraction"]>> {
  return {
    ok: true,
    value: {
      version: "planweave.runner-interaction-response-receipt/v1",
      identity: persistedPermission().identity,
      acceptedAt: "2026-07-17T00:00:00.000Z",
      decision,
      selectedOption:
        decision.kind === "select"
          ? {
              optionId: decision.optionId,
              label: decision.optionId === "deny-once" ? "Deny once" : "Approve once",
              decision: decision.optionId === "deny-once" ? "deny" : "approve"
            }
          : null,
      decisionSource: "planweave-desktop"
    }
  };
}

describe("Desktop persisted runner interactions", () => {
  it("submits an advertised option once and refreshes authoritative state after conflict", async () => {
    const model = modelWithPermission();
    const pending = deferredReceipt();
    const listPendingRunnerInteractions = vi.fn(async () => ({ ok: true as const, value: [] }));
    const respondToRunnerInteraction = vi.fn(() => pending.promise);
    const rendered = render(
      <TaskWorkspaceInteractionCards
        api={{ listPendingRunnerInteractions, respondToRunnerInteraction }}
        canvasRef={canvasRef}
        model={model}
        recordId={recordId}
        sessionIdentity={null}
        t={t}
      />
    );

    const approve = screen.getByRole("button", { name: "Approve once" });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(respondToRunnerInteraction).toHaveBeenCalledTimes(1);
    expect(respondToRunnerInteraction).toHaveBeenCalledWith(
      canvasRef,
      { recordId, requestId: "permission-persisted", ownerLeaseId },
      { kind: "select", optionId: "approve-once" },
      { decisionSource: "planweave-desktop", reason: null }
    );
    expect(approve).toBeDisabled();

    pending.resolve({
      ok: false,
      error: {
        code: "interaction_already_answered",
        message: "Runner interaction is already settled.",
        details: { requestId: "permission-persisted" }
      }
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This permission request was already answered."
    );
    expect(listPendingRunnerInteractions).toHaveBeenCalledWith(canvasRef);
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();

    const nextOwnerLeaseId = "22222222-2222-4222-8222-222222222222";
    const nextPermission = persistedPermission(undefined, {
      requestId: "permission-reopened",
      ownerLeaseId: nextOwnerLeaseId,
      ownerGeneration: 2
    });
    respondToRunnerInteraction.mockImplementation(async (_ref, _action, decision) =>
      receipt(decision)
    );
    rendered.rerender(
      <TaskWorkspaceInteractionCards
        api={{ listPendingRunnerInteractions, respondToRunnerInteraction }}
        canvasRef={canvasRef}
        model={readModel({ activeRequests: [nextPermission] })}
        recordId={recordId}
        sessionIdentity={null}
        t={t}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve once" }));
    expect(respondToRunnerInteraction).toHaveBeenLastCalledWith(
      canvasRef,
      {
        recordId,
        requestId: "permission-reopened",
        ownerLeaseId: nextOwnerLeaseId
      },
      { kind: "select", optionId: "approve-once" },
      { decisionSource: "planweave-desktop", reason: null }
    );
  });

  it("keeps a transiently unavailable owner card and reopens it from a recovered read model", async () => {
    const listPendingRunnerInteractions = vi.fn(async () => ({ ok: true as const, value: [] }));
    const respondToRunnerInteraction = vi
      .fn<DesktopBridgeApi["respondToRunnerInteraction"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "interaction_owner_unavailable",
          message: "Runner owner is unavailable.",
          details: null
        }
      })
      .mockImplementation(async (_ref, _action, decision) => receipt(decision));
    const props = {
      api: { listPendingRunnerInteractions, respondToRunnerInteraction },
      canvasRef,
      recordId,
      sessionIdentity: null,
      t
    };
    const rendered = render(
      <TaskWorkspaceInteractionCards {...props} model={modelWithPermission()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The run owner is unavailable. Wait for it to reconnect."
    );
    expect(screen.getByText("Allow the persisted operation?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(listPendingRunnerInteractions).toHaveBeenCalledWith(canvasRef);

    rendered.rerender(<TaskWorkspaceInteractionCards {...props} model={modelWithPermission()} />);
    const recoveredApprove = await screen.findByRole("button", { name: "Approve once" });
    fireEvent.click(recoveredApprove);
    expect(respondToRunnerInteraction).toHaveBeenCalledTimes(2);
  });

  it("submits explicit cancel separately from Agent-advertised allow and deny options", () => {
    const respondToRunnerInteraction = vi.fn<DesktopBridgeApi["respondToRunnerInteraction"]>(
      async (_ref, _action, decision) => receipt(decision)
    );
    render(
      <TaskWorkspaceInteractionCards
        api={{
          listPendingRunnerInteractions: vi.fn(async () => ({ ok: true as const, value: [] })),
          respondToRunnerInteraction
        }}
        canvasRef={canvasRef}
        model={modelWithPermission()}
        recordId={recordId}
        sessionIdentity={null}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(respondToRunnerInteraction).toHaveBeenCalledWith(
      canvasRef,
      { recordId, requestId: "permission-persisted", ownerLeaseId },
      { kind: "cancel" },
      {
        decisionSource: "planweave-desktop",
        reason: "User cancelled the permission request in PlanWeave Desktop."
      }
    );
  });

  it("localizes a stale owner reason and renders no response buttons", () => {
    render(
      <TaskWorkspaceInteractionCards
        api={null}
        canvasRef={canvasRef}
        model={modelWithPermission({ available: false, reason: "owner_unavailable" })}
        recordId={recordId}
        sessionIdentity={null}
        t={t}
      />
    );

    expect(
      screen.getByText("The run owner is unavailable. Wait for it to reconnect.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny once" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel request" })).not.toBeInTheDocument();
  });

  it("shows persisted contract diagnostics and fails closed without action buttons", () => {
    const base = modelWithPermission();
    const invalid = runnerRecordReadModelSchema.parse({
      ...base,
      interaction: {
        ...base.interaction,
        diagnostic: {
          code: "contract_invalid",
          message: "Persisted runner interaction contract is invalid.",
          issues: [{ source: "mailbox", message: "Request schema is invalid." }]
        }
      }
    });
    render(
      <TaskWorkspaceInteractionCards
        api={null}
        canvasRef={canvasRef}
        model={invalid}
        recordId={recordId}
        sessionIdentity={null}
        t={t}
      />
    );

    expect(screen.getByTestId("runner-interaction-diagnostic")).toHaveTextContent(
      "Persisted runner interaction contract is invalid."
    );
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel request" })).not.toBeInTheDocument();
  });

  it("uses the same canvas-scoped response path in Runner Record Monitor", () => {
    const respondToRunnerInteraction = vi.fn<DesktopBridgeApi["respondToRunnerInteraction"]>(
      async (_ref, _action, decision) => receipt(decision)
    );
    const api = {
      listPendingRunnerInteractions: vi.fn(async () => ({ ok: true as const, value: [] })),
      respondToRunnerInteraction,
      revealRunnerRecordArtifact: vi.fn(async () => undefined),
      subscribeRunnerRecord: vi.fn(async () => ({
        subscriptionId: "persisted-interaction-test",
        updateSequence: 0 as const,
        snapshot: null,
        unsubscribe: vi.fn(async () => undefined)
      }))
    };
    render(
      <RunnerRecordMonitor
        api={api}
        canvasRef={canvasRef}
        initialModel={modelWithPermission()}
        recordId={recordId}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Deny once" }));
    expect(respondToRunnerInteraction).toHaveBeenCalledWith(
      canvasRef,
      { recordId, requestId: "permission-persisted", ownerLeaseId },
      { kind: "select", optionId: "deny-once" },
      { decisionSource: "planweave-desktop", reason: null }
    );
  });
});
