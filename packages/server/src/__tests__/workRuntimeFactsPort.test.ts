import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteHostWorkRuntimeFactsAdapter } from "../work/remoteHostRuntimeFactsAdapter.js";
import {
  AuthoritySelectingWorkRuntimeFactsAdapter,
  factsLease
} from "../work/runtimeFactsAdapters.js";
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

async function setupRemoteFacts(timeoutMs = 50, diagnosticSink = vi.fn()) {
  const environment = await createRemoteHostRuntimeTestEnvironment({
    scope: remoteScope,
    requestTimeoutMs: 5_000
  });
  environments.push(environment);
  const second = environment.addHost("Second Runtime");
  const remoteFacts = new RemoteHostWorkRuntimeFactsAdapter(
    environment.locator,
    environment.broker,
    { requestTimeoutMs: timeoutMs, diagnosticSink }
  );
  const facts = new AuthoritySelectingWorkRuntimeFactsAdapter(
    { acquireFacts: async () => undefined },
    { read: () => ({ target: contentTarget, sourceRevision }) }
  );
  facts.attachRemote(remoteFacts);
  return { ...environment, second, facts, remoteFacts, diagnosticSink };
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

describe("AuthoritySelectingWorkRuntimeFactsAdapter", () => {
  it("releases stale local facts and selects exact remote authority", async () => {
    const fixture = await setupRemoteFacts();
    const releaseLocal = vi.fn();
    const local = {
      acquireFacts: vi.fn(async (input: Parameters<typeof factsLease>[0]) => {
        const lease = factsLease(input, {
          ...exactFactsResult(),
          sourceRevision: "snapshot:stale"
        });
        return { ...lease, release: releaseLocal };
      })
    };
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, {
      read: () => ({ target: contentTarget, sourceRevision })
    });
    selector.attachRemote(fixture.remoteFacts);

    const pending = selector.acquireFacts({ scope: remoteScope, workItems: remoteItems });
    respondExact(fixture);

    await expect(pending).resolves.toMatchObject({ evidence: { sourceRevision } });
    expect(releaseLocal).toHaveBeenCalledOnce();
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("keeps exact local facts while diagnosing a settled remote failure", async () => {
    const fixture = await setupRemoteFacts();
    fixture.disconnectHost(fixture.second.host.id);
    const local = {
      acquireFacts: async (input: Parameters<typeof factsLease>[0]) =>
        factsLease(input, exactFactsResult())
    };
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, {
      read: () => ({ target: contentTarget, sourceRevision })
    });
    selector.attachRemote(fixture.remoteFacts);

    const pending = selector.acquireFacts({ scope: remoteScope, workItems: remoteItems });
    respondUnknown(fixture, fixture.host.id, fixture.deliveries, "unexpected_facts_failure");

    await expect(pending).resolves.toMatchObject({ evidence: { sourceRevision } });
    await vi.waitFor(() =>
      expect(fixture.diagnosticSink).toHaveBeenCalledWith({
        candidateId: `host:${fixture.host.id}`,
        category: "peer_error",
        code: "unexpected_facts_failure"
      })
    );
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("fails content_out_of_sync when every local and remote candidate drifts", async () => {
    const fixture = await setupRemoteFacts();
    const releaseLocal = vi.fn();
    const local = {
      acquireFacts: async (input: Parameters<typeof factsLease>[0]) => {
        const lease = factsLease(input, {
          ...exactFactsResult(),
          sourceRevision: "snapshot:local-stale"
        });
        return { ...lease, release: releaseLocal };
      }
    };
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, {
      read: () => ({ target: contentTarget, sourceRevision })
    });
    selector.attachRemote(fixture.remoteFacts);
    const pending = selector.acquireFacts({ scope: remoteScope, workItems: remoteItems });
    for (const peer of [fixture, fixture.second]) {
      respond(fixture.broker, peer.host.id, commandAt(peer.deliveries, 0), {
        outcome: "success",
        operation: "resolve_work_items",
        result: { ...exactFactsResult(), sourceRevision: "snapshot:remote-stale" }
      });
    }

    await expect(pending).rejects.toEqual(new WorkRuntimeUnavailableError("content_out_of_sync"));
    expect(releaseLocal).toHaveBeenCalledOnce();
  });

  it("preserves content_out_of_sync when asynchronous winner release fails", async () => {
    const release = vi.fn(async () => {
      throw new Error("async_release_failed");
    });
    const local = {
      acquireFacts: async (input: Parameters<typeof factsLease>[0]) => ({
        ...factsLease(input, exactFactsResult()),
        release
      })
    };
    const read = vi
      .fn()
      .mockReturnValueOnce({ target: contentTarget, sourceRevision })
      .mockReturnValueOnce({
        target: { ...contentTarget, revision: contentTarget.revision + 1 },
        sourceRevision: "snapshot:changed"
      });
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, { read });

    await expect(
      selector.acquireFacts({ scope: remoteScope, workItems: remoteItems })
    ).rejects.toEqual(new WorkRuntimeUnavailableError("content_out_of_sync"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves an authority read error when synchronous winner release fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const release = vi.fn(() => {
      throw new Error("secret:/private/runtime/release");
    });
    const local = {
      acquireFacts: async (input: Parameters<typeof factsLease>[0]) => ({
        ...factsLease(input, exactFactsResult()),
        release
      })
    };
    const read = vi
      .fn()
      .mockReturnValueOnce({ target: contentTarget, sourceRevision })
      .mockImplementationOnce(() => {
        throw new Error("authority_read_failed");
      });
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, { read });

    await expect(
      selector.acquireFacts({ scope: remoteScope, workItems: remoteItems })
    ).rejects.toThrow("authority_read_failed");
    expect(read).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("work_runtime_facts_candidate_error", {
      candidateId: "local",
      category: "peer_error",
      code: "work_runtime_facts_candidate_unknown"
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/private/runtime");
  });

  it("isolates a throwing cleanup logger from the authority error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger_failed");
    });
    const release = vi.fn(async () => {
      throw new Error("release_failed");
    });
    const local = {
      acquireFacts: async (input: Parameters<typeof factsLease>[0]) => ({
        ...factsLease(input, exactFactsResult()),
        release
      })
    };
    const read = vi
      .fn()
      .mockReturnValueOnce({ target: contentTarget, sourceRevision })
      .mockImplementationOnce(() => {
        throw new Error("authority_read_failed");
      });
    const selector = new AuthoritySelectingWorkRuntimeFactsAdapter(local, { read });

    await expect(
      selector.acquireFacts({ scope: remoteScope, workItems: remoteItems })
    ).rejects.toThrow("authority_read_failed");
    expect(release).toHaveBeenCalledOnce();
  });
});
