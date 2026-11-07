import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnInput
} from "../autoRun/acpConversationTurn.js";
import { acpConversationTurnIdentitySchema } from "../autoRun/acpConversationTurnContract.js";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { acpSessionIdSchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { AcpSessionRouter } from "../autoRun/acpSessionRouter.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";

const fixture = fileURLToPath(new URL("./support/acpSharedContinuationAgent.mjs", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "acp-queued-open-"));
  await writeFile(join(directory, "pause-A"), "");
  const provider = createSharedAcpConnectionProvider({ idleMs: 20 });
  const coordinator = new AcpConversationTurnCoordinator(undefined, { provider });
  const stores = new Map<string, AcpEventStore>();
  async function input(
    label: string,
    text: string,
    timeoutMs = 10000
  ): Promise<AcpConversationTurnInput> {
    const runDir = join(directory, label);
    const claimRef = `T-${label}#B-001`;
    const runId = `RUN-${label}`;
    const sessionId = acpSessionIdSchema.parse(`session-${label}`);
    const store = new AcpEventStore({
      runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: "queued-open",
        canvasId: "default",
        taskId: `T-${label}`,
        blockId: "B-001",
        claimRef,
        runId,
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: runId
      }),
      runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" }
    });
    await store.open();
    await store.append(
      {
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          diagnostic: null,
          artifactValidated: true
        }
      },
      { sessionId }
    );
    await writeFile(join(runDir, "original-artifact.txt"), `artifact-${label}`);
    stores.set(label, store);
    return {
      key: runDir,
      identity: acpConversationTurnIdentitySchema.parse({
        version: "planweave.agent-prompt-turn/v1",
        ref: { projectRoot: directory, canvasId: "default" },
        recordId: `${claimRef}::${runId}`,
        executorRunId: runId,
        claimRef,
        sessionId,
        turnId: randomUUID()
      }),
      cwd: directory,
      profile: {
        profileId: "queued-open",
        agentId: "codex",
        displayName: "Queued open",
        host: { kind: "native" },
        launch: { command: process.execPath, args: [fixture, directory] },
        environment: [],
        shutdown: { eofDrainMs: 50, terminateGraceMs: 100, cleanupDeadlineMs: 500 },
        capabilities: { required: [], optional: [] },
        connection: { mode: "shared-project" },
        source: "builtin",
        fingerprint: "queued-open"
      },
      environment: { env: {}, availableNames: [] },
      text,
      timeoutMs,
      eventStore: store.completedConversationWriter(sessionId)
    };
  }
  const protocol = () => readFile(join(directory, "protocol.log"), "utf8");
  return { directory, coordinator, provider, input, protocol, stores };
}

