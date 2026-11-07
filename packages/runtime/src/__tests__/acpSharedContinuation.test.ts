import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createAcpConnection } from "../autoRun/acpConnection.js";
import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnInput
} from "../autoRun/acpConversationTurn.js";
import { acpConversationTurnIdentitySchema } from "../autoRun/acpConversationTurnContract.js";
import { acpSessionIdSchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";

const fixture = fileURLToPath(new URL("./support/acpSharedContinuationAgent.mjs", import.meta.url));

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}

it("reuses one child for two real continuations while a sibling keeps prompting and receiving events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-shared-continuation-"));
  const pids: number[] = [];
  const provider = createSharedAcpConnectionProvider({
    idleMs: 20,
    connect: (options) => {
      const connection = createAcpConnection(options);
      if (connection.processId === null) throw new Error("missing ACP process id");
      pids.push(connection.processId);
      return connection;
    }
  });
  const coordinator = new AcpConversationTurnCoordinator(undefined, { provider });
  const stores: AcpEventStore[] = [];
  async function input(label: string, text: string): Promise<AcpConversationTurnInput> {
    const runDir = join(directory, label);
    const claimRef = `T-${label}#B-001`;
    const runId = `RUN-${label}`;
    const sessionId = acpSessionIdSchema.parse(`session-${label}`);
    const store = new AcpEventStore({
      runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: "shared-continuation",
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
    stores.push(store);
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
        profileId: "shared-continuation",
        agentId: "codex",
        displayName: "Shared continuation",
        host: { kind: "native" },
        launch: { command: process.execPath, args: [fixture, directory] },
        environment: [],
        shutdown: { eofDrainMs: 50, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
        capabilities: { required: [], optional: [] },
        connection: { mode: "shared-project" },
        source: "builtin",
        fingerprint: "shared-continuation"
      },
      environment: { env: {}, availableNames: [] },
      text,
      timeoutMs: 5000,
      eventStore: store.completedConversationWriter(sessionId)
    };
  }
  const a = await input("A", "first");
  const b = await input("B", "hold");
  const sibling = coordinator.send(b);
  const siblingSettled = sibling.catch((error: unknown) => error);
  try {
    await vi.waitFor(async () => {
      expect(await readFile(join(directory, "protocol.log"), "utf8")).toContain(
        "session/prompt:session-B"
      );
    });
    await expect(coordinator.send(a)).resolves.toMatchObject({
      terminal: "succeeded",
      identity: a.identity
    });
    expect(coordinator.admission(a.key)).toMatchObject({ available: true });
    const next = { ...a, text: "second", identity: { ...a.identity, turnId: randomUUID() } };
    await expect(coordinator.send(next)).resolves.toMatchObject({
      terminal: "succeeded",
      identity: next.identity
    });
    expect(coordinator.current(b.key, b.identity)).toMatchObject({
      found: true,
      state: { phase: "prompting" }
    });
    expect(pids).toHaveLength(1);
    expect(exited(pids[0]!)).toBe(false);
    await writeFile(join(directory, "finish"), "");
    await expect(sibling).resolves.toMatchObject({ terminal: "succeeded", identity: b.identity });
    const [aStore, bStore] = stores;
    const aEvents = aStore!.snapshot().events;
    const bEvents = bStore!.snapshot().events;
    expect(JSON.stringify(aEvents)).toContain("answer:first");
    expect(JSON.stringify(aEvents)).toContain("answer:second");
    expect(JSON.stringify(aEvents)).not.toContain("sibling-during");
    expect(JSON.stringify(bEvents)).toContain("sibling-during:first");
    expect(JSON.stringify(bEvents)).toContain("sibling-during:second");
    expect(JSON.stringify(bEvents)).toContain("sibling-finished");
    const protocol = await readFile(join(directory, "protocol.log"), "utf8");
    expect(protocol.match(/spawn:/g)).toHaveLength(1);
    expect(protocol.match(/session\/load:session-A/g)).toHaveLength(2);
    expect(protocol.match(/session\/close:session-A/g)).toHaveLength(2);
    expect(exited(pids[0]!)).toBe(true);
    expect(protocol).toContain(`exit:${pids[0]}`);
    console.info(
      JSON.stringify({
        beforeFinally: true,
        pids,
        processes: pids.length,
        exited: pids.map(exited)
      })
    );
  } finally {
    await coordinator.cancel(b.key, b.identity);
    await siblingSettled;
    await provider.shutdown();
    for (const pid of pids) expect(exited(pid)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
