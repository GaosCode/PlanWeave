import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeAgentHost } from "../composition/agentHostComposition.js";
import { AgentHostOperator } from "../operator/agentHostOperator.js";
import type { HostTransportStatusListener } from "../transport/hostTransport.js";
import {
  createHostConnectionStatusPublisher,
  hostConnectionStatusDocumentSchema,
  hostConnectionStatusPath,
  readHostConnectionStatus,
  serializeHostTransportStatus,
  writeHostConnectionStatus
} from "../transport/connectionStatus.js";
import { deferred } from "./support/hostTransportSocketHarness.js";

const persistence = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined
}));

vi.mock("node:fs/promises", async (importActual) => {
  const fs = await importActual<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      await persistence.beforeRename?.(from, to);
      await fs.rename(from, to);
    }
  };
});

const roots: string[] = [];
const connectedAt = "2030-01-01T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-host-connection-status-"));
  roots.push(root);
  return root;
}

describe("Agent Host connection status during shutdown", () => {
  it.each([
    "delayed",
    "denied",
    "timed out"
  ] as const)("settles a %s final status at the daemon lifecycle boundary", async (outcome) => {
    const root = await temporaryRoot();
    const publisher = createHostConnectionStatusPublisher(root);
    const entered = deferred<void>();
    const release = deferred<void>();
    const listeners = new Set<HostTransportStatusListener>();
    const publish = (state: "connected" | "stopped") => {
      for (const listener of listeners) {
        listener(state === "connected" ? { state, connectedAt } : { state });
      }
    };
    const state = { close: vi.fn() };
    const closeError = new Error("test state close failure");
    if (outcome === "denied")
      state.close.mockImplementation(() => {
        throw closeError;
      });
    const closeResources = vi.fn();
    const transport = {
      start: () => publish("connected"),
      stop: vi.fn(() => publish("stopped")),
      subscribe(listener: HostTransportStatusListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    const composition = composeAgentHost({
      state,
      transport,
      closeResources,
      statusPublisher: publisher
    });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    await composition.start();
    await publisher.flush();
    expect((await readHostConnectionStatus(root))?.transport.state).toBe("connected");
    persistence.beforeRename = async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "denied")
        throw Object.assign(new Error("test disk denial"), { code: "EACCES" });
    };
    if (outcome === "timed out") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = composition.shutdown();
    expect(composition.shutdown()).toBe(stopping);
    const settled = stopping.then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await entered.promise;
      expect(listeners.size).toBe(0);
      expect(state.close).not.toHaveBeenCalled();
      expect(closeResources).not.toHaveBeenCalled();
      expect((await readHostConnectionStatus(root))?.transport.state).toBe("connected");
      if (outcome === "timed out") {
        await vi.runOnlyPendingTimersAsync();
        const error = await settled;
        expect(error).toMatchObject({
          message: "agent_host_shutdown_requires_process_exit",
          cause: { message: "agent_host_connection_status_shutdown_timeout" }
        });
        expect(state.close).not.toHaveBeenCalled();
        expect(closeResources).not.toHaveBeenCalled();
        await expect(composition.start()).rejects.toThrow(
          "agent_host_composition_already_shutdown"
        );
      }
    } finally {
      release.resolve();
      await publisher.flush().catch((error: unknown) => {
        if (outcome !== "denied") throw error;
      });
      await settled;
    }
    expect(transport.stop).toHaveBeenCalledOnce();
    if (outcome === "timed out") return;
    expect(state.close).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
    if (outcome === "denied") {
      expect(await settled).toMatchObject({
        message: "agent_host_composition_shutdown_failed",
        errors: [
          { message: "agent_host_connection_status_write_failed: stopped (EACCES)" },
          closeError
        ]
      });
      expect(warn).toHaveBeenCalledWith("stopped (EACCES)", {
        code: "agent_host_connection_status_write_failed"
      });
    } else {
      await stopping;
      expect((await readHostConnectionStatus(root))?.transport).toEqual({ state: "stopped" });
    }
  });

  it("allows a fresh daemon to own the same directory after startup or settled write failure", async () => {
    const root = await temporaryRoot();
    const dataDirectory = join(root, "data");
    const statePath = join(dataDirectory, "state.sqlite");
    const configPath = join(root, "config.json");
    const now = Date.now();
    await mkdir(dataDirectory, { mode: 0o700 });
    await writeFile(
      join(dataDirectory, "credentials.json"),
      JSON.stringify({
        version: "agent-host-credentials/v1",
        active: {
          hostId: "host-status-ownership",
          credentialToken: `pw_host_${"A".repeat(43)}`,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString()
        }
      }),
      { mode: 0o600 }
    );
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:1", allowInsecureDevelopment: true },
        dataDirectory,
        workspaceRoot: root,
        host: { displayName: "QA Host", capacity: 1, capabilities: [] },
        workspaces: [],
        agentProfiles: []
      })
    );
    const operator = new AgentHostOperator(null);
    await mkdir(statePath);
    await expect(operator.createDaemon(configPath)).rejects.toThrow();
    await rmdir(statePath);

    const first = await operator.createDaemon(configPath);
    try {
      await expect(new AgentHostOperator(null).createDaemon(configPath)).rejects.toThrow(
        "agent_host_daemon_already_active"
      );
      vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const statusPath = hostConnectionStatusPath(await realpath(dataDirectory));
      persistence.beforeRename = async (_from, to) => {
        if (to === statusPath) {
          throw Object.assign(new Error("test disk denial"), { code: "EACCES" });
        }
      };
      await first.start();
      await expect(first.shutdown()).rejects.toMatchObject({
        errors: [{ message: "agent_host_connection_status_write_failed: stopped (EACCES)" }]
      });
    } finally {
      await first.shutdown().catch((error: unknown) => {
        if (
          !(error instanceof AggregateError) ||
          error.message !== "agent_host_composition_shutdown_failed"
        ) {
          throw error;
        }
      });
    }

    persistence.beforeRename = undefined;
    const replacement = await operator.createDaemon(configPath);
    await replacement.start();
    await replacement.shutdown();
    expect((await readHostConnectionStatus(dataDirectory))?.transport).toEqual({
      state: "stopped"
    });
  });
});

