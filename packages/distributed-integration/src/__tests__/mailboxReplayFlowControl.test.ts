import { Socket } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  cancelExecutionCommandSchema
} from "@planweave-ai/agent-host-protocol";
import type { AgentHostExecutor } from "../../../agent-host/src/execution/agentHostExecutor.js";
import {
  setup,
  cleanupHistoricalPermissionReplay,
  captureWrites,
  nextCancellation
} from "./support/historicalPermissionReplayFixture.js";

afterEach(cleanupHistoricalPermissionReplay);

function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 5_000, interval: 10 });
}

function executor() {
  return vi.fn<AgentHostExecutor["execute"]>(async (_command, context) => {
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("loopback execution cancelled");
  });
}

describe("durable mailbox flow control through the default Agent Host", () => {
  it("bounds held real ACKs, drains mixed-size backlog and replays on takeover without repeating execution", async () => {
    const fixture = await setup();
    const example = executeBlockCommandSchema.parse(exampleExecuteDelivery.command);
    const envelope = executionEnvelopeSchema.parse({
      ...example.envelope,
      execution: {
        dispatchId: fixture.request.dispatchId,
        attemptId: fixture.request.executionAttemptId
      },
      renderedPrompt: "x".repeat(170 * 1024)
    });
    const execution = fixture.mailbox.enqueue(
      fixture.host.id,
      executeBlockCommandSchema.parse({
        ...example,
        dispatchId: fixture.request.dispatchId,
        executionAttemptId: fixture.request.executionAttemptId,
        leaseId: fixture.request.leaseId,
        leaseExpiresAt: fixture.reservation.leaseExpiresAt,
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      })
    );
    const other = fixture.hosts.register("Sequence gap Host").host;
    const messages = [execution];
    for (let index = 0; index < 160; index++) {
      const command = cancelExecutionCommandSchema.parse({
        type: "cancel_execution",
        protocolVersion: 1,
        dispatchId: index === 0 ? fixture.request.dispatchId : `idle-dispatch-${index}`,
        leaseId: fixture.request.leaseId,
        executionAttemptId:
          index === 0 ? fixture.request.executionAttemptId : `idle-attempt-${index}`,
        reason: "c".repeat(index % 2 === 0 ? 256 : 2000)
      });
      fixture.mailbox.enqueue(other.id, command);
      messages.push(fixture.mailbox.enqueue(fixture.host.id, command));
    }
    let hold = true;
    const held = new Map<string, { socket: WebSocket; frame: Record<string, unknown> }>();
    const writes: Array<{ socket: WebSocket; sequence: number; bytes: number }> = [];
    const frames = captureWrites((frame, socket) => {
      if (frame.type === "mailbox.message") {
        if (typeof frame.sequence !== "number") throw new Error("test_sequence_required");
        writes.push({
          socket,
          sequence: frame.sequence,
          bytes: Buffer.byteLength(JSON.stringify(frame))
        });
      }
      if (hold && frame.type === "mailbox.ack" && frame.sequence !== execution.sequence) {
        if (typeof frame.messageId !== "string") throw new Error("test_ack_identity_required");
        held.set(frame.messageId, { socket, frame });
        return true;
      }
      return false;
    });
    const execute = executor();
    const first = await fixture.start(execute);
    const statuses: string[] = [];
    first.client.subscribe((status) =>
      statuses.push(status.state === "degraded" ? status.reason : status.state)
    );
    await waitFor(() => expect(held.size).toBe(32));
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(
      execution.sequence
    );
    expect(first.state.lastAcknowledgedSequence()).toBe(execution.sequence);
    expect(writes).toHaveLength(33);
    const live = fixture.mailbox.enqueue(fixture.host.id, {
      ...cancelExecutionCommandSchema.parse(messages[1]!.command),
      dispatchId: "idle-live",
      executionAttemptId: "idle-live-attempt"
    });
    fixture.mailbox.publish(live);
    expect(writes).toHaveLength(33);
    const originalAck = held.values().next().value;
    if (!originalAck) throw new Error("test_real_ack_required");
    held.delete(String(originalAck.frame.messageId));
    hold = false;
    originalAck.socket.send(JSON.stringify(originalAck.frame));
    hold = true;
    await waitFor(() => expect(writes).toHaveLength(34));
    await waitFor(() => expect(held.size).toBe(32));
    const firstSocket = writes[0]!.socket;
    const firstCount = writes.filter((write) => write.socket === firstSocket).length;
    hold = false;
    const second = await fixture.start(execute);
    await waitFor(() => expect(second.state.lastAcknowledgedSequence()).toBe(live.sequence));
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(live.sequence);
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(writes.filter((write) => write.socket === firstSocket)).toHaveLength(firstCount);
    expect(second.client.status().state).toBe("connected");
    expect(statuses).not.toContain("inbound_backpressure");
    const secondSocket = writes.find((write) => write.socket !== firstSocket)!.socket;
    const secondWrites = writes.filter((write) => write.socket === secondSocket);
    expect(secondWrites[0]!.sequence).toBeGreaterThan(execution.sequence + 1);
    expect(
      frames.filter(
        (frame) => frame.type === "mailbox.message" && frame.sequence === execution.sequence
      )
    ).toHaveLength(1);
    await first.stop();
    await second.stop();
    const third = await fixture.start(execute);
    const final = fixture.mailbox.enqueue(fixture.host.id, {
      ...cancelExecutionCommandSchema.parse(messages[1]!.command),
      dispatchId: "idle-final",
      executionAttemptId: "idle-final-attempt"
    });
    fixture.mailbox.publish(final);
    await waitFor(() => expect(third.state.lastAcknowledgedSequence()).toBe(final.sequence));
    expect(execute).toHaveBeenCalledOnce();
    expect(Math.max(...writes.map((write) => write.bytes))).toBeGreaterThan(170 * 1024);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "default-host-backlog",
        heldAckPeak: held.size,
        backlog: messages.length,
        finalSequence: final.sequence,
        maxFrameBytes: Math.max(...writes.map((write) => write.bytes))
      })}\n`
    );
  });

  it("rolls back an actual out-of-order ACK and recovers the persisted Host outbox in a new epoch", async () => {
    const fixture = await setup();
    const messages = Array.from({ length: 40 }, () => nextCancellation(fixture));
    let hold = true;
    const held: Array<{ socket: WebSocket; frame: Record<string, unknown> }> = [];
    captureWrites((frame, socket) => {
      if (hold && frame.type === "mailbox.ack") {
        held.push({ socket, frame });
        return true;
      }
      return false;
    });
    const first = await fixture.start();
    await waitFor(() => expect(held).toHaveLength(32));
    hold = false;
    const secondAck = held[1]!;
    secondAck.socket.send(JSON.stringify(secondAck.frame));
    await waitFor(() => expect(first.client.status().state).toBe("degraded"));
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(0);
    expect(first.state.lastAcknowledgedSequence()).toBe(0);
    expect(
      fixture.server.database
        .prepare("SELECT acknowledged_at FROM mailbox_messages WHERE sequence=?")
        .get(messages[1]!.sequence)
    ).toEqual({ acknowledged_at: null });
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM host_event_receipts WHERE message_id=?")
        .get(secondAck.frame.messageId)
    ).toEqual({ count: 0 });
    await first.stop();
    const second = await fixture.start();
    await waitFor(() =>
      expect(second.state.lastAcknowledgedSequence()).toBe(messages.at(-1)!.sequence)
    );
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(
      messages.at(-1)!.sequence
    );
    expect(second.client.status().state).toBe("connected");
  });

  it("pauses at genuine socket buffered pressure then resumes with default Host limits", async () => {
    const fixture = await setup();
    const messages = Array.from({ length: 150 }, () => nextCancellation(fixture));
    let network: Socket | undefined;
    let pressuredSocket: WebSocket | undefined;
    let pressureBytes = 0;
    let armed = false;
    const frames = captureWrites((frame, socket) => {
      if (frame.type === "host.welcome" && !armed) {
        armed = true;
        setImmediate(() => {
          const transport: unknown = Reflect.get(socket, "_socket");
          if (!(transport instanceof Socket)) throw new Error("test_real_ws_network_required");
          network = transport;
          pressuredSocket = socket;
          transport.cork();
          for (let index = 0; index < 1500; index++) socket.ping(Buffer.alloc(125));
          pressureBytes = socket.bufferedAmount;
        });
      }
      return false;
    });
    const running = await fixture.start();
    try {
      await waitFor(() => expect(pressureBytes).toBeGreaterThanOrEqual(128 * 1024));
      await waitFor(() => expect(running.client.status().state).toBe("connected"));
      // Multiple actual retry turns pass while transport remains corked.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(frames.filter((frame) => frame.type === "mailbox.message")).toHaveLength(0);
      expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(0);
      expect(running.state.lastAcknowledgedSequence()).toBe(0);
      network!.uncork();
      await waitFor(() =>
        expect(running.state.lastAcknowledgedSequence()).toBe(messages.at(-1)!.sequence)
      );
      expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(
        messages.at(-1)!.sequence
      );
      expect(running.client.status().state).toBe("connected");
      expect(pressuredSocket!.bufferedAmount).toBe(0);
      process.stdout.write(
        `${JSON.stringify({
          scenario: "real-socket-pressure",
          pressureBytes,
          finalSequence: messages.at(-1)!.sequence,
          bufferedAfterDrain: pressuredSocket!.bufferedAmount
        })}\n`
      );
    } finally {
      network?.uncork();
    }
  });
});
