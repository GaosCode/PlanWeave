import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acpConversationEventSchema, hostEventSchema } from "@planweave-ai/agent-host-protocol";
import { openAgentHostState } from "../../../agent-host/src/state/agentHostState.js";
import { createAcpConversationFixture } from "../../../server/src/__tests__/support/acpConversationFixture.js";
import {
  projectAcpConversation,
  projectAcpTimeline
} from "../../../runtime/src/autoRun/acpConversationProjection.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([
  "output",
  "terminal_output",
  "message"
] as const)("delivers lossless %s chunks from the Host through Server replay into Runtime projection", async (kind) => {
  const f = await createAcpConversationFixture();
  cleanups.push(() => rm(f.directory, { recursive: true, force: true }));
  cleanups.push(() => f.server.close());
  f.service.act(f.operation, "actor", f.prompt);
  const command = f.mailbox
    .listAfter(f.host.id, 0)
    .slice()
    .reverse()
    .find((message) => message.command.type === "acp_conversation.prompt")?.command;
  if (command?.type !== "acp_conversation.prompt") throw new Error("expected_prompt");
  const path = join(f.directory, "chunk-host.sqlite");
  let host = await openAgentHostState(path);
  cleanups.push(() => host.close());
  host.setHostEventMaxPayloadBytes(64 * 1024);
  host.conversations.accept(command);
  const body =
    kind === "message"
      ? {
          kind,
          role: "assistant" as const,
          messageId: "original-message",
          chunk: true,
          content: "",
          redaction: { classes: [], replaced: 0 }
        }
      : kind === "terminal_output"
        ? {
            kind,
            terminalId: "original-terminal",
            content: "",
            redaction: { classes: [], replaced: 0 }
          }
        : { kind, stream: "stdout" as const, content: "", redaction: { classes: [], replaced: 0 } };
  const probe = {
    type: "acp_conversation.event" as const,
    protocolVersion: 1 as const,
    operationId: command.operationId,
    turnId: command.turnId,
    executionAttemptId: command.executionAttemptId,
    sessionId: command.sessionId,
    messageId: "00000000-0000-0000-0000-000000000000",
    sequence: 1,
    timestamp: "2030-01-01T00:00:00.000Z",
    payload: { kind: "runner" as const, fragment: { kind: "runner_body" as const, body } }
  };
  const prefix = '\u0000😀"\\\n';
  const content =
    prefix +
    "a".repeat(
      64 * 1024 -
        Buffer.byteLength(JSON.stringify(probe)) -
        Buffer.byteLength(JSON.stringify(prefix)) +
        1
    ) +
    "xtoken=value";
  body.content = content;
  expect(acpConversationEventSchema.safeParse(probe).success).toBe(true);
  host.conversations.append(command.turnId, probe.payload);
  const original = host.pendingEvents();
  expect(original.length).toBeGreaterThan(1);
  for (const event of original) {
    expect(hostEventSchema.safeParse(event).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(64 * 1024);
  }
  f.service.ingest(f.host.id, original[0]);
  host.acknowledgeEvent(original[0]!.messageId);
  const remaining = host.pendingEvents();
  host.close();
  host = await openAgentHostState(path);
  expect(host.pendingEvents()).toEqual(remaining);
  for (const event of host.pendingEvents()) {
    f.service.ingest(f.host.id, event);
    f.service.ingest(f.host.id, event);
    host.acknowledgeEvent(event.messageId);
  }
  expect(host.pendingEvents()).toEqual([]);
  const persisted = f.service.page(f.operation, "actor").events;
  expect(persisted).toEqual(original);
  const projected = persisted.flatMap((event) =>
    event.payload.kind === "runner" && event.payload.fragment.kind === "runner_body"
      ? [
          {
            sequence: event.sequence,
            timestamp: event.timestamp,
            body: event.payload.fragment.body
          }
        ]
      : []
  );
  expect(
    projectAcpConversation(projected)
      .map((item) => item.content)
      .join("")
  ).toBe(content);
  expect(
    projectAcpTimeline(projected)
      .map((item) => ("content" in item ? item.content : ""))
      .join("")
  ).toBe(content);
});
