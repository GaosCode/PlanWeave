import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createTransportAdmissionPolicyForMode } from "../insecureTransport.js";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import { createCanvasCollaborationComposition } from "../canvas/collaborationComposition.js";
import { readStableCanvasContentFingerprint } from "../canvas/contentFingerprint.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import {
  actor,
  canvasCommandServiceFixture as fixture
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;

describe("Runtime invalidation composition", () => {
  it("wires initial imports through the standalone Canvas composition", async () => {
    const context = await fixture();
    const fingerprint = readStableCanvasContentFingerprint(context.contentVersions, scope);
    if (!fingerprint) throw new Error("test_content_fingerprint_missing");
    const httpServer = createServer();
    const upgradeRouter = new WebSocketUpgradeRouter(httpServer);
    const observerJournal = new HumanObserverJournal(context.database, 100);
    const composition = await createCanvasCollaborationComposition({
      database: context.database,
      upgradeRouter,
      identity: new HumanIdentityRepository(context.database),
      workspaceIdentity: new WorkspaceIdentityRepository(context.database),
      projectAccess: context.access,
      collaborationScopeAuthority: { hasProject: () => true, hasScope: () => true },
      authorizationChanges: new AuthorizationChangeSignal(),
      runtimeAttachments: [],
      initialContentCapture: {
        async captureInitialContent() {
          throw new Error("initial_capture_should_not_run");
        }
      },
      runtimeAvailability: {
        async readAvailability() {
          return {
            schemaVersion: "canvas-runtime-availability/v1",
            kind: "unavailable",
            reason: "runtime_not_attached"
          };
        }
      },
      observerJournal,
      transportAdmission: createTransportAdmissionPolicyForMode("loopback_http"),
      maxPayloadBytes: 64 * 1024,
      shutdownTimeoutMs: 1_000,
      clock: () => new Date("2026-08-22T00:00:00.000Z")
    });

    try {
      composition.runtimeAvailabilityService.importInitial(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: {
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: fingerprint,
            capturedAt: "2026-08-22T00:00:00.000Z",
            tasks: [],
            blocks: []
          }
        }
      });

      expect(
        context.database
          .prepare("SELECT event_json FROM human_observer_events ORDER BY cursor")
          .all()
          .map((row) => JSON.parse(String(row.event_json)))
      ).toContainEqual({ kind: "runtime", canvasId: "default", runtimeRevision: 1 });
    } finally {
      await composition.operationRetentionMaintenance.close();
      await composition.commandWebSockets.close();
      await composition.liveSyncWebSockets.close();
      await composition.presenceWebSockets.close();
      upgradeRouter.close();
      httpServer.close();
    }
  });
});
