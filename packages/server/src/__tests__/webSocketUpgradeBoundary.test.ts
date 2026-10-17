import { describe, expect, it } from "vitest";
import { setupUpgradeBoundary } from "./support/webSocketUpgradeBoundaryHarness.js";

type Fixture = Awaited<ReturnType<typeof setupUpgradeBoundary>>;

async function healthy(fixture: Fixture) {
  const response = await fetch(`${fixture.origin}/readyz`, { signal: AbortSignal.timeout(2_000) });
  expect(response.status).toBe(200);
  await expect(fixture.healthyPresence()).resolves.toMatchObject({
    type: "canvas.presence.snapshot",
    sessions: []
  });
  await fixture.checkpoint();
  expect(fixture.child.exitCode, fixture.output()).toBeNull();
  expect(fixture.child.signalCode).toBeNull();
}

function redacted(fixture: Fixture, responses: string[]) {
  for (const text of [fixture.output(), ...responses]) {
    for (const secret of [
      fixture.deviceToken,
      "upgrade-handler-secret",
      "denied-credential-secret",
      fixture.root
    ])
      expect(text).not.toContain(secret);
  }
}

function rejected(response: string, status: number) {
  expect(response).toBe(
    `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : "Internal Server Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
}

describe("real Server WebSocket upgrade boundary", () => {
  it("rejects malformed identifiers before scope parsing and keeps HTTP and presence alive", async () => {
    const fixture = await setupUpgradeBoundary();
    try {
      const responses: string[] = [];
      for (const channel of ["presence", "commands", "live"]) {
        for (const identifier of ["bad%2Fcanvas", "%E0%A4%A", "bad%20canvas"]) {
          const { response } = await fixture.raw(
            `/api/v1/projects/${fixture.projectId}/canvases/${identifier}/human/${channel}`
          );
          rejected(response, 404);
          responses.push(response);
        }
      }
      await healthy(fixture);
      expect(fixture.output()).not.toContain('"event":"upgrade_failed"');
      redacted(fixture, responses);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it("keeps authentication denial and unknown scope distinct from internal failures", async () => {
    const fixture = await setupUpgradeBoundary();
    try {
      const base = `/api/v1/projects/${fixture.projectId}/canvases`;
      const denied = await fixture.raw(
        `${base}/default/human/presence`,
        "denied-credential-secret"
      );
      const unknown = await fixture.raw(`${base}/unknown/human/presence`);
      rejected(denied.response, 401);
      rejected(unknown.response, 403);
      await healthy(fixture);
      expect(fixture.output()).not.toContain('"event":"upgrade_failed"');
      redacted(fixture, [denied.response, unknown.response]);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it.each([
    "presence",
    "commands"
  ])("contains a real %s authentication exception without terminating the process", async (channel) => {
    const fixture = await setupUpgradeBoundary();
    try {
      const { response } = await fixture.raw(
        `/api/v1/projects/${fixture.projectId}/canvases/auth-fault/human/${channel}`
      );
      rejected(response, 500);
      await healthy(fixture);
      expect(fixture.output()).toContain(
        JSON.stringify({ scope: "websocket-upgrade", event: "upgrade_failed", phase: "handler" })
      );
      redacted(fixture, [response]);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it.each([
    "matches",
    "sync",
    "async"
  ])("contains a %s route failure on TCP and serves subsequent HTTP and WebSocket traffic", async (kind) => {
    const fixture = await setupUpgradeBoundary();
    try {
      const pending = fixture.raw(`/__upgrade_fault/${kind}`);
      if (kind === "async") {
        await fixture.waitPending();
        fixture.release();
      }
      const { response } = await pending;
      rejected(response, 500);
      await healthy(fixture);
      expect(fixture.output()).toContain(
        JSON.stringify({
          scope: "websocket-upgrade",
          event: "upgrade_failed",
          phase: kind === "matches" ? "matches" : "handler"
        })
      );
      redacted(fixture, [response]);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it("closes a real completed handshake on callback failure without appending an HTTP error", async () => {
    const fixture = await setupUpgradeBoundary();
    try {
      const { response } = await fixture.raw("/__upgrade_fault/handshake");
      expect(response).toContain("HTTP/1.1 101 Switching Protocols\r\n");
      expect(response.match(/HTTP\/1\.1/g)).toHaveLength(1);
      expect(response).not.toContain("500");
      await healthy(fixture);
      expect(fixture.output()).toContain('"event":"upgrade_failed"');
      redacted(fixture, [response]);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });
});