afterEach(async () => {
  persistence.beforeRename = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Host connection status file", () => {
  it("round-trips transport states through connection-status.json", async () => {
    const root = await temporaryRoot();

    const connected = await writeHostConnectionStatus(
      root,
      { state: "connected", connectedAt: "2030-01-01T00:00:00.000Z" },
      new Date("2030-01-01T00:00:01.000Z")
    );
    expect(connected).toEqual({
      version: "agent-host-connection-status/v1",
      updatedAt: "2030-01-01T00:00:01.000Z",
      transport: { state: "connected", connectedAt: "2030-01-01T00:00:00.000Z" }
    });
    await expect(readHostConnectionStatus(root)).resolves.toEqual(connected);
    expect(hostConnectionStatusPath(root)).toBe(join(root, "connection-status.json"));

    await writeHostConnectionStatus(
      root,
      {
        state: "backing-off",
        attempt: 2,
        delayMs: 1_500,
        retryAt: "2030-01-01T00:00:03.000Z",
        reason: "upgrade_http_503"
      },
      new Date("2030-01-01T00:00:02.000Z")
    );
    await expect(readHostConnectionStatus(root)).resolves.toMatchObject({
      transport: {
        state: "backing-off",
        attempt: 2,
        delayMs: 1_500,
        retryAt: "2030-01-01T00:00:03.000Z",
        reason: "upgrade_http_503"
      }
    });
  });

  it("returns null for missing or invalid status files", async () => {
    const root = await temporaryRoot();
    await expect(readHostConnectionStatus(root)).resolves.toBeNull();
  });

  it("serializes every transport state without leaking unexpected fields", () => {
    expect(serializeHostTransportStatus({ state: "connecting", attempt: 1 })).toEqual({
      state: "connecting",
      attempt: 1
    });
    expect(
      serializeHostTransportStatus({ state: "auth-failed", reason: "credential_revoked" })
    ).toEqual({
      state: "auth-failed",
      reason: "credential_revoked"
    });
    expect(serializeHostTransportStatus({ state: "stopped" })).toEqual({ state: "stopped" });
    expect(
      serializeHostTransportStatus({
        state: "reconciliation-required",
        reason: "mailbox_message_retention_horizon_exceeded"
      })
    ).toEqual({
      state: "reconciliation-required",
      reason: "mailbox_message_retention_horizon_exceeded"
    });
    expect(
      serializeHostTransportStatus({ state: "degraded", reason: "heartbeat_timeout" })
    ).toEqual({
      state: "degraded",
      reason: "heartbeat_timeout"
    });
  });
});

