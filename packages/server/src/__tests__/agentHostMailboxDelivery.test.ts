import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  exampleExecuteDeliveryV1,
  canonicalizeExecutionEnvelope,
  parseExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { startPlanweaveServer } from "../lifecycle.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { attachAgentHostWebSocketServer } from "../wsServer.js";
import { serverEventSchema, type ServerEvent } from "../protocol.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { exactHostRuntimeRouteFixture } from "./support/exactHostRuntimeRoute.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-mailbox-window-"));
  const database = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  const coordination = createRemoteBlockCoordination(
    database.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: exactHostRuntimeRouteFixture(new RemoteRuntimePortRegistry()),
      inputArtifacts: { materialize: async () => {} },
      artifactContent: { readReport: async () => new Uint8Array() }
    },
    { serverInstanceOwnerToken: database.serverInstanceOwnerToken }
  );
  const host = coordination.hosts.register("Mailbox Host");
  const other = coordination.hosts.register("Other Host");
  const http = createServer();
  const transport = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    heartbeatIntervalMs: 30_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("test_port_missing");
  const sockets: WebSocket[] = [];
  const connect = async (lastAcknowledgedSequence = 0) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/agent-hosts/${host.host.id}/connect`,
      {
        headers: { Authorization: `Bearer ${host.token}` }
      }
    );
    sockets.push(socket);
    const events: ServerEvent[] = [];
    socket.on("message", (data) =>
      events.push(serverEventSchema.parse(JSON.parse(data.toString())))
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        supportedExecutionEnvelopeVersions: [1, 2],
        lastAcknowledgedSequence,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await expect.poll(() => events.some((event) => event.type === "host.welcome")).toBe(true);
    return {
      socket,
      events,
      deliveries: () => events.filter((event) => event.type === "mailbox.message"),
      ack(sequence: number) {
        const messageId = `ack-${sequence}`;
        socket.send(
          JSON.stringify({ type: "mailbox.ack", protocolVersion: 1, messageId, sequence })
        );
        return expect
          .poll(() =>
            events.some((event) => event.type === "host.event_ack" && event.messageId === messageId)
          )
          .toBe(true);
      },
      async heartbeat(messageId: string) {
        socket.send(
          JSON.stringify({
            type: "host.heartbeat",
            protocolVersion: 1,
            messageId,
            activeLeases: []
          })
        );
        await expect
          .poll(() =>
            events.some((event) => event.type === "host.event_ack" && event.messageId === messageId)
          )
          .toBe(true);
      }
    };
  };
  return {
    ...coordination,
    database,
    hostId: host.host.id,
    otherHostId: other.host.id,
    connect,
    append(hostId = host.host.id) {
      const message = coordination.mailbox.enqueue(hostId, exampleExecuteDeliveryV1.command);
      coordination.mailbox.publish(message);
      return message;
    },
    async dispose() {
      for (const socket of sockets) socket.terminate();
      await transport.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

describe("bounded Agent Host mailbox delivery", () => {
  it("pages durable history without changing full-history callers, including global sequence gaps", async () => {
    const fixture = await setup();
    try {
      for (let i = 0; i < 140; i++) {
        fixture.append();
        fixture.append(fixture.otherHostId);
      }
      const first = fixture.mailbox.listPageAfter(fixture.hostId, 0, 3);
      expect(first.map((message) => message.sequence)).toEqual([1, 3, 5]);
      expect(first.map((message) => message.previousSequence)).toEqual([0, 1, 3]);
      expect(
        fixture.mailbox.listPageAfter(fixture.hostId, 5, 2).map((message) => message.sequence)
      ).toEqual([7, 9]);
      expect(fixture.mailbox.listAfter(fixture.hostId, 0)).toHaveLength(140);
      expect(() => fixture.mailbox.listPageAfter(fixture.hostId, 0, 0)).toThrow(
        "mailbox_page_limit_invalid"
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("holds 160 history plus live messages behind ACK while heartbeat remains responsive and takeover replays", async () => {
    const fixture = await setup();
    try {
      for (let i = 0; i < 160; i++) {
        fixture.append();
        fixture.append(fixture.otherHostId);
      }
      const readSizes: number[] = [];
      const prepare = fixture.database.database.prepare.bind(fixture.database.database);
      const observer = vi.spyOn(fixture.database.database, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        return {
          ...statement,
          run: (...values) => statement.run(...values),
          get: (...values) => statement.get(...values),
          all: (...values) => {
            const rows = statement.all(...values);
            if (rows.some((row) => "command_json" in row)) readSizes.push(rows.length);
            return rows;
          }
        };
      });
      const client = await fixture.connect();
      await expect.poll(() => client.deliveries().length).toBe(32);
      fixture.append();
      await client.heartbeat("saturated-heartbeat");
      expect(client.deliveries()).toHaveLength(32);
      expect(fixture.hosts.getRequired(fixture.hostId).lastAcknowledgedSequence).toBe(0);
      const first = client.deliveries()[0]!;
      await client.ack(first.sequence);
      await expect.poll(() => client.deliveries().length).toBe(33);
      expect(fixture.hosts.getRequired(fixture.hostId).lastAcknowledgedSequence).toBe(1);
      const oldCount = client.deliveries().length;
      const replacement = await fixture.connect(1);
      await expect.poll(() => replacement.deliveries().length).toBe(32);
      expect(replacement.deliveries()[0]!.sequence).toBe(3);
      await replacement.heartbeat("replacement-saturated");
      expect(client.deliveries()).toHaveLength(oldCount);
      let index = 0;
      while (index < 160) {
        await expect.poll(() => replacement.deliveries().length).toBeGreaterThan(index);
        const message = replacement.deliveries()[index]!;
        expect(message.previousSequence).toBe(
          index === 0 ? 1 : replacement.deliveries()[index - 1]!.sequence
        );
        await replacement.ack(message.sequence);
        index++;
      }
      expect(replacement.deliveries()).toHaveLength(160);
      expect(Math.max(...readSizes)).toBe(1);
      observer.mockRestore();
      expect(fixture.hosts.getRequired(fixture.hostId).lastAcknowledgedSequence).toBe(321);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it.each([
    70 * 1024,
    170 * 1024
  ])("bounds serialized bytes and makes progress with a %i byte prompt", async (size) => {
    const fixture = await setup();
    try {
      const command = exampleExecuteDeliveryV1.command;
      if (command.type !== "execute_block") throw new Error("test_execute_command_expected");
      const envelope = parseExecutionEnvelope({
        ...command.envelope,
        renderedPrompt: "x".repeat(size)
      });
      const envelopeDigest = `envelope:sha256:${createHash("sha256").update(canonicalizeExecutionEnvelope(envelope)).digest("hex")}`;
      for (let i = 0; i < 4; i++)
        fixture.mailbox.enqueue(fixture.hostId, { ...command, envelope, envelopeDigest });
      const client = await fixture.connect();
      await expect.poll(() => client.deliveries().length).toBe(1);
      await client.heartbeat("byte-window-heartbeat");
      expect(client.deliveries()).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(client.deliveries()[0]))).toBeGreaterThan(size);
      for (let i = 0; i < 4; i++) {
        await expect.poll(() => client.deliveries().length).toBe(i + 1);
        await client.ack(client.deliveries()[i]!.sequence);
      }
      expect(fixture.hosts.getRequired(fixture.hostId).lastAcknowledgedSequence).toBe(4);
    } finally {
      await fixture.dispose();
    }
  });
});
