import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleHumanDeviceToken,
  exampleObserverWelcome,
  exampleObserverCatchupRequired
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { HUMAN_OBSERVER_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import type {
  CollaborationClientClock,
  CollaborationWebSocketLike
} from "../main/collaboration/collaborationClientTypes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class SocketBoundary implements CollaborationWebSocketLike {
  static instances: SocketBoundary[] = [];
  static constructed?: () => void;
  readyState = 0;
  bufferedAmount = 0;
  readonly send = vi.fn<(text: string) => void>();
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private handshake?: Parameters<NonNullable<CollaborationWebSocketLike["on"]>>[1];
  constructor(readonly url: string) {
    SocketBoundary.instances.push(this);
    SocketBoundary.constructed?.();
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener)
    );
  }
  on(
    _type: "unexpected-response",
    listener: Parameters<NonNullable<CollaborationWebSocketLike["on"]>>[1]
  ) {
    this.handshake = listener;
  }
  emit(type: string, event: unknown = {}) {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  rejectHandshake(statusCode: number) {
    this.handshake?.({}, { statusCode, resume: vi.fn() });
  }
}

function fixture(getDeviceToken: () => Promise<string | undefined> | string | undefined) {
  const timers = new Set<() => void>();
  const clock: CollaborationClientClock = {
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    setTimeout: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (timer) => {
      for (const callback of timers) if (callback === timer) timers.delete(callback);
    }
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const client = new CollaborationClient({
    profile: {
      profileId: "observer-profile",
      displayName: "Observer",
      projectId: "project-demo-001",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: "http://127.0.0.1:8787/",
        allowedClientOrigins: ["http://127.0.0.1:8787/"],
        tlsTrust: "not_applicable"
      }
    },
    credential: { getDeviceToken },
    WebSocketImpl: SocketBoundary,
    clock,
    logger,
    random: () => 0
  });
  clients.push(client);
  return { client, timers, logger };
}
const clients: CollaborationClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  SocketBoundary.instances = [];
  SocketBoundary.constructed = undefined;
});
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

for (const termination of ["stop", "dispose"] as const) {
  for (const outcome of ["token", "missing", "rejection"] as const) {
    it(`ignores a late ${outcome} after ${termination} while credential is pending`, async () => {
      const pending = deferred<string | undefined>();
      const f = fixture(() => pending.promise);
      const statuses = vi.fn();
      f.client.startObserver({ onStatus: statuses });
      if (termination === "stop") f.client.stopObserver();
      else f.client.dispose();
      const count = statuses.mock.calls.length;
      if (outcome === "rejection") pending.reject(new Error("old credential failed"));
      else pending.resolve(outcome === "token" ? exampleHumanDeviceToken : undefined);
      await flush();
      expect(SocketBoundary.instances).toHaveLength(0);
      expect(f.client.observerState()).toEqual({ state: "stopped" });
      expect(statuses).toHaveBeenCalledTimes(count);
      expect(f.timers.size).toBe(0);
      expect(f.logger.error).not.toHaveBeenCalled();
    });
  }
}

for (const outcome of ["token", "missing", "rejection"] as const) {
  it(`keeps the new start when the previous pending credential returns ${outcome}`, async () => {
    const pending = deferred<string | undefined>();
    let calls = 0;
    const f = fixture(() => (++calls === 1 ? pending.promise : exampleHumanDeviceToken));
    f.client.startObserver();
    f.client.stopObserver();
    const status = vi.fn();
    f.client.startObserver({ onStatus: status });
    await flush();
    const current = SocketBoundary.instances[0];
    current.emit("open");
    current.message(exampleObserverWelcome);
    const before = f.client.observerState();
    const count = status.mock.calls.length;
    if (outcome === "rejection") pending.reject(new Error("superseded token failed"));
    else pending.resolve(outcome === "token" ? exampleHumanDeviceToken : undefined);
    await flush();
    expect(SocketBoundary.instances).toHaveLength(1);
    expect(f.client.observerState()).toEqual(before);
    expect(status).toHaveBeenCalledTimes(count);
    expect(current.close).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
  });
}