describe("Agent Host connection status publisher", () => {
  it("serializes a burst into the first and latest writes across a wall-clock rollback", async () => {
    const [root, otherRoot] = await Promise.all([temporaryRoot(), temporaryRoot()]);
    await writeHostConnectionStatus(root, { state: "connected", connectedAt });
    const publisher = createHostConnectionStatusPublisher(root);
    const otherPublisher = createHostConnectionStatusPublisher(otherRoot);
    const blocked = deferred<void>();
    const release = deferred<void>();
    const renames: string[] = [];
    persistence.beforeRename = async (from, to) => {
      if (to !== hostConnectionStatusPath(root)) return;
      const document = hostConnectionStatusDocumentSchema.parse(
        JSON.parse(await readFile(from, "utf8"))
      );
      renames.push(document.transport.state);
      if (document.transport.state === "connecting") {
        blocked.resolve();
        await release.promise;
      }
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:02.000Z"));
    try {
      publisher.publish({ state: "connecting", attempt: 1 });
      await blocked.promise;
      for (let attempt = 2; attempt <= 100; attempt++) {
        publisher.publish({ state: "connecting", attempt });
      }
      publisher.publish({ state: "connected", connectedAt });
      vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z"));
      publisher.publish({ state: "stopped" });

      otherPublisher.publish({ state: "degraded", reason: "heartbeat_timeout" });
      await otherPublisher.flush();
      expect((await readHostConnectionStatus(otherRoot))?.transport.state).toBe("degraded");
      expect((await readHostConnectionStatus(root))?.transport).toEqual({
        state: "connected",
        connectedAt
      });

      vi.setSystemTime(new Date("2030-01-01T00:00:03.000Z"));
    } finally {
      release.resolve();
      await publisher.flush();
    }

    expect(renames).toEqual(["connecting", "stopped"]);
    await expect(readHostConnectionStatus(root)).resolves.toEqual({
      version: "agent-host-connection-status/v1",
      updatedAt: "2030-01-01T00:00:01.000Z",
      transport: { state: "stopped" }
    });
    if (process.platform !== "win32") {
      expect((await stat(hostConnectionStatusPath(root))).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(root)).toEqual(["connection-status.json"]);
  });

  it("reports a failed latest write, preserves the previous file and recovers on a later event", async () => {
    const root = await temporaryRoot();
    const before = await writeHostConnectionStatus(root, { state: "connected", connectedAt });
    const publisher = createHostConnectionStatusPublisher(root);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const diskFull = Object.assign(new Error("private path"), { code: "ENOSPC" });
    persistence.beforeRename = async () => {
      throw diskFull;
    };

    publisher.publish({ state: "stopped" });
    await expect(publisher.flush()).rejects.toMatchObject({
      message: "agent_host_connection_status_write_failed: stopped (ENOSPC)",
      cause: diskFull
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith("stopped (ENOSPC)", {
      code: "agent_host_connection_status_write_failed"
    });
    await expect(readHostConnectionStatus(root)).resolves.toEqual(before);
    expect(await readdir(root)).toEqual(["connection-status.json"]);

    persistence.beforeRename = undefined;
    publisher.publish({ state: "stopped" });
    await expect(publisher.flush()).resolves.toBeUndefined();
    expect((await readHostConnectionStatus(root))?.transport.state).toBe("stopped");
  });

  it("reports an earlier failed write and still publishes the waiting event", async () => {
    const root = await temporaryRoot();
    const publisher = createHostConnectionStatusPublisher(root);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const blocked = deferred<void>();
    const release = deferred<void>();
    persistence.beforeRename = async () => {
      persistence.beforeRename = undefined;
      blocked.resolve();
      await release.promise;
      throw Object.assign(new Error("private path"), { code: "EACCES" });
    };

    try {
      publisher.publish({ state: "connecting", attempt: 1 });
      await blocked.promise;
      publisher.publish({ state: "connected", connectedAt });
    } finally {
      release.resolve();
      await publisher.flush();
    }

    expect(warning).toHaveBeenCalledExactlyOnceWith("connecting (EACCES)", {
      code: "agent_host_connection_status_write_failed"
    });
    expect((await readHostConnectionStatus(root))?.transport).toEqual({
      state: "connected",
      connectedAt
    });
    expect(await readdir(root)).toEqual(["connection-status.json"]);
  });
});