describe("real shared session open queue", () => {
  it.each([
    "cancel",
    "timeout",
    "release"
  ] as const)("settles queued %s without unblocking the active load or sending the revoked load", async (mode) => {
    const h = await harness();
    const openings = vi.spyOn(AcpSessionRouter.prototype, "withOpening");
    const acquisitions = vi.spyOn(h.provider, "acquire");
    const a = await h.input("A", "first");
    const b = await h.input("B", "second", mode === "timeout" ? 200 : 10000);
    const c = await h.input("C", "hold");
    const originalB = h.stores.get("B")!.snapshot().events;
    let aDone = false;
    const aRun = h.coordinator.send(a).finally(() => {
      aDone = true;
    });
    const aSettled = aRun.catch((error: unknown) => error);
    let bOutcome: Awaited<ReturnType<typeof h.coordinator.send>> | Error | undefined;
    let bRun: Promise<unknown> | undefined;
    let cRun: Promise<unknown> | undefined;
    try {
      await vi.waitFor(async () => expect(await h.protocol()).toContain("session/load:session-A"));
      const pidText = (await h.protocol()).match(/spawn:(\d+)/)?.[1];
      if (!pidText) throw new Error("ACP child PID missing");
      const pid = Number(pidText);
      bRun = h.coordinator.send(b).then(
        (state) => {
          bOutcome = state;
          return state;
        },
        (error: unknown) => {
          if (!(error instanceof Error)) throw new Error("non-Error turn failure");
          bOutcome = error;
          return error;
        }
      );
      await vi.waitFor(() =>
        expect(openings.mock.calls.some(([owner]) => owner.ownerId === b.key)).toBe(true)
      );
      expect(await h.protocol()).not.toContain("session/load:session-B");
      const started = performance.now();
      if (mode === "cancel") {
        await expect(h.coordinator.cancel(b.key, b.identity)).resolves.toMatchObject({
          outcome: "cancel_requested"
        });
        const repeated = await h.coordinator.cancel(b.key, b.identity);
        expect(["already_cancelling", "already_terminal"]).toContain(repeated.outcome);
      }
      if (mode === "release") {
        const acquired = acquisitions.mock.results[1];
        if (acquired?.type !== "return") throw new Error("queued B lease was not acquired");
        const lease = await acquired.value;
        const releasing = lease.release({
          terminal: "cancelled",
          cleanupDeadline: createAcpCleanupDeadline(500)
        });
        expect(
          lease.release({ terminal: "cancelled", cleanupDeadline: createAcpCleanupDeadline(500) })
        ).toBe(releasing);
        await expect(releasing).resolves.toMatchObject({ disposed: false, failures: [] });
      }
      await vi.waitFor(() => expect(bOutcome).toBeDefined(), { timeout: 500, interval: 10 });
      expect(performance.now() - started).toBeLessThan(500);
      if (mode === "cancel")
        expect(bOutcome).toMatchObject({ terminal: "cancelled", identity: b.identity });
      else
        expect(bOutcome).toMatchObject({
          message: expect.stringContaining(
            mode === "timeout" ? "timed out" : "released during opening"
          )
        });
      expect(h.coordinator.admission(b.key)).toMatchObject({ available: true, inFlight: false });
      expect(h.coordinator.query(b.key, b.identity)).toMatchObject({
        found: true,
        state: { terminal: mode === "cancel" ? "cancelled" : "failed" }
      });
      expect(aDone).toBe(false);
      expect(alive(pid)).toBe(true);
      const beforeRelease = await h.protocol();
      expect(beforeRelease).not.toContain("session/load:session-B");
      expect(beforeRelease).not.toContain("session/cancel:session-A");
      expect(beforeRelease.match(/spawn:/g)).toHaveLength(1);
      cRun = h.coordinator.send(c).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(openings.mock.calls.some(([owner]) => owner.ownerId === c.key)).toBe(true)
      );
      await unlink(join(h.directory, "pause-A"));
      await expect(aRun).resolves.toMatchObject({ terminal: "succeeded", identity: a.identity });
      await vi.waitFor(async () =>
        expect(await h.protocol()).toContain("session/prompt:session-C")
      );
      expect(await h.protocol()).not.toContain("session/load:session-B");
      const retry = { ...b, timeoutMs: 10000, identity: { ...b.identity, turnId: randomUUID() } };
      await expect(h.coordinator.send(retry)).resolves.toMatchObject({
        terminal: "succeeded",
        identity: retry.identity
      });
      expect((await h.protocol()).match(/session\/load:session-B/g)).toHaveLength(1);
      expect((await h.protocol()).match(/spawn:/g)).toHaveLength(1);
      expect(await readFile(join(b.key, "original-artifact.txt"), "utf8")).toBe("artifact-B");
      expect(
        h.stores
          .get("B")!
          .snapshot()
          .events.filter((event) => event.body.kind === "terminal")
      ).toEqual(originalB);
      await writeFile(join(h.directory, "finish"), "");
      await expect(cRun).resolves.toMatchObject({ terminal: "succeeded", identity: c.identity });
      expect(alive(pid)).toBe(false);
      expect(await h.protocol()).toContain(`exit:${pid}`);
    } finally {
      await writeFile(join(h.directory, "finish"), "");
      await writeFile(join(h.directory, "pause-A"), "");
      await unlink(join(h.directory, "pause-A"));
      await aSettled;
      await bRun;
      if (cRun) await cRun;
      openings.mockRestore();
      acquisitions.mockRestore();
      await h.provider.shutdown();
      await rm(h.directory, { recursive: true, force: true });
    }
  });
});