describe("observer socket generations through CollaborationClient", () => {
  it("ignores old socket events and handshake failure after replacement", async () => {
    const f = fixture(() => exampleHumanDeviceToken);
    f.client.startObserver();
    await flush();
    const old = SocketBoundary.instances[0];
    f.client.stopObserver();
    const onStatus = vi.fn();
    const onAuthExpired = vi.fn();
    f.client.startObserver({ onStatus, onAuthExpired });
    await flush();
    const current = SocketBoundary.instances[1];
    current.emit("open");
    current.message(exampleObserverWelcome);
    const state = f.client.observerState();
    const count = onStatus.mock.calls.length;
    old.emit("open");
    old.message({
      type: "human.observer.auth_expired",
      protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
      code: "human_device_revoked"
    });
    old.emit("error");
    old.emit("close");
    old.rejectHandshake(401);
    old.rejectHandshake(500);
    await flush();
    expect(f.client.observerState()).toEqual(state);
    expect(onStatus).toHaveBeenCalledTimes(count);
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(old.send).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it("reconnects once with the validated cursor and cancels reconnect on stop", async () => {
    const f = fixture(() => exampleHumanDeviceToken);
    f.client.startObserver({}, { cursor: 2 });
    await flush();
    const old = SocketBoundary.instances[0];
    old.emit("open");
    old.message({ ...exampleObserverWelcome, cursor: 5 });
    old.emit("close");
    old.emit("close");
    expect(f.timers.size).toBe(1);
    const timer = [...f.timers][0];
    f.timers.delete(timer);
    timer();
    await flush();
    const next = SocketBoundary.instances[1];
    next.emit("open");
    expect(JSON.parse(next.send.mock.calls[0][0]).lastCursor).toBe(5);
    next.emit("close");
    expect(f.timers.size).toBe(1);
    f.client.stopObserver();
    expect(f.timers.size).toBe(0);
  });
});

it("reports current missing credentials without reconnecting", async () => {
  const f = fixture(() => undefined);
  f.client.startObserver();
  await flush();
  expect(f.client.observerState()).toEqual({
    state: "auth_expired",
    code: "collaboration_credential_missing"
  });
  expect(f.timers.size).toBe(0);
  expect(SocketBoundary.instances).toHaveLength(0);
});

it("retries current credential failure and connects after recovery", async () => {
  let calls = 0;
  const f = fixture(() =>
    ++calls === 1 ? Promise.reject(new Error("credential read failed")) : exampleHumanDeviceToken
  );
  f.client.startObserver();
  await flush();
  expect(f.client.observerState().state).toBe("reconnecting");
  expect(f.logger.error).toHaveBeenCalledWith("credential read failed");
  const timer = [...f.timers][0];
  f.timers.delete(timer);
  timer();
  await flush();
  expect(SocketBoundary.instances).toHaveLength(1);
  SocketBoundary.instances[0].emit("open");
  SocketBoundary.instances[0].message(exampleObserverWelcome);
  expect(f.client.observerState().state).toBe("connected");
});

it.each([401, 403])("retains current handshake %s behavior", async (statusCode) => {
  const statuses = vi.fn();
  const f = fixture(() => exampleHumanDeviceToken);
  f.client.startObserver({ onStatus: statuses });
  await flush();
  SocketBoundary.instances[0].rejectHandshake(statusCode);
  if (statusCode === 401) {
    expect(f.client.observerState()).toEqual({
      state: "auth_expired",
      code: "collaboration_observer_http_401"
    });
    expect(f.timers.size).toBe(0);
  } else {
    expect(
      statuses.mock.calls.some(
        ([status]) => status.state === "failed" && status.code === "collaboration_observer_http_403"
      )
    ).toBe(true);
    expect(f.timers.size).toBe(1);
  }
});

it("stops before token lookup if the connecting callback tears down the owner", async () => {
  const credential = vi.fn(() => exampleHumanDeviceToken);
  const f = fixture(credential);
  f.client.startObserver({
    onStatus: (status) => {
      if (status.state === "connecting") f.client.stopObserver();
    }
  });
  await flush();
  expect(credential).not.toHaveBeenCalled();
  expect(SocketBoundary.instances).toHaveLength(0);
});

it("closes a newly constructed socket if construction disposed the owner", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  SocketBoundary.constructed = () => f.client.dispose();
  f.client.startObserver();
  await flush();
  expect(SocketBoundary.instances[0].close).toHaveBeenCalledOnce();
  SocketBoundary.instances[0].emit("open");
  expect(SocketBoundary.instances[0].send).not.toHaveBeenCalled();
  expect(f.client.observerState().state).toBe("stopped");
});

it("does not arm a reconnect after its status callback stops the observer", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  f.client.startObserver({
    onStatus: (status) => {
      if (status.state === "reconnecting") f.client.stopObserver();
    }
  });
  await flush();
  SocketBoundary.instances[0].emit("close");
  expect(f.timers.size).toBe(0);
  expect(f.client.observerState().state).toBe("stopped");
});

