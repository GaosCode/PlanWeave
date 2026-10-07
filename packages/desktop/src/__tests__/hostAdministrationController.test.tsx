/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorControlStatus, OperatorProfileView } from "../shared/operatorControl";
import { useHostAdministrationController } from "../renderer/hooks/useHostAdministrationController";

const bridgeMock = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(),
  listOperatorHosts: vi.fn(),
  getOperatorLocalAgentHostStatus: vi.fn(),
  copyOperatorHostBootstrapHandoff: vi.fn(),
  registerOperatorLocalAgentHost: vi.fn(),
  revokeOperatorHost: vi.fn(),
  renewOperatorHostCredential: vi.fn(),
  repairOperatorLocalAgentHost: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({
  collaborationBridge: null,
  operatorControlBridge: bridgeMock
}));

vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: {
      activeProfileId: "collab-1",
      profiles: [{ profileId: "collab-1", humanPrincipalId: "workspace-human-other" }],
      session: { phase: "connected" }
    },
    loading: false,
    error: null,
    refresh: async () => undefined
  })
}));

function profile(
  profileId: string,
  overrides: Partial<OperatorProfileView> = {}
): OperatorProfileView {
  return {
    profileId,
    displayName: `Profile ${profileId}`,
    serverBaseUrl: "https://server.example/",
    allowInsecureTransport: false,
    hostedByThisDesktop: false,
    endpoint: {
      topology: "public_https" as const,
      serverOrigin: "https://server.example",
      allowedClientOrigins: ["https://server.example"],
      tlsTrust: "system_ca" as const
    },
    operatorId: `operator-${profileId}`,
    humanPrincipalId: "owner-human-1",
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only" as const,
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    ...overrides
  };
}

