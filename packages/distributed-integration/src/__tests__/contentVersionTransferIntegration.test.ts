import { EventEmitter } from "node:events";
import { createServer, get, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasRuntimeContentTransfer } from "@planweave-ai/agent-host";
import { streamContentVersion } from "../../../server/src/canvas/contentVersionTransferHttp.js";
import type { SqliteDatabase } from "../../../server/src/sqlite.js";
import {
  transferContent,
  transferFixture,
  transferScope
} from "./support/contentVersionTransferFixture.js";

const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const database of databases.splice(0)) database.close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(taskCount: number, prompt?: (index: number) => string) {
  const result = await transferFixture(transferContent(taskCount, prompt));
  databases.push(result.database);
  return result;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_address");
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("content transfer batch integration", () => {
  it.each([
    "small",
    "mixed"
  ] as const)("round trips %s content through real HTTP and the Host consumer", async (kind) => {
    const current = await fixture(
      kind === "small" ? 499 : 32,
      kind === "small"
        ? undefined
        : (index) => (index === 0 ? "中".repeat(400_000) : index < 7 ? "x".repeat(300_000) : "")
    );
    const errors: unknown[] = [];
    const server = createServer((_request, response) => {
      void streamContentVersion(
        response,
        current.repository,
        transferScope,
        current.original.completed
      ).catch((error) => {
        errors.push(error);
        response.destroy(error);
      });
    });
    const baseUrl = await listen(server);
    const consumer = new CanvasRuntimeContentTransfer({
      baseUrl,
      hostId: "host",
      token: "test-token"
    });
    const downloaded = await consumer.fetch(
      transferScope,
      {
        revision: 1,
        content: current.original.completed,
        graphFingerprint: `pkg-${"a".repeat(64)}`
      },
      new AbortController().signal
    );
    expect(downloaded).toEqual(current.original);
    expect(errors).toEqual([]);
    expect(current.stats.transactions).toBe(0);
    if (kind === "small") expect(current.stats.queries).toBe(38);
    expect(
      current.stats.batches.every(
        (batch) => batch.count <= 64 && (batch.bytes <= 1_048_576 || batch.count === 1)
      )
    ).toBe(true);
    const halfway = current.stats.batches.length / 2;
    expect(current.stats.batches.slice(0, halfway)).toEqual(current.stats.batches.slice(halfway));
  });

  it.each([
    "drain",
    "close",
    "error",
    "throw"
  ] as const)("does not read the next SQLite batch while write is blocked (%s)", async (outcome) => {
    const current = await fixture(64);
    const paused = deferred();
    class ControlledResponse extends EventEmitter {
      writes = 0;
      ended = false;
      destroyed = false;
      writeHead() {}
      write() {
        this.writes++;
        if (this.writes === 65) {
          paused.resolve();
          if (outcome === "throw") throw new Error("write_failed");
          return false;
        }
        return true;
      }
      end() {
        this.ended = true;
      }
    }
    const response = new ControlledResponse();
    const pending = streamContentVersion(
      response,
      current.repository,
      transferScope,
      current.original.completed
    );
    // Attach before triggering failures to avoid an unhandled rejection.
    const settled = pending.then(
      () => null,
      (error: unknown) => error
    );
    await paused.promise;
    await delay(5);
    const before = current.stats.batches.length;
    expect(before).toBe(4); // Three preflight batches, then one transmission batch.
    expect(response.writes).toBe(65); // Header and exactly 64 members.
    expect(current.stats.transactions).toBe(0);
    if (outcome === "drain") response.emit("drain");
    if (outcome === "close") {
      response.destroyed = true;
      response.emit("close");
    }
    if (outcome === "error") response.emit("error", new Error("write_failed"));
    const error = await settled;
    if (outcome === "drain") {
      expect(error).toBeNull();
      expect(response.ended).toBe(true);
      expect(current.stats.batches.length).toBe(6);
    } else {
      expect(error).toBeInstanceOf(Error);
      expect(response.ended).toBe(false);
      expect(current.stats.batches.length).toBe(before);
    }
    expect(
      response.listenerCount("drain") +
        response.listenerCount("close") +
        response.listenerCount("error")
    ).toBe(0);
  });

  it("stops batch reads when a real slow client disconnects during backpressure", async () => {
    const current = await fixture(40, () => "x".repeat(300_000));
    const blocked = deferred();
    const finished = deferred();
    let failed: unknown;
    let writes = 0;
    let blockedAt = 0;
    let streamingQueries = 0;
    const server = createServer((_request, response) => {
      const adapter = {
        writeHead: (status: number, headers: Record<string, string>) => {
          response.writeHead(status, headers);
        },
        write(chunk: Uint8Array) {
          writes++;
          const accepted = response.write(chunk);
          if (!accepted) {
            blockedAt = current.stats.batches.length;
            streamingQueries = current.stats.queries;
            setImmediate(() => {
              if (response.writableNeedDrain) blocked.resolve();
            });
          }
          return accepted;
        },
        end: () => {
          response.end();
        },
        get destroyed() {
          return response.destroyed;
        },
        once: response.once.bind(response),
        off: response.off.bind(response)
      };
      void streamContentVersion(
        adapter,
        current.repository,
        transferScope,
        current.original.completed
      )
        .catch((error) => {
          failed = error;
          response.destroy(error);
        })
        .finally(finished.resolve);
    });
    const baseUrl = await listen(server);
    const request = get(baseUrl);
    request.on("error", () => {});
    const incoming = await new Promise<import("node:http").IncomingMessage>((resolve) =>
      request.once("response", resolve)
    );
    incoming.pause();
    await blocked.promise;
    await delay(20);
    const stableBatches = current.stats.batches.length;
    const stableQueries = current.stats.queries;
    expect(stableBatches).toBe(blockedAt);
    expect(stableQueries).toBe(streamingQueries);
    expect(writes).toBeLessThan(current.original.content.members.length + 2);
    incoming.destroy();
    await finished.promise;
    expect(failed).toBeInstanceOf(Error);
    expect(current.stats.batches.length).toBe(stableBatches);
    expect(current.stats.transactions).toBe(0);
  });

  it("propagates Host cancellation to the real HTTP response and stops database reads", async () => {
    const current = await fixture(40, () => "x".repeat(300_000));
    const controller = new AbortController();
    const finished = deferred();
    let failure: unknown;
    let destroyed = false;
    const server = createServer((_request, response) => {
      void streamContentVersion(
        response,
        current.repository,
        transferScope,
        current.original.completed
      )
        .catch((error) => {
          failure = error;
          response.destroy(error);
        })
        .finally(() => {
          destroyed = response.destroyed;
          finished.resolve();
        });
    });
    const baseUrl = await listen(server);
    const request: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      setTimeout(() => controller.abort(), 0);
      return response;
    };
    const consumer = new CanvasRuntimeContentTransfer({
      baseUrl,
      hostId: "host",
      token: "test-token",
      request
    });
    await expect(
      consumer.fetch(
        transferScope,
        {
          revision: 1,
          content: current.original.completed,
          graphFingerprint: `pkg-${"a".repeat(64)}`
        },
        controller.signal
      )
    ).rejects.toThrow();
    await finished.promise;
    expect(failure).toBeInstanceOf(Error);
    expect(destroyed).toBe(true);
    const queryCount = current.stats.queries;
    await delay(5);
    expect(current.stats.queries).toBe(queryCount);
    expect(current.stats.transactions).toBe(0);
  });
});
