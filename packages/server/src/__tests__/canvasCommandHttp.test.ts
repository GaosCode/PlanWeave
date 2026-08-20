import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleCanvasCommandHttpRequest,
  resetCanvasCommandHttpRateLimits
} from "../canvas/http.js";
import { CANVAS_COMMAND_RATE_MAX_REQUESTS } from "../canvas/limits.js";
import { hashHumanToken, mintHumanDeviceToken } from "../identity/crypto.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { canvasCommandServiceFixture } from "./support/canvasCommandServiceFixture.js";
import type { CanvasRuntimeStatusPort } from "../canvas/runtimePort.js";
import type { CanvasRuntimeAvailabilityPort } from "../canvas/runtimePort.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  resetCanvasCommandHttpRateLimits();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function setup(
  clock: () => Date,
  runtime?: CanvasRuntimeStatusPort,
  runtimeAvailability?: CanvasRuntimeAvailabilityPort
) {
  const { service, runtimeAvailabilityService, database } = await canvasCommandServiceFixture({
    runtime,
    runtimeAvailability
  });
  const repository = new HumanIdentityRepository(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const token = mintHumanDeviceToken();
  database
    .prepare(
      `INSERT INTO workspace_device_sessions(
        workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,
        expires_at,revoked_at,last_used_at
      ) VALUES(?,?,?,?,?,?,NULL,NULL)`
    )
    .run(
      "w",
      "device-owner",
      "owner",
      hashHumanToken(token),
      "2026-01-02T00:00:00.000Z",
      "2036-01-02T00:00:00.000Z"
    );
  const collaborationScopeAuthority = {
    hasProject: (projectId: string) => projectId === "p",
    hasScope: (scope: { workspaceId: string; projectId: string; canvasId?: string }) =>
      scope.workspaceId === "w" && scope.projectId === "p" && scope.canvasId === "default"
  };
  const server = createServer((request, response) => {
    void handleCanvasCommandHttpRequest(request, response, {
      service,
      runtimeAvailabilityService,
      repository,
      workspaceIdentity,
      collaborationScopeAuthority,
      transportAdmission: loopbackHttpTransportAdmission,
      clock
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    service
  };
}

describe("canvas command HTTP rate limiting", () => {
  it("authenticates before admission and returns exact Retry-After only for 429", async () => {
    let now = new Date("2026-08-16T00:00:00.000Z");
    const { origin, token } = await setup(() => now);
    const url = `${origin}/api/v1/projects/p/canvases/default/runtime-status`;

    for (let request = 0; request <= CANVAS_COMMAND_RATE_MAX_REQUESTS; request += 1) {
      const unauthenticated = await fetch(url);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.has("retry-after")).toBe(false);
    }

    for (let request = 0; request < CANVAS_COMMAND_RATE_MAX_REQUESTS; request += 1) {
      const allowed = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.has("retry-after")).toBe(false);
    }

    const limited = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");

    now = new Date(now.getTime() + 30_001);
    const limitedMidWindow = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(limitedMidWindow.status).toBe(429);
    expect(limitedMidWindow.headers.get("retry-after")).toBe("30");

    resetCanvasCommandHttpRateLimits();
    const allowedAfterReset = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(allowedAfterReset.status).toBe(200);
    expect(allowedAfterReset.headers.has("retry-after")).toBe(false);
  });
});

describe("canvas runtime status HTTP errors", () => {
  it("maps runtime unavailable to a service-unavailable response", async () => {
    const { origin, token } = await setup(() => new Date("2026-08-16T00:00:00.000Z"), {
      async read() {
        throw new Error("canvas_runtime_unavailable");
      }
    });

    const response = await fetch(`${origin}/api/v1/projects/p/canvases/default/runtime-status`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "canvas_runtime_status_unavailable"
    });
  });
});

describe("canvas runtime availability HTTP", () => {
  it("returns available and runtime_not_attached as schema-valid 200 responses", async () => {
    const available = await setup(() => new Date("2026-08-16T00:00:00.000Z"));
    const availableResponse = await fetch(
      `${available.origin}/api/v1/projects/p/canvases/default/runtime-availability`,
      { headers: { Authorization: `Bearer ${available.token}` } }
    );
    expect(availableResponse.status).toBe(200);
    await expect(availableResponse.json()).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "available"
    });

    const detached = await setup(() => new Date("2026-08-16T00:00:00.000Z"), undefined, {
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        };
      }
    });
    const detachedResponse = await fetch(
      `${detached.origin}/api/v1/projects/p/canvases/default/runtime-availability`,
      { headers: { Authorization: `Bearer ${detached.token}` } }
    );
    expect(detachedResponse.status).toBe(200);
    await expect(detachedResponse.json()).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
  });

  it("returns content_out_of_sync without leaking mismatched Runtime status", async () => {
    const fixture = await setup(() => new Date("2026-08-16T00:00:00.000Z"), undefined, {
      async readAvailability(scope, capturedAt) {
        const graphFingerprint = `pkg-${"c".repeat(64)}`;
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "available",
          sourceRevision: `snapshot:${"d".repeat(64)}`,
          graphFingerprint,
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: graphFingerprint,
            capturedAt: capturedAt ?? "2026-08-16T00:00:00.000Z",
            tasks: [],
            blocks: []
          }
        };
      }
    });
    const response = await fetch(
      `${fixture.origin}/api/v1/projects/p/canvases/default/runtime-availability`,
      { headers: { Authorization: `Bearer ${fixture.token}` } }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "content_out_of_sync"
    });
  });
});
