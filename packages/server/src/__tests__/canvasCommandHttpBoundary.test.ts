import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { routeCanvasCommandHttp } from "../canvas/index.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command service (OSS-004 B-002)", () => {
  it("rejects forbidden shared-mode features and ignores presence as mutation authority", async () => {
    const request = { method: "POST" } as IncomingMessage;
    for (const path of [
      "/api/v1/projects/p/upload",
      "/api/v1/projects/p/download",
      "/api/v1/projects/p/sync",
      "/api/v1/projects/p/fs/watch",
      "/api/v1/projects/p/directory",
      "/api/v1/billing/checkout",
      "/api/v1/subscription/status",
      "/api/v1/license/activate",
      "/api/v1/ssh/open",
      "/api/v1/vps/provision"
    ]) {
      expect(routeCanvasCommandHttp(request, path)?.kind, path).toBe("forbidden_feature");
    }
    expect(
      routeCanvasCommandHttp(request, "/api/v1/projects/p/canvases/default/commands")?.kind
    ).toBe("command");
    expect(
      routeCanvasCommandHttp(request, "/api/v1/projects/p/canvases/default/reconnect")?.kind
    ).toBe("reconnect");
    expect(
      routeCanvasCommandHttp(
        { method: "GET" } as IncomingMessage,
        "/api/v1/projects/p/canvases/default/runtime-status"
      )
    ).toBeUndefined();
    expect(
      routeCanvasCommandHttp(
        { method: "GET" } as IncomingMessage,
        "/api/v1/projects/p/canvases/default/runtime-availability"
      )?.kind
    ).toBe("runtime_availability");
    for (const [method, path] of [
      ["GET", "/api/v1/projects/p/canvases/default/commands/runtime-availability"],
      ["GET", "/api/v1/projects/p/canvases/default/runtime-availability/extra"],
      ["GET", "/api/v1/projects/p/canvases/default/commands"],
      ["POST", "/api/v1/projects/p/canvases/default/runtime-availability"]
    ] as const) {
      expect(
        routeCanvasCommandHttp({ method } as IncomingMessage, path),
        `${method} ${path}`
      ).toBeUndefined();
    }

    const { service } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-presence", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    if (accepted.type === "canvas.command.accepted") {
      // presenceHeadProbe returns 999; CAS revision must stay authoritative.
      expect(accepted.revision).toBe(1);
      expect(accepted.revision).not.toBe(999);
    }
  });

  it("keeps the removed runtime-status error namespace out of the HTTP handler", async () => {
    const source = await readFile(new URL("../canvas/http.ts", import.meta.url), "utf8");

    expect(source).not.toContain("canvas_runtime_status_");
  });

  it("serves reconnect snapshots from the content head rather than digest-only snapshot rows", async () => {
    const { service, repository } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-snap-1", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const head = repository.head(scope);
    repository.markSnapshotCorrupt(scope, head.revision);

    const response = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    // Retention may still return delta for afterRevision 0; force gap path.
    const forced = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 99
    });
    expect(forced.type).toBe("canvas.reconnect.snapshot");
    if (forced.type === "canvas.reconnect.snapshot") {
      expect(forced.snapshot.content.canonicalDigest).toBe(head.contentDigest);
    }
    void response;
  });

  it("keeps presence probe independent under concurrent command load", async () => {
    const { service } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.submit(
          actor("owner"),
          submitBody(`op-presence-load-${index}`, 0, {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: `# presence load ${index}\n`
          })
        )
      )
    );
    const accepted = results.filter((item) => item.type === "canvas.command.accepted");
    const rejected = results.filter((item) => item.type === "canvas.command.rejected");
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length + rejected.length).toBe(8);
    for (const item of accepted) {
      if (item.type === "canvas.command.accepted") {
        // presenceHeadProbe returns 999; durable revision never uses presence.
        expect(item.revision).not.toBe(999);
        expect(item.revision).toBeGreaterThanOrEqual(1);
      }
    }
    for (const item of rejected) {
      if (item.type === "canvas.command.rejected") {
        expect(["stale_revision", "operation_conflict"]).toContain(item.code);
      }
    }
  });
});
