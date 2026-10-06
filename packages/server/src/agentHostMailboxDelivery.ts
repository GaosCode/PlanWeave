import { WebSocket } from "ws";
import { agentHostProtocolVersion, serverEventSchema } from "./protocol.js";
import type { DurableMailbox, MailboxMessage } from "./mailbox.js";

// Leave room below the Host's 128 messages / 512 KiB limits for control traffic.
const maxInflightMessages = 32;
const maxInflightBytes = 128 * 1024;
const maxBufferedBytes = 128 * 1024;
const bufferRetryMs = 25;

function serializeMessage(
  message: MailboxMessage,
  mailbox: DurableMailbox,
  historicalPermissionReplayVersion: 1 | undefined
): string {
  const envelope = {
    protocolVersion: agentHostProtocolVersion,
    sequence: message.sequence,
    previousSequence: message.previousSequence,
    messageId: message.messageId
  };
  if (
    message.command.type === "interaction.permission_response" &&
    message.command.decision === "allow_once"
  ) {
    if (historicalPermissionReplayVersion !== 1)
      throw new Error("historical_permission_replay_unsupported");
    return JSON.stringify(
      serverEventSchema.parse({
        ...envelope,
        type: "mailbox.permission_history",
        commandJson: mailbox.historicalPermissionCommandJson(message.messageId)
      })
    );
  }
  return JSON.stringify(
    serverEventSchema.parse({
      ...envelope,
      type: "mailbox.message",
      command: message.command
    })
  );
}

export function createAgentHostMailboxDelivery(input: {
  socket: WebSocket;
  hostId: string;
  mailbox: DurableMailbox;
  lastAcknowledgedSequence: number;
  historicalPermissionReplayVersion: 1 | undefined;
  isActive(): boolean;
  onError(error: unknown): void;
}) {
  let sentSequence = input.lastAcknowledgedSequence;
  let confirmedSequence = input.lastAcknowledgedSequence;
  const inflight = new Map<number, number>();
  let inflightBytes = 0;
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const active = () => !stopped && input.isActive() && input.socket.readyState === WebSocket.OPEN;
  const stop = () => {
    stopped = true;
    if (scheduled) clearImmediate(scheduled);
    if (retry) clearTimeout(retry);
    scheduled = undefined;
    retry = undefined;
    unsubscribe();
    inflight.clear();
    inflightBytes = 0;
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    input.onError(error);
  };
  const wake = () => {
    if (!active() || scheduled || retry) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      try {
        pump();
      } catch (error) {
        fail(error);
      }
    });
  };
  const retryBuffer = () => {
    if (retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      wake();
    }, bufferRetryMs);
  };
  const pump = () => {
    if (!active() || inflight.size >= maxInflightMessages || inflightBytes >= maxInflightBytes)
      return;
    if (input.socket.bufferedAmount >= maxBufferedBytes) {
      retryBuffer();
      return;
    }
    // One-row SQL pages bound retained payloads independently of command size.
    const message = input.mailbox.listPageAfter(input.hostId, sentSequence, 1)[0];
    if (!message) return;
    const serialized = serializeMessage(
      message,
      input.mailbox,
      input.historicalPermissionReplayVersion
    );
    const bytes = Buffer.byteLength(serialized);
    // A single legal large frame can use the window alone; it never waits on itself.
    if (inflight.size > 0 && inflightBytes + bytes > maxInflightBytes) return;
    if (input.socket.bufferedAmount > 0 && input.socket.bufferedAmount + bytes > maxBufferedBytes) {
      retryBuffer();
      return;
    }
    input.socket.send(serialized, (error) => {
      if (error) fail(error);
    });
    sentSequence = message.sequence;
    inflight.set(message.sequence, bytes);
    inflightBytes += bytes;
    wake();
  };
  const unsubscribe = input.mailbox.subscribe(input.hostId, wake);
  return {
    wake,
    stop,
    confirm(sequence: number) {
      if (!active()) return;
      if (sequence <= confirmedSequence) return;
      confirmedSequence = sequence;
      // A reopened Host can ACK its durable outbox before this session replays it.
      sentSequence = Math.max(sentSequence, confirmedSequence);
      for (const [sent, bytes] of inflight) {
        if (sent <= confirmedSequence) {
          inflight.delete(sent);
          inflightBytes -= bytes;
        }
      }
      wake();
    }
  };
}