function status(
  activeProfileId = "profile-a",
  activeProfile = profile(activeProfileId)
): OperatorControlStatus {
  return {
    profiles: [activeProfile],
    activeProfileId,
    credentialStorage: "available" as const,
    nonPersistenceWarning: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only" as const,
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function host(id: string) {
  return {
    id,
    displayName: id,
    capabilities: [],
    capacity: 1,
    online: false,
    availability: { status: "unavailable" as const, reason: "offline" as const }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

let statusListener: ((next: ReturnType<typeof status>) => void) | undefined;

beforeEach(() => {
  statusListener = undefined;
  bridgeMock.getOperatorControlStatus.mockResolvedValue(status());
  bridgeMock.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusListener = listener;
    return () => undefined;
  });
  bridgeMock.listOperatorHosts.mockResolvedValue({ items: [host("host-a")], nextCursor: null });
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({
    supported: true,
    state: "not_registered",
    agents: []
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.values(bridgeMock).forEach((mock) => {
    mock.mockReset();
  });
});

describe("Host administration request authority", () => {
  it("waits for a slow local query to settle before scheduling the next five-second poll", async () => {
    vi.useFakeTimers();
    const slow = deferred<{ supported: boolean; state: string; agents: never[] }>();
    bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation((input) =>
      input.profileId
        ? slow.promise
        : Promise.resolve({ supported: true, state: "not_registered", agents: [] })
    );
    const { unmount } = renderHook(() => useHostAdministrationController());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const initial = bridgeMock.getOperatorLocalAgentHostStatus.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initial);
    await act(async () => slow.resolve({ supported: true, state: "not_registered", agents: [] }));
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initial);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initial + 1);
    unmount();
  });

  it("keeps a registration result when an older local poll settles afterward", async () => {
    const slow = deferred<{ supported: boolean; state: string; agents: never[] }>();
    bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation((input) =>
      input.profileId
        ? slow.promise
        : Promise.resolve({ supported: true, state: "not_registered", agents: [] })
    );
    bridgeMock.registerOperatorLocalAgentHost.mockResolvedValue({
      supported: true,
      state: "ready",
      background: "running",
      agents: []
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.activeProfile?.profileId).toBe("profile-a"));
    await act(async () => {
      await result.current.registerLocalAgentHost([]);
    });
    expect(result.current.localAgentHost?.state).toBe("ready");
    await act(async () => slow.resolve({ supported: true, state: "not_registered", agents: [] }));
    expect(result.current.localAgentHost?.state).toBe("ready");
  });

  it("recovers after a slow local refresh fails and stops polling when unmounted", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ supported: boolean; state: string; agents: never[] }>();
    bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation((input) =>
      input.profileId
        ? pending.promise
        : Promise.resolve({ supported: true, state: "not_registered", agents: [] })
    );
    const { result, unmount } = renderHook(() => useHostAdministrationController());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const initial = bridgeMock.getOperatorLocalAgentHostStatus.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initial);
    await act(async () => pending.reject(new Error("agent_host_background_query_timeout")));
    expect(result.current.error).toBe("agent_host_background_query_timeout");
    expect(result.current.localAgentHost).toBeNull();
    expect(result.current.localAgentHostLoading).toBe(false);
    bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({
      supported: true,
      state: "ready",
      background: "running",
      agents: []
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.localAgentHost?.state).toBe("ready");
    expect(result.current.error).toBeNull();
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initial + 1);
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("ignores an old local A %s after A to B to A", async (settlement) => {
    const oldA = deferred<{ supported: boolean; state: string; agents: never[] }>();
    let aReads = 0;
    bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation((input) => {
      if (input.profileId === "profile-a" && ++aReads === 1) return oldA.promise;
      return Promise.resolve({
        supported: true,
        state: "ready",
        background: "running",
        workspaceId: input.profileId ?? "initial",
        agents: []
      });
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(aReads).toBe(1));
    await act(async () => statusListener?.(status("profile-b")));
    await waitFor(() => expect(result.current.localAgentHost?.workspaceId).toBe("profile-b"));
    await act(async () => statusListener?.(status("profile-a")));
    await waitFor(() => expect(result.current.localAgentHost?.workspaceId).toBe("profile-a"));
    await act(async () => {
      if (settlement === "resolve")
        oldA.resolve({ supported: true, state: "not_registered", agents: [] });
      else oldA.reject(new Error("agent_host_background_query_timeout"));
    });
    expect(result.current.localAgentHost?.workspaceId).toBe("profile-a");
    expect(result.current.localAgentHostLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it.each([
    { method: "register" as const, settlement: "resolve" },
    { method: "register" as const, settlement: "reject" },
    { method: "repair" as const, settlement: "resolve" },
    { method: "repair" as const, settlement: "reject" }
  ])("does not let old $method $settlement clear a new A action after A to B to A", async ({
    method,
    settlement
  }) => {
    const old = deferred<{ supported: boolean; state: string; agents: never[] }>();
    const current = deferred<{ supported: boolean; state: string; agents: never[] }>();
    const bridge =
      method === "register"
        ? bridgeMock.registerOperatorLocalAgentHost
        : bridgeMock.repairOperatorLocalAgentHost;
    bridge.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.activeProfile?.profileId).toBe("profile-a"));
    let oldAction!: Promise<unknown>;
    await act(async () => {
      oldAction =
        method === "register"
          ? result.current.registerLocalAgentHost([])
          : result.current.repairLocalAgentHost([]);
    });
    await act(async () => statusListener?.(status("profile-b")));
    await act(async () => statusListener?.(status("profile-a")));
    let newAction!: Promise<unknown>;
    await act(async () => {
      newAction =
        method === "register"
          ? result.current.registerLocalAgentHost([])
          : result.current.repairLocalAgentHost([]);
    });
    expect(result.current.busy).toBe(true);
    const reads = bridgeMock.getOperatorLocalAgentHostStatus.mock.calls.length;
    await act(async () => {
      if (settlement === "resolve")
        old.resolve({ supported: true, state: "not_registered", agents: [] });
      else old.reject(new Error("local_agent_host_registration_failed"));
      await oldAction;
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(reads);
    await act(async () => {
      current.resolve({ supported: true, state: "ready", agents: [] });
      await newAction;
    });
    expect(result.current.localAgentHost?.state).toBe("ready");
    expect(result.current.busy).toBe(false);
  });

  it("does not create another local query after unmounting a pending poll and repair", async () => {
    vi.useFakeTimers();
    const poll = deferred<{ supported: boolean; state: string; agents: never[] }>();
    const action = deferred<{ supported: boolean; state: string; agents: never[] }>();
    bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation((input) =>
      input.profileId
        ? poll.promise
        : Promise.resolve({ supported: true, state: "not_registered", agents: [] })
    );
    bridgeMock.repairOperatorLocalAgentHost.mockImplementation(() => action.promise);
    const { result, unmount } = renderHook(() => useHostAdministrationController());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    let repair!: Promise<unknown>;
    await act(async () => {
      repair = result.current.repairLocalAgentHost([]);
    });
    const reads = bridgeMock.getOperatorLocalAgentHostStatus.mock.calls.length;
    unmount();
    await act(async () => {
      poll.reject(new Error("agent_host_background_query_cancelled"));
      action.reject(new Error("local_agent_host_registration_failed"));
      await repair;
    });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(reads);
  });

  it("ignores an old A failure after A to B to A publishes the latest success", async () => {
    const oldA = deferred<{ items: ReturnType<typeof host>[]; nextCursor: null }>();
    bridgeMock.listOperatorHosts
      .mockImplementationOnce(() => oldA.promise)
      .mockResolvedValueOnce({ items: [host("host-b")], nextCursor: null })
      .mockResolvedValueOnce({ items: [host("host-a-latest")], nextCursor: null });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(1));

    await act(async () => statusListener?.(status("profile-b")));
    await waitFor(() => expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-b"]));
    await act(async () => statusListener?.(status("profile-a")));
    await waitFor(() =>
      expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-a-latest"])
    );

    await act(async () => oldA.reject(new Error("operator_timeout")));

    expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-a-latest"]);
    expect(result.current.error).toBeNull();
    expect(result.current.hostsLoading).toBe(false);
  });

  it("keeps the latest A failure when an older A success arrives later", async () => {
    const oldA = deferred<{ items: ReturnType<typeof host>[]; nextCursor: null }>();
    bridgeMock.listOperatorHosts
      .mockImplementationOnce(() => oldA.promise)
      .mockResolvedValueOnce({ items: [host("host-b")], nextCursor: null })
      .mockRejectedValueOnce(new Error("operator_timeout"));
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(1));

    await act(async () => statusListener?.(status("profile-b")));
    await waitFor(() => expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-b"]));
    await act(async () => statusListener?.(status("profile-a")));
    await waitFor(() => expect(result.current.error).toBe("operator_timeout"));

    await act(async () => oldA.resolve({ items: [host("host-a-stale")], nextCursor: null }));

    expect(result.current.hosts).toEqual([]);
    expect(result.current.error).toBe("operator_timeout");
    expect(result.current.hostInventoryState).toBe("unavailable");
  });

  it("invalidates an in-flight response when the active profile credential is cleared", async () => {
    const oldCredentialRead = deferred<{
      items: ReturnType<typeof host>[];
      nextCursor: null;
    }>();
    bridgeMock.listOperatorHosts.mockImplementationOnce(() => oldCredentialRead.promise);
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(bridgeMock.listOperatorHosts).toHaveBeenCalledOnce());

    await act(async () =>
      statusListener?.(
        status(
          "profile-a",
          profile("profile-a", {
            hasOperatorCredential: false,
            operatorCredentialPersistence: "missing",
            updatedAt: "2030-01-01T00:00:01.000Z"
          })
        )
      )
    );
    expect(result.current.hostInventoryState).toBe("credential_missing");

    await act(async () =>
      oldCredentialRead.resolve({ items: [host("host-stale")], nextCursor: null })
    );

    expect(result.current.hosts).toEqual([]);
    expect(result.current.hostInventoryState).toBe("credential_missing");
    expect(result.current.error).toBeNull();
  });

  it("deduplicates same-authority refreshes while one request is in flight", async () => {
    const firstRead = deferred<{ items: ReturnType<typeof host>[]; nextCursor: null }>();
    bridgeMock.listOperatorHosts.mockImplementationOnce(() => firstRead.promise);
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(bridgeMock.listOperatorHosts).toHaveBeenCalledOnce());

    let refreshA: Promise<void> | undefined;
    let refreshB: Promise<void> | undefined;
    act(() => {
      refreshA = result.current.refreshHosts();
      refreshB = result.current.refreshHosts();
    });
    expect(refreshA).toBe(refreshB);
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledOnce();

    await act(async () => firstRead.resolve({ items: [host("host-current")], nextCursor: null }));
    await Promise.all([refreshA, refreshB]);
    expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-current"]);
  });

  it("does not publish earlier pages when a later page fails", async () => {
    bridgeMock.listOperatorHosts
      .mockResolvedValueOnce({ items: [host("host-first-page")], nextCursor: 1 })
      .mockRejectedValueOnce(new Error("operator_timeout"));
    const { result } = renderHook(() => useHostAdministrationController());

    await waitFor(() => expect(result.current.error).toBe("operator_timeout"));

    expect(result.current.hosts).toEqual([]);
    expect(result.current.hostInventoryState).toBe("unavailable");
  });

  it("runs the five-second silent poll without replacing the ready state with loading", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useHostAdministrationController());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledOnce();
    expect(result.current.hostInventoryState).toBe("ready");

    const initialLocalReads = bridgeMock.getOperatorLocalAgentHostStatus.mock.calls.length;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(cycle + 2);
      expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(
        initialLocalReads + cycle + 1
      );
      expect(result.current.hostInventoryState).toBe("ready");
      expect(result.current.hostsLoading).toBe(false);
    }
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(4);
    expect(bridgeMock.getOperatorLocalAgentHostStatus).toHaveBeenCalledTimes(initialLocalReads + 3);
  });

  it("coalesces concurrent continuation calls into one non-terminal batch", async () => {
    const firstContinuationPage = deferred<{
      items: ReturnType<typeof host>[];
      nextCursor: number;
    }>();
    bridgeMock.listOperatorHosts.mockImplementation(({ query }) => {
      const cursor = query.cursor;
      if (cursor === 5) return firstContinuationPage.promise;
      return Promise.resolve({ items: [host(`host-${cursor}`)], nextCursor: cursor + 1 });
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.hostsHasMore).toBe(true));

    let continueA: Promise<void> | undefined;
    let continueB: Promise<void> | undefined;
    act(() => {
      continueA = result.current.loadMoreHosts();
      continueB = result.current.loadMoreHosts();
    });
    expect(continueA).toBe(continueB);
    await waitFor(() =>
      expect(
        bridgeMock.listOperatorHosts.mock.calls.filter(([input]) => input.query.cursor === 5)
      ).toHaveLength(1)
    );

    await act(async () =>
      firstContinuationPage.resolve({ items: [host("host-5")], nextCursor: 6 })
    );
    await Promise.all([continueA, continueB]);

    expect(result.current.hosts.map(({ id }) => id)).toEqual([
      "host-0",
      "host-1",
      "host-2",
      "host-3",
      "host-4",
      "host-5",
      "host-6",
      "host-7",
      "host-8",
      "host-9"
    ]);
    expect(result.current.hostsHasMore).toBe(true);
    expect(
      bridgeMock.listOperatorHosts.mock.calls.filter(([input]) => input.query.cursor === 10)
    ).toHaveLength(0);
  });

  it("runs a refresh queued during continuation after that continuation finishes", async () => {
    const continuationPage = deferred<{
      items: ReturnType<typeof host>[];
      nextCursor: null;
    }>();
    let initialBatchComplete = false;
    bridgeMock.listOperatorHosts.mockImplementation(({ query }) => {
      const cursor = query.cursor;
      if (!initialBatchComplete) {
        if (cursor === 4) initialBatchComplete = true;
        return Promise.resolve({ items: [host(`initial-${cursor}`)], nextCursor: cursor + 1 });
      }
      if (cursor === 5) return continuationPage.promise;
      return Promise.resolve({ items: [host("refreshed")], nextCursor: null });
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.hostsHasMore).toBe(true));

    let continuation: Promise<void> | undefined;
    let refresh: Promise<void> | undefined;
    act(() => {
      continuation = result.current.loadMoreHosts();
    });
    await waitFor(() =>
      expect(bridgeMock.listOperatorHosts.mock.calls.map(([input]) => input.query.cursor)).toEqual([
        0, 1, 2, 3, 4, 5
      ])
    );
    act(() => {
      refresh = result.current.refreshHosts();
    });
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(6);

    await act(async () =>
      continuationPage.resolve({ items: [host("continued")], nextCursor: null })
    );
    await Promise.all([continuation, refresh]);

    expect(bridgeMock.listOperatorHosts.mock.calls.map(([input]) => input.query.cursor)).toEqual([
      0, 1, 2, 3, 4, 5, 0
    ]);
    expect(result.current.hosts.map(({ id }) => id)).toEqual(["refreshed"]);
    expect(result.current.hostsHasMore).toBe(false);
  });

  it("drops a queued operation when its authority becomes stale before it starts", async () => {
    const authorityAContinuation = deferred<{
      items: ReturnType<typeof host>[];
      nextCursor: null;
    }>();
    bridgeMock.listOperatorHosts.mockImplementation(({ profileId, query }) => {
      if (profileId === "profile-b") {
        return Promise.resolve({ items: [host("host-b")], nextCursor: null });
      }
      if (query.cursor === 5) return authorityAContinuation.promise;
      return Promise.resolve({
        items: [host(`host-a-${query.cursor}`)],
        nextCursor: query.cursor + 1
      });
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.hostsHasMore).toBe(true));

    let continuation: Promise<void> | undefined;
    let queuedRefresh: Promise<void> | undefined;
    act(() => {
      continuation = result.current.loadMoreHosts();
    });
    await waitFor(() =>
      expect(
        bridgeMock.listOperatorHosts.mock.calls.filter(
          ([input]) => input.profileId === "profile-a" && input.query.cursor === 5
        )
      ).toHaveLength(1)
    );
    act(() => {
      queuedRefresh = result.current.refreshHosts();
    });

    await act(async () => statusListener?.(status("profile-b")));
    await waitFor(() => expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-b"]));
    expect(result.current.hostsLoading).toBe(false);
    expect(result.current.hostInventoryState).toBe("ready");

    await act(async () =>
      authorityAContinuation.resolve({ items: [host("host-a-stale")], nextCursor: null })
    );
    await Promise.all([continuation, queuedRefresh]);

    expect(
      bridgeMock.listOperatorHosts.mock.calls.filter(
        ([input]) => input.profileId === "profile-a" && input.query.cursor === 0
      )
    ).toHaveLength(1);
    expect(result.current.hosts.map(({ id }) => id)).toEqual(["host-b"]);
    expect(result.current.hostsLoading).toBe(false);
    expect(result.current.hostInventoryState).toBe("ready");
  });

  it("creates a personal unrestricted enrollment grant with an explicit owner", async () => {
    bridgeMock.copyOperatorHostBootstrapHandoff.mockResolvedValue({
      state: "ready",
      expiresAt: "2030-01-01T00:15:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      copiedAt: "2030-01-01T00:00:00.000Z",
      commandPreview: "planweave agent-host enroll <handoff>"
    });
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.activeProfile?.profileId).toBe("profile-a"));
    await act(async () => {
      await result.current.copyBootstrapHandoff();
    });
    expect(bridgeMock.copyOperatorHostBootstrapHandoff).toHaveBeenCalledWith({
      profileId: "profile-a",
      request: {
        expiresAt: expect.any(String),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: "owner-human-1",
        accessMode: "unrestricted"
      }
    });
  });

  it("creates a workspace-restricted enrollment grant with an explicit Grant", async () => {
    bridgeMock.copyOperatorHostBootstrapHandoff.mockResolvedValue({
      state: "ready",
      workspaceId: "workspace-a",
      expiresAt: "2030-01-01T00:15:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      copiedAt: "2030-01-01T00:00:00.000Z",
      commandPreview: "planweave agent-host enroll <handoff>"
    });
    const { result } = renderHook(() =>
      useHostAdministrationController({ enrollmentWorkspaceId: "workspace-a" })
    );
    await waitFor(() => expect(result.current.activeProfile?.profileId).toBe("profile-a"));
    await act(async () => {
      await result.current.copyBootstrapHandoff();
    });
    expect(bridgeMock.copyOperatorHostBootstrapHandoff).toHaveBeenCalledWith({
      profileId: "profile-a",
      request: {
        expiresAt: expect.any(String),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: "owner-human-1",
        accessMode: "workspace_restricted",
        workspaceId: "workspace-a",
        createWorkspaceGrant: true
      }
    });
  });
  it.each([
    "revoke",
    "renew"
  ] as const)("clears busy and preserves hosts after %s has an unknown timeout outcome", async (action) => {
    const pending = deferred<never>();
    const transport =
      action === "revoke" ? bridgeMock.revokeOperatorHost : bridgeMock.renewOperatorHostCredential;
    transport.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useHostAdministrationController());
    await waitFor(() => expect(result.current.hosts).toEqual([host("host-a")]));
    let operation!: Promise<unknown>;
    act(() => {
      operation =
        action === "revoke"
          ? result.current.revokeHost("host-a")
          : result.current.renewHostCredential("host-a");
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      pending.reject(new Error("operator_timeout"));
      await operation;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("operator_timeout");
    expect(result.current.hosts).toEqual([host("host-a")]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
