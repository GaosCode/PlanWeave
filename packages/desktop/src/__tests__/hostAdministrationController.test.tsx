/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorControlStatus, OperatorProfileView } from "../shared/operatorControl";
import { useHostAdministrationController } from "../renderer/hooks/useHostAdministrationController";

const bridgeMock = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(),
  listOperatorHosts: vi.fn(),
  getOperatorLocalAgentHostStatus: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({
  collaborationBridge: null,
  operatorControlBridge: bridgeMock
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
    const { result } = renderHook(() => useHostAdministrationController());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledOnce();
    expect(result.current.hostInventoryState).toBe("ready");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(2);
    expect(result.current.hostInventoryState).toBe("ready");
    expect(result.current.hostsLoading).toBe(false);
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
});
