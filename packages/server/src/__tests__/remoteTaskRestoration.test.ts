import { describe, expect, it } from "vitest";
import { ACP_TASK_RESTORE_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { readState } from "../../../runtime/src/state.js";
import { setup, completeDispatchToTerminal } from "./support/remoteBlockCoordinatorFixture.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";

describe("explicit remote task restoration", () => {
  it("issues a fresh lease in the original session and completes through validated result writeback", async () => {
    const f = await setup(true);
    if (!f.host) throw new Error("test_host_missing");
    const host = f.hosts.get(f.host.id)!;
    f.hosts.reportOnline(
      host.id,
      [...host.capabilities, ACP_TASK_RESTORE_CAPABILITY],
      1,
      host.readinessObservation!
    );
    const first = await f.coordinator.dispatch(
      endpointDispatchRequest({
        ...f,
        locator: f.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "first-task-run"
      })
    );
    const previous = f.dispatches.getRequired(first.operation.dispatchId);
    f.dispatches.accept(
      host.id,
      "accept-first",
      previous.id,
      previous.leaseId,
      previous.executionAttemptId
    );
    await f.dispatches.fail(
      host.id,
      "stop-first",
      previous.id,
      previous.leaseId,
      previous.executionAttemptId,
      { code: "execution_cancelled", message: "Stopped by user.", retryable: false }
    );
    const stopped = f.operations.getRequired(first.operation.id);
    expect(stopped.state).toBe("cancelled");
    const restoration = {
      operationId: stopped.id,
      executionAttemptId: stopped.executionAttemptId,
      sessionId: "original-session",
      hostId: host.id
    };
    const restored = await f.coordinator.restoreTask(
      stopped,
      f.callerHumanPrincipalId,
      restoration
    );
    expect(restored.operation.id).not.toBe(stopped.id);
    expect(restored.operation.executionAttemptId).not.toBe(stopped.executionAttemptId);
    const dispatch = f.dispatches.getRequired(restored.operation.dispatchId);
    expect(dispatch.leaseId).not.toBe(previous.leaseId);
    const command = f.mailbox
      .listAfter(host.id, 0)
      .map((item) => item.command)
      .find((item) => item.type === "execute_block" && item.dispatchId === dispatch.id);
    expect(command?.type).toBe("execute_block");
    if (command?.type !== "execute_block") throw new Error("test_command_missing");
    expect(command.envelope.restoration).toEqual(restoration);
    expect(command.envelope.renderedPrompt).toContain("Resume task execution");
    expect(command.envelope.renderedPrompt).toContain("do not repeat completed side effects");
    const replay = await f.coordinator.restoreTask(stopped, f.callerHumanPrincipalId, restoration);
    expect(replay.operation.id).toBe(restored.operation.id);
    await completeDispatchToTerminal({ ...f, host: f.host }, restored);
    expect(f.operations.getRequired(restored.operation.id).state).toBe("completed");
    expect(f.operations.getRequired(stopped.id).state).toBe("cancelled");
    const state = await readState(f.workspace.init.workspace.stateFile);
    expect(state.blocks["T-001#B-001"].status).toBe("completed");
    expect(state.blocks["T-001#B-001"].remoteOperationReceipt?.operationId).toBe(
      restored.operation.id
    );
  });
});
