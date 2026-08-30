import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteHostWorkRuntimeFactsAdapter } from "../work/remoteHostRuntimeFactsAdapter.js";
import { withWorkRuntimeFacts, WorkRuntimeUnavailableError } from "../work/runtimePort.js";
import type { WorkItemRef } from "../work/schemas.js";
import {
  createRemoteHostRuntimeTestEnvironment,
  type RemoteHostRuntimeTestEnvironment,
  respondToRuntimeRequest as respond,
  runtimeRequestCommandAt as commandAt
} from "./support/remoteHostRuntimeTestEnvironment.js";
import { runtimeFactsFromPackagePort } from "./workRuntimeFactsFixture.js";

const items: WorkItemRef[] = [
  { kind: "task", canvasId: "canvas-a", taskId: "T-001" },
  { kind: "block", canvasId: "canvas-a", blockRef: "T-001#B-001" }
];
const environments: RemoteHostRuntimeTestEnvironment[] = [];
const remoteScope = canvasScopeRefSchema.parse({
  workspaceId: "workspace-remote-facts",
  projectId: "project-remote-facts",
  canvasId: "default"
});
const contentTarget = {
  revision: 1,
  content: {
    versionId: `version-${"c".repeat(64)}`,
    canonicalDigest: "c".repeat(64),
    verification: "complete" as const
  },
  graphFingerprint: `pkg-${"a".repeat(64)}`
};
const sourceRevision = "snapshot:test";
const remoteItems = [{ kind: "task" as const, canvasId: remoteScope.canvasId, taskId: "T-001" }];

afterEach(() => {
  vi.useRealTimers();
  for (const environment of environments.splice(0)) environment.close();
});

async function setupRemoteFacts(timeoutMs = 50) {
  const environment = await createRemoteHostRuntimeTestEnvironment({
    scope: remoteScope,
    requestTimeoutMs: 5_000
  });
  environments.push(environment);
  const second = environment.addHost("Second Runtime");
  const facts = new RemoteHostWorkRuntimeFactsAdapter(
    environment.locator,
    environment.broker,
    { read: () => ({ target: contentTarget, sourceRevision }) },
    { requestTimeoutMs: timeoutMs }
  );
  return { ...environment, second, facts };
}

function exactFactsResult() {
  return {
    sourceRevision,
    graphFingerprint: contentTarget.graphFingerprint,
    facts: [
      {
        kind: "task",
        canvasId: remoteScope.canvasId,
        taskId: "T-001",
        exists: true,
        requiredCapabilities: []
      }
    ]
  };
}

function respondExact(fixture: Awaited<ReturnType<typeof setupRemoteFacts>>, second = false): void {
  const peer = second ? fixture.second : fixture;
  respond(fixture.broker, peer.host.id, commandAt(peer.deliveries, 0), {
    outcome: "success",
    operation: "resolve_work_items",
    result: exactFactsResult()
  });
}

function respondUnknown(
  fixture: Awaited<ReturnType<typeof setupRemoteFacts>>,
  hostId: string,
  deliveries: typeof fixture.deliveries,
  code: string
): void {
  respond(fixture.broker, hostId, commandAt(deliveries, 0), {
    outcome: "error",
    operation: "resolve_work_items",
    error: { code, message: "Unexpected Work facts failure.", retryable: false }
  });
}

