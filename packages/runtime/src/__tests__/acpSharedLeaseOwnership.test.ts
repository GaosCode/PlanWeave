import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import type { AcpConnectionLease, AcpLeaseTerminal } from "../autoRun/acpConnectionProvider.js";

const fixture = fileURLToPath(new URL("./support/acpSharedContinuationAgent.mjs", import.meta.url));

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "acp-shared-owner-"));
  const provider = createSharedAcpConnectionProvider({ idleMs: 20 });
  const leases: AcpConnectionLease[] = [];
  const inbound: unknown[] = [];
  async function acquire() {
    const lease = await provider.acquire({
      launch: { trusted: true, command: process.execPath, args: [fixture, directory] },
      cwd: directory,
      env: {},
      clientInfo: { name: "owner-contract", version: "1" },
      shutdown: { eofDrainMs: 50, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
      defaultTimeoutMs: 3000,
      observer: {
        redact: (payload) => payload,
        observe: ({ direction, payload }) => {
          if (direction === "agent_to_client") inbound.push(payload);
        }
      },
      poolIdentity: {
        projectRoot: directory,
        profileFingerprint: "owner-contract",
        host: { kind: "native" }
      }
    });
    leases.push(lease);
    await lease.initialize();
    return lease;
  }
  return {
    directory,
    acquire,
    inbound,
    async cleanup() {
      await Promise.all(
        leases.map((lease) =>
          lease.release({ terminal: "failed", cleanupDeadline: createAcpCleanupDeadline(1000) })
        )
      );
      await provider.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const release = (lease: AcpConnectionLease, terminal: AcpLeaseTerminal = "succeeded") =>
  lease.release({
    terminal,
    cleanupDeadline: createAcpCleanupDeadline(1000)
  });

describe("shared ACP lease owner lifetime", () => {
  it.each([
    "succeeded",
    "cancelled",
    "failed"
  ] as const)("releases the actual owner after %s without disturbing sibling operations or old handlers", async (terminal) => {
    const h = await harness();
    const sibling = await h.acquire();
    const siblingEvents: string[] = [];
    const b = await sibling.openSession(
      { kind: "new" },
      {
        ownerId: "sibling",
        handlers: {
          onSessionUpdate: (event) => {
            siblingEvents.push(JSON.stringify(event));
          }
        }
      }
    );
    const pending = b.prompt([{ type: "text", text: "hold" }]);
    let siblingSettled = false;
    const pendingResult = pending.then(
      (response) => {
        siblingSettled = true;
        return response;
      },
      (error: unknown) => {
        siblingSettled = true;
        return error;
      }
    );
    try {
      await vi.waitFor(async () =>
        expect(await readFile(join(h.directory, "protocol.log"), "utf8")).toContain(
          `session/prompt:${b.sessionId}`
        )
      );
      const first = await h.acquire();
      const oldEvents: string[] = [];
      const a = await first.openSession(
        { kind: "new" },
        {
          ownerId: "continuation",
          handlers: {
            onSessionUpdate: (event) => {
              oldEvents.push(JSON.stringify(event));
            }
          }
        }
      );
      if (terminal === "failed")
        await expect(a.prompt([{ type: "text", text: "fail" }])).rejects.toThrow(
          "fixture prompt failure"
        );
      else if (terminal === "cancelled") {
        const prompting = a.prompt([{ type: "text", text: "hold" }]);
        await vi.waitFor(async () =>
          expect(await readFile(join(h.directory, "protocol.log"), "utf8")).toContain(
            `session/prompt:${a.sessionId}`
          )
        );
        await a.cancel();
        await expect(prompting).resolves.toMatchObject({ stopReason: "cancelled" });
      } else await a.prompt([{ type: "text", text: "first" }]);
      const oldCount = oldEvents.length;
      expect(await release(first, terminal)).toMatchObject({ disposed: false, failures: [] });
      const next = await h.acquire();
      const newEvents: string[] = [];
      const nextSession = await next.openSession(
        { kind: "new" },
        {
          ownerId: "continuation",
          handlers: {
            onSessionUpdate: (event) => {
              newEvents.push(JSON.stringify(event));
            }
          }
        }
      );
      await release(first, terminal);
      const lateText = `late-old-owner:${randomUUID()}`;
      await b.setMode(`late:${JSON.stringify({ sessionId: a.sessionId, text: lateText })}`);
      const lateMessage = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: a.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: lateText }
          }
        }
      };
      expect(h.inbound).toContainEqual(lateMessage);
      const sent = (await readFile(join(h.directory, "wire.log"), "utf8")).trim().split("\n");
      expect(sent).toContain(JSON.stringify(lateMessage));
      await nextSession.setMode("fresh-round");
      await b.setMode("sibling-still-routed");
      expect(oldEvents).toHaveLength(oldCount);
      expect(JSON.stringify(newEvents)).toContain("fresh-round");
      expect(JSON.stringify(newEvents)).not.toContain(lateText);
      expect(JSON.stringify(oldEvents)).not.toContain(lateText);
      expect(siblingSettled).toBe(false);
      expect(JSON.stringify(siblingEvents)).toContain("sibling-still-routed");
      expect(next.processId).toBe(sibling.processId);
      expect(sibling.pendingOperationCount).toBeGreaterThan(0);
      await release(next);
      await writeFile(join(h.directory, "finish"), "");
      await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await sibling.cancel({ sessionId: b.sessionId });
      await pendingResult;
      await h.cleanup();
    }
  });

  it("does not let a rejected same-name lease release another lease's binding", async () => {
    const h = await harness();
    try {
      const first = await h.acquire();
      const second = await h.acquire();
      if (!("leaseId" in second) || typeof second.leaseId !== "string")
        throw new Error("shared lease identity missing");
      const secondLeaseId = second.leaseId;
      const received: string[] = [];
      const session = await first.openSession(
        { kind: "new" },
        {
          ownerId: secondLeaseId,
          handlers: {
            onSessionUpdate: (event) => {
              received.push(JSON.stringify(event));
            }
          }
        }
      );
      await expect(second.openSession({ kind: "new" }, { ownerId: secondLeaseId })).rejects.toThrow(
        "already opening or bound"
      );
      await release(second);
      await session.setMode("still-owned");
      expect(JSON.stringify(received)).toContain("still-owned");
    } finally {
      await h.cleanup();
    }
  });

  it.each([
    "fail-open",
    "flush-fail"
  ])("rolls back %s so a new lease can own the same name", async (sessionId) => {
    const h = await harness();
    try {
      const sibling = await h.acquire();
      await sibling.openSession({ kind: "new" });
      const first = await h.acquire();
      await expect(
        first.openSession(
          { kind: "load", sessionId },
          {
            ownerId: "retry-owner",
            handlers: {
              onSessionUpdate: () => {
                throw new Error("fixture handler failure");
              }
            }
          }
        )
      ).rejects.toThrow(
        sessionId === "fail-open" ? "fixture load failure" : "fixture handler failure"
      );
      await release(first, "failed");
      const next = await h.acquire();
      await expect(
        next.openSession({ kind: "new" }, { ownerId: "retry-owner" })
      ).resolves.toHaveProperty("sessionId");
    } finally {
      await h.cleanup();
    }
  });

  it("prevents an opening lease from binding after release and preserves a replacement owner", async () => {
    const h = await harness();
    try {
      const sibling = await h.acquire();
      await sibling.openSession({ kind: "new" });
      const first = await h.acquire();
      await writeFile(join(h.directory, "pause-open"), "");
      const opening = first.openSession(
        { kind: "load", sessionId: "slow-open" },
        { ownerId: "opening-owner" }
      );
      const outcome = opening.catch((error: unknown) => error);
      await vi.waitFor(async () =>
        expect(await readFile(join(h.directory, "protocol.log"), "utf8")).toContain(
          "session/load:slow-open"
        )
      );
      await release(first);
      await unlink(join(h.directory, "pause-open"));
      expect(await outcome).toBeInstanceOf(Error);
      const next = await h.acquire();
      const received: string[] = [];
      const session = await next.openSession(
        { kind: "new" },
        {
          ownerId: "opening-owner",
          handlers: {
            onSessionUpdate: (event) => {
              received.push(JSON.stringify(event));
            }
          }
        }
      );
      await release(first);
      await session.setMode("new-owner");
      expect(JSON.stringify(received)).toContain("new-owner");
    } finally {
      await writeFile(join(h.directory, "finish"), "");
      await h.cleanup();
    }
  });
});
