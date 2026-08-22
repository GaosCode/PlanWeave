import { assertNoSmuggledCollaborationSecrets } from "../../shared/collaboration.js";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection.js";
import { workspaceCanvasPublishResultSchema } from "../../shared/workspaceCanvasSharing.js";
import type {
  CollaborationCanvasCommandFacade,
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasCommandSubmitResult,
  CollaborationCanvasReconnectResult
} from "./collaborationCanvasCommands.js";
import type { CanvasRuntimeAvailabilityCoordinator } from "./CanvasRuntimeAvailabilityCoordinator.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";
import { WorkspaceCanvasSession } from "./WorkspaceCanvasSession.js";

export type CollaborationCanvasOperationsFacadeOptions = {
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  commands: CollaborationCanvasCommandFacade;
  runtimeAvailability: CanvasRuntimeAvailabilityCoordinator;
  contentVersions: ContentVersionFacade;
  resolveConnectedProfileId: () => string | null;
  onWorkspaceCanvasProjection?: (projection: WorkspaceCanvasProjection) => void;
};

/** Queue-aware main-process facade for one canvas command/content/runtime surface. */
export class CollaborationCanvasOperationsFacade {
  private readonly workspaceSession: WorkspaceCanvasSession;

  constructor(private readonly options: CollaborationCanvasOperationsFacadeOptions) {
    this.workspaceSession = new WorkspaceCanvasSession({
      resolveConnectedProfileId: options.resolveConnectedProfileId,
      commands: {
        bind: (input) => options.commands.bind(input),
        submit: (input, submitOptions) => options.commands.submit(input, submitOptions),
        reconnect: (input) => options.commands.reconnect(input),
        projectionForBinding: (input) => options.commands.projectionForBinding(input),
        session: () => options.commands.session(),
        releaseBinding: () => options.commands.releaseBinding()
      },
      onProjection: options.onWorkspaceCanvasProjection
    });
  }

  async submitCommand(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    let pending: Promise<CollaborationCanvasCommandSubmitResult>;
    await this.options.enqueue(async () => {
      this.options.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "submitCollaborationCanvasCommand");
      pending = this.options.commands.submit(input);
    });
    return pending!;
  }

  reconnect(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "reconnectCollaborationCanvas");
      return this.options.commands.reconnect(input);
    });
  }

  bindCommandSession(input: unknown): Promise<CollaborationCanvasCommandSessionView> {
    return this.run(() => this.options.commands.bind(input));
  }

  getCommandSession(): Promise<CollaborationCanvasCommandSessionView> {
    return this.run(async () => this.options.commands.session());
  }

  flushReplicaMaterialization(): Promise<void> {
    return this.run(() => this.options.commands.flushMaterialization());
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

  resolveScope(input: unknown) {
    return this.run(() => this.options.runtimeAvailability.resolveCanvasScope(input));
  }

  readRuntimeAvailability(input: unknown) {
    return this.run(() => this.options.runtimeAvailability.readRuntimeAvailability(input));
  }

  importLocalRuntimeStatus(input: unknown) {
    return this.run(() => this.options.runtimeAvailability.importLocalRuntimeStatus(input));
  }

  getReplicaProjection(input: unknown) {
    return this.run(() => this.options.runtimeAvailability.getReplicaProjection(input));
  }

  bindContentAuthority(input: unknown) {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "bindCollaborationCanvasBindingContentAuthority");
      return this.options.contentVersions.bind(input);
    });
  }

  getContentAuthority() {
    return this.run(async () => this.options.contentVersions.read());
  }

  refreshContentAuthority() {
    return this.run(() => this.options.contentVersions.refresh());
  }

  publishInitialContent() {
    return this.run(() => this.options.contentVersions.publishInitial());
  }

  materializeContentHead() {
    return this.run(() => this.options.contentVersions.materializeHead());
  }

  listContentBootstrapCandidates() {
    return this.run(() => this.options.contentVersions.listBootstrapCandidates());
  }

  bootstrapContent(input: unknown) {
    return this.run(() => {
      assertNoSmuggledCollaborationSecrets(input, "bootstrapCollaborationContent");
      return this.options.contentVersions.bootstrap(input);
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
}
