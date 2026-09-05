import {
  assertNoSmuggledCollaborationSecrets,
  collaborationCanvasBindingInputSchema
} from "../../shared/collaboration.js";
import {
  workspaceCanvasLocatorSchema,
  type WorkspaceCanvasLocator
} from "../../shared/canvasLocator.js";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection.js";
import { workspaceCanvasPublishResultSchema } from "../../shared/workspaceCanvasSharing.js";
import type { CollaborationCanvasCommandFacade } from "./collaborationCanvasCommands.js";
import type { CanvasRuntimeAvailabilityCoordinator } from "./CanvasRuntimeAvailabilityCoordinator.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";
import { WorkspaceCanvasSession } from "./WorkspaceCanvasSession.js";
import type { WorkspaceAuthoritativeSnapshotCache } from "./WorkspaceAuthoritativeSnapshotCache.js";
import type { WorkspaceRemoteAuthorityKey } from "./WorkspaceRemoteAuthorityIdentity.js";

export type CollaborationCanvasOperationsFacadeOptions = {
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  commands: CollaborationCanvasCommandFacade;
  runtimeAvailability: CanvasRuntimeAvailabilityCoordinator;
  contentVersions: ContentVersionFacade;
  resolveConnectedProfileId: () => string | null;
  resolveSnapshotCacheKey(locator: WorkspaceCanvasLocator): Promise<WorkspaceRemoteAuthorityKey>;
  snapshotCache: Pick<WorkspaceAuthoritativeSnapshotCache, "get">;
  onWorkspaceCanvasProjection?: (projection: WorkspaceCanvasProjection) => void;
};

/** Queue-aware main-process facade for one canvas command/content/runtime surface. */
export class CollaborationCanvasOperationsFacade {
  private readonly workspaceSession: WorkspaceCanvasSession;
  private readonly canvasRuntimeQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CollaborationCanvasOperationsFacadeOptions) {
    this.workspaceSession = new WorkspaceCanvasSession({
      resolveConnectedProfileId: options.resolveConnectedProfileId,
      resolveSnapshotCacheKey: options.resolveSnapshotCacheKey,
      snapshotCache: options.snapshotCache,
      commands: {
        bind: (input) => options.commands.bind(input),
        bindCached: (input) => options.commands.bindCached(input),
        submit: (input, submitOptions) => options.commands.submit(input, submitOptions),
        reconnect: (input) => options.commands.reconnect(input),
        projectionForBinding: (input) => options.commands.projectionForBinding(input),
        session: () => options.commands.session(),
        releaseBinding: () => options.commands.releaseBinding()
      },
      readRuntimeAvailability: (input) =>
        options.runtimeAvailability.readRuntimeAvailability(input),
      initializeRuntime: (input) => options.runtimeAvailability.initializeRuntime(input),
      resetRuntime: (input) => options.runtimeAvailability.resetRuntime(input),
      onProjection: options.onWorkspaceCanvasProjection
    });
  }

  openWorkspaceCanvasSession(input: unknown): Promise<WorkspaceCanvasProjection> {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "openWorkspaceCanvasSession");
      return this.workspaceSession.open(input);
    });
  }

  submitWorkspaceCanvasCommand(input: unknown): Promise<WorkspaceCanvasProjection> {
    let pending: Promise<WorkspaceCanvasProjection>;
    return this.options
      .enqueue(async () => {
        this.options.assertOpen();
        assertNoSmuggledCollaborationSecrets(input, "submitWorkspaceCanvasCommand");
        pending = this.workspaceSession.submit(input);
      })
      .then(() => pending!);
  }

  reconnectWorkspaceCanvasSession(input: unknown): Promise<WorkspaceCanvasProjection> {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "reconnectWorkspaceCanvasSession");
      return this.workspaceSession.reconnect(input);
    });
  }

  closeWorkspaceCanvasSession(input?: unknown): Promise<void> {
    return this.run(() => {
      if (input !== undefined) {
        assertNoSmuggledCollaborationSecrets(input, "closeWorkspaceCanvasSession");
      }
      return this.workspaceSession.close(input);
    });
  }

  getWorkspaceCanvasProjection(): WorkspaceCanvasProjection | null {
    return this.workspaceSession.current();
  }

  publishWorkspaceCanvasProjection(): WorkspaceCanvasProjection | null {
    return this.workspaceSession.publishIfOpen();
  }

  readRuntimeAvailability(input: unknown) {
    return this.runCanvasRuntime(input, () =>
      this.options.runtimeAvailability.readRuntimeAvailability(input)
    );
  }

  resetWorkspaceRuntime(input: unknown) {
    return this.runCanvasRuntime(input, () => {
      assertNoSmuggledCollaborationSecrets(input, "resetWorkspaceCanvasRuntime");
      return this.workspaceSession.resetRuntime(input);
    });
  }

  initializeWorkspaceRuntime(input: unknown) {
    return this.runCanvasRuntime(input, () => {
      assertNoSmuggledCollaborationSecrets(input, "initializeWorkspaceCanvasRuntime");
      return this.workspaceSession.initializeRuntime(input);
    });
  }

  listWorkspaceCanvasSharingCandidates() {
    return this.run(() => this.options.contentVersions.listWorkspaceCanvasSharingCandidates());
  }

  publishWorkspaceCanvas(input: unknown) {
    return this.run(async () => {
      assertNoSmuggledCollaborationSecrets(input, "publishWorkspaceCanvas");
      const published = await this.options.contentVersions.publishWorkspaceCanvas(input);
      try {
        await this.workspaceSession.open(published.locator);
        return workspaceCanvasPublishResultSchema.parse({
          ...published,
          authoritySwitch: "opened"
        });
      } catch {
        return workspaceCanvasPublishResultSchema.parse({
          ...published,
          authoritySwitch: "retry_open"
        });
      }
    });
  }

  downloadWorkspaceCanvasFork(input: unknown) {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "downloadWorkspaceCanvasFork");
      return this.options.contentVersions.downloadWorkspaceCanvasFork(input);
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      return operation();
    });
  }

  private runCanvasRuntime<T>(input: unknown, operation: () => Promise<T>): Promise<T> {
    const key = canvasRuntimeQueueKey(input);
    const previous = this.canvasRuntimeQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.options.assertOpen();
        return operation();
      });
    this.canvasRuntimeQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }
}

function canvasRuntimeQueueKey(input: unknown): string {
  if (input && typeof input === "object" && "locator" in input) {
    const locator = workspaceCanvasLocatorSchema.safeParse((input as { locator: unknown }).locator);
    if (locator.success) {
      return `${locator.data.workspaceId}\u0000${locator.data.projectId}\u0000${locator.data.canvasId}`;
    }
  }
  const binding = collaborationCanvasBindingInputSchema.parse(input);
  if (binding.kind === "remote") {
    return `${binding.workspaceId}\u0000${binding.projectId}\u0000${binding.canvasId}`;
  }
  return `local\u0000${binding.localProjectId}\u0000${binding.canvasId}`;
}