describe("WorkRuntimePackageFactsPort", () => {
  it("acquires one batch per exact canvas and releases exactly once on success", async () => {
    const release = vi.fn();
    const base = runtimeFactsFromPackagePort(
      {
        resolveWorkItem(item) {
          return {
            ...item,
            exists: true,
            requiredCapabilities: item.kind === "block" ? ["acp.codex"] : []
          };
        },
        resolveWorkItems(requested) {
          return requested.map((item) => this.resolveWorkItem(item));
        }
      },
      release
    );
    const acquireFacts = vi.spyOn(base, "acquireFacts");
    const result = await withWorkRuntimeFacts(
      base,
      { workspaceId: "workspace-a", projectId: "project-a" },
      items,
      (snapshot) => snapshot.resolveWorkItems(items)
    );
    expect(result).toHaveLength(2);
    expect(acquireFacts).toHaveBeenCalledTimes(1);
    expect(acquireFacts.mock.calls[0]?.[0].scope.canvasId).toBe("canvas-a");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases once when the consumer fails and fails closed without a binding", async () => {
    const release = vi.fn();
    const port = runtimeFactsFromPackagePort(
      {
        resolveWorkItem(item) {
          return { ...item, exists: true, requiredCapabilities: [] };
        },
        resolveWorkItems(requested) {
          return requested.map((item) => this.resolveWorkItem(item));
        }
      },
      release
    );
    await expect(
      withWorkRuntimeFacts(
        port,
        { workspaceId: "workspace-a", projectId: "project-a" },
        items,
        () => {
          throw new Error("consumer_failed");
        }
      )
    ).rejects.toThrow("consumer_failed");
    expect(release).toHaveBeenCalledOnce();

    await expect(
      withWorkRuntimeFacts(
        { acquireFacts: async () => undefined },
        { workspaceId: "workspace-a", projectId: "project-a" },
        items,
        () => undefined
      )
    ).rejects.toEqual(new WorkRuntimeUnavailableError("runtime_not_attached"));
  });
});

describe("RemoteHostWorkRuntimeFactsAdapter peer settlement", () => {
  it("returns exact facts immediately while another peer remains stuck, then cleans it up", async () => {
    const fixture = await setupRemoteFacts();
    vi.useFakeTimers();
    const pending = fixture.facts.acquireFacts({ scope: remoteScope, workItems: remoteItems });

    respondExact(fixture, true);

    await expect(pending).resolves.toMatchObject({ evidence: { sourceRevision } });
    expect(fixture.broker.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("allows exact facts to win after an earlier unknown peer error", async () => {
    const fixture = await setupRemoteFacts();
    const pending = fixture.facts.acquireFacts({ scope: remoteScope, workItems: remoteItems });

    respondUnknown(fixture, fixture.host.id, fixture.deliveries, "unexpected_facts_failure");
    respondExact(fixture, true);

    await expect(pending).resolves.toMatchObject({ evidence: { sourceRevision } });
  });

  it("handles a later unknown peer error after exact facts already won", async () => {
    const fixture = await setupRemoteFacts();
    const pending = fixture.facts.acquireFacts({ scope: remoteScope, workItems: remoteItems });

    respondExact(fixture);
    await expect(pending).resolves.toMatchObject({ evidence: { sourceRevision } });
    respondUnknown(
      fixture,
      fixture.second.host.id,
      fixture.second.deliveries,
      "unexpected_facts_failure"
    );
    await Promise.resolve();
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("fails closed with the stable first Host unknown error when no exact facts exist", async () => {
    const fixture = await setupRemoteFacts();
    const located = fixture.locator.locateCandidates(remoteScope);
    if (located.kind !== "available") throw new Error("test_runtime_hosts_expected");
    const peers = new Map([
      [fixture.host.id, fixture.deliveries],
      [fixture.second.host.id, fixture.second.deliveries]
    ]);
    const pending = fixture.facts.acquireFacts({ scope: remoteScope, workItems: remoteItems });

    respondUnknown(
      fixture,
      located.hostIds[1]!,
      peers.get(located.hostIds[1]!) ?? [],
      "second_unknown_failure"
    );
    respondUnknown(
      fixture,
      located.hostIds[0]!,
      peers.get(located.hostIds[0]!) ?? [],
      "first_unknown_failure"
    );

    await expect(pending).rejects.toMatchObject({ code: "first_unknown_failure" });
  });

  it("prefers content drift over offline peers when no exact facts exist", async () => {
    const fixture = await setupRemoteFacts();
    const pending = fixture.facts.acquireFacts({ scope: remoteScope, workItems: remoteItems });

    fixture.disconnectHost(fixture.host.id);
    respond(fixture.broker, fixture.second.host.id, commandAt(fixture.second.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: { ...exactFactsResult(), sourceRevision: `snapshot:${"d".repeat(64)}` }
    });

    await expect(pending).rejects.toMatchObject({ code: "content_out_of_sync" });
  });
});
