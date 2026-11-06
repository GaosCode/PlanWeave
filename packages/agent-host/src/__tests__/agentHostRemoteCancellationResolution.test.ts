import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentHostProtocolVersion,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { openAgentHostRemoteExecutionOutbox } from "../state/remoteExecutionOutbox.js";
import { leaseDelivery, leaseHarness } from "./support/agentHostLeaseExpiryHarness.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("Host cancellation through delayed Remote ACP resolution", () => {
  it("consumes resolver delay from the Host-origin budget without starting another process", async () => {
    const harness = await leaseHarness({ abortSettles: false });
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-cancel-resolution-"));
    const outbox = await openAgentHostRemoteExecutionOutbox(join(directory, "remote.sqlite"));
    const resolver = barrier();
    const terminal = barrier();
    const lifecyclePath = join(directory, "lifecycle.log");
    let resolving = false;
    let terminalPersisted = false;
    const source = leaseDelivery(60_000);
    if (source.type !== "mailbox.message" || source.command.type !== "execute_block") {
      throw new Error("expected_execute_delivery");
    }
    const envelope = executionEnvelopeSchema.parse({
      ...source.command.envelope,
      inputArtifacts: [],
      session: {}
    });
    const delivery = {
      ...source,
      command: {
        ...source.command,
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      }
    };
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: directory }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: directory }) },
      profileResolver: {
        async resolve() {
          resolving = true;
          await resolver.promise;
          return {
            agentId: envelope.agentId,
            capabilityPolicy: { required: [], optional: [] },
            launch: {
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL(
                    "../../../runtime/src/__tests__/support/acpCancellationAgent.mjs",
                    import.meta.url
                  )
                ),
                lifecyclePath,
                "ignored"
              ]
            },
            env: {},
            shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 }
          };
        }
      },
      outbox: {
        async append(record) {
          await outbox.append(record);
          if (record.kind === "engine_event" && record.event.kind === "terminal") {
            terminalPersisted = true;
            await terminal.promise;
          }
        }
      },
      hostCapabilities: envelope.requiredCapabilities
    });
    harness.execute.mockImplementation((command, context) => executor.execute(command, context));
    try {
      harness.send(delivery);
      await vi.waitFor(() => expect(resolving).toBe(true));
      harness.send(
        serverEventSchema.parse({
          type: "mailbox.message",
          protocolVersion: agentHostProtocolVersion,
          sequence: 2,
          previousSequence: 1,
          messageId: "cancel-during-remote-profile-resolution",
          command: {
            type: "cancel_execution",
            protocolVersion: agentHostProtocolVersion,
            dispatchId: delivery.command.dispatchId,
            leaseId: delivery.command.leaseId,
            executionAttemptId: delivery.command.executionAttemptId,
            reason: "cancel during resolution"
          }
        })
      );
      await vi.waitFor(() =>
        expect(harness.state.executionEvidence(1)?.cancellationIntent).toBeTruthy()
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      resolver.release();
      await vi.waitFor(() => expect(terminalPersisted).toBe(true));
      harness.clock.advanceBy(300);
      expect(harness.client.status().state).toBe("connected");
      harness.clock.advanceBy(400);
      expect(harness.client.status()).toMatchObject({
        state: "reconciliation-required",
        reason: "execution_cleanup_timeout"
      });
      await expect(readFile(lifecyclePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      terminal.release();
      await vi.waitFor(() => expect(harness.state.executionEvidence(1)?.status).toBe("cancelled"));
      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(harness.state.pendingEvents()).toContainEqual(
        expect.objectContaining({
          type: "dispatch.failed",
          dispatchId: delivery.command.dispatchId,
          leaseId: delivery.command.leaseId,
          executionAttemptId: delivery.command.executionAttemptId,
          failure: expect.objectContaining({ code: "execution_cancelled" })
        })
      );
    } finally {
      resolver.release();
      terminal.release();
      await harness.close();
      outbox.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