it("does not deliver old catchup or auth callbacks to a replacement started by status", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  const newCatchup = vi.fn();
  const newAuth = vi.fn();
  f.client.startObserver({
    onStatus: (status) => {
      if (status.state === "catching_up")
        f.client.startObserver({ onCatchupRequired: newCatchup, onAuthExpired: newAuth });
    }
  });
  await flush();
  const old = SocketBoundary.instances[0];
  old.message(exampleObserverCatchupRequired);
  await flush();
  expect(newCatchup).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalledOnce();
  const replacement = SocketBoundary.instances[1];
  replacement.emit("open");
  replacement.message(exampleObserverWelcome);
  old.message({
    type: "human.observer.auth_expired",
    protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
    code: "human_device_revoked"
  });
  expect(newAuth).not.toHaveBeenCalled();
  expect(replacement.close).not.toHaveBeenCalled();
});

it("keeps a replacement alive when auth-expired status synchronously starts it", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  const oldAuth = vi.fn();
  f.client.startObserver({
    onStatus: (status) => {
      if (status.state === "auth_expired") f.client.startObserver();
    },
    onAuthExpired: oldAuth
  });
  await flush();
  const old = SocketBoundary.instances[0];
  old.message({
    type: "human.observer.auth_expired",
    protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
    code: "human_device_revoked"
  });
  await flush();
  const current = SocketBoundary.instances[1];
  current.emit("open");
  current.message(exampleObserverWelcome);
  expect(oldAuth).not.toHaveBeenCalled();
  expect(current.close).not.toHaveBeenCalled();
  expect(f.client.observerState().state).toBe("connected");
});

it("does not detach a replacement created inside failed-handshake status", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  f.client.startObserver({
    onStatus: (status) => {
      if (status.state === "failed") f.client.startObserver();
    }
  });
  await flush();
  SocketBoundary.instances[0].rejectHandshake(403);
  await flush();
  const current = SocketBoundary.instances[1];
  current.emit("open");
  current.message(exampleObserverWelcome);
  expect(f.client.observerState().state).toBe("connected");
  expect(f.timers.size).toBe(0);
});

it("ignores a cleared old reconnect timer after a later start", async () => {
  const f = fixture(() => exampleHumanDeviceToken);
  f.client.startObserver();
  await flush();
  SocketBoundary.instances[0].emit("close");
  const oldTimer = [...f.timers][0];
  f.client.stopObserver();
  f.client.startObserver();
  await flush();
  oldTimer();
  await flush();
  expect(SocketBoundary.instances).toHaveLength(2);
  expect(f.timers.size).toBe(0);
});

it("replaces a pending repeated start instead of allowing two authenticated sockets", async () => {
  const pending = deferred<string | undefined>();
  let calls = 0;
  const f = fixture(() => (++calls === 1 ? pending.promise : exampleHumanDeviceToken));
  f.client.startObserver();
  f.client.startObserver({}, { cursor: 9 });
  await flush();
  pending.resolve(exampleHumanDeviceToken);
  await flush();
  expect(SocketBoundary.instances).toHaveLength(1);
  SocketBoundary.instances[0].emit("open");
  expect(JSON.parse(SocketBoundary.instances[0].send.mock.calls[0][0]).lastCursor).toBe(9);
});
