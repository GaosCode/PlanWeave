import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";

const boundary = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  detachOperator: vi.fn()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}));
vi.mock("../main/collaboration/CollaborationCoordinatorControl.js", () => ({
  LocalCollaborationCoordinatorControl: class {
    restore = async () => undefined;
    stop = boundary.stop;
  }
}));
vi.mock("../main/operatorControl/localOperatorBackend.js", () => ({
  setLocalOperatorBackendPort: boundary.detachOperator
}));
vi.mock("../main/operatorControl/operatorControlHandlers.js", () => ({
  getOperatorControlService: vi.fn()
}));
vi.mock("../main/collaboration/persistedDesktopServerConnection.js", () => ({
  restorePersistedDesktopServerConnection: async () => undefined
}));

import {
  registerCollaborationHandlers,
  shutdownCollaborationHandlers
} from "../main/collaboration/collaborationHandlers.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  boundary.stop.mockReset();
  boundary.stop.mockResolvedValue(undefined);
  boundary.detachOperator.mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("collaboration snapshot shutdown", () => {
  it.each([
    false,
    true
  ])("detaches and stops the coordinator after persistence fails (stop also fails: %s)", async (stopFails) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-snapshot-shutdown-"));
    directories.push(directory);
    const cache = new WorkspaceAuthoritativeSnapshotCache(join(directory, "snapshots"));
    const service = registerCollaborationHandlers({
      profileStorePaths: { profilesPath: join(directory, "profiles.json") },
      workspaceProfileStorePaths: { profilesPath: join(directory, "workspace-profiles.json") },
      credentialsPath: join(directory, "credentials.json"),
      invitationsPath: join(directory, "invitations.json"),
      exportedIdentityPath: join(directory, "identity.json"),
      coordinatorCredentialsPath: join(directory, "coordinator.json"),
      workspaceSnapshotCache: cache,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      }
    });
    const persistenceFailure = new Error("snapshot_persistence_failed");
    const coordinatorFailure = new Error("coordinator_stop_failed");
    vi.spyOn(service, "shutdown").mockRejectedValueOnce(persistenceFailure);
    if (stopFails) boundary.stop.mockRejectedValueOnce(coordinatorFailure);
    if (stopFails) {
      await expect(shutdownCollaborationHandlers()).rejects.toMatchObject({
        errors: [persistenceFailure, coordinatorFailure]
      });
    } else {
      await expect(shutdownCollaborationHandlers()).rejects.toBe(persistenceFailure);
    }
    expect(boundary.stop).toHaveBeenCalledOnce();
    expect(boundary.detachOperator).toHaveBeenCalledWith(null);
    await shutdownCollaborationHandlers();
    expect(boundary.stop).toHaveBeenCalledOnce();
  });
});
