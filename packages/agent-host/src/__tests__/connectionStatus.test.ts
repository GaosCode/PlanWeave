import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostConnectionStatusPath,
  readHostConnectionStatus,
  serializeHostTransportStatus,
  writeHostConnectionStatus
} from "../transport/connectionStatus.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Host connection status file", () => {
  it("round-trips transport states through connection-status.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-host-connection-status-"));
    roots.push(root);

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
        retryAt: "2030-01-01T00:00:03.000Z"
      },
      new Date("2030-01-01T00:00:02.000Z")
    );
    await expect(readHostConnectionStatus(root)).resolves.toMatchObject({
      transport: {
        state: "backing-off",
        attempt: 2,
        delayMs: 1_500,
        retryAt: "2030-01-01T00:00:03.000Z"
      }
    });
  });

  it("returns null for missing or invalid status files", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-host-connection-status-missing-"));
    roots.push(root);
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
