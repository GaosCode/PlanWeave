import { assertNoSmuggledCollaborationSecrets } from "../../shared/collaboration.js";
import type {
  CollaborationCanvasCommandFacade,
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasCommandSubmitResult,
  CollaborationCanvasReconnectResult
} from "./collaborationCanvasCommands.js";
import type { CanvasRuntimeAvailabilityCoordinator } from "./CanvasRuntimeAvailabilityCoordinator.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";

export type CollaborationCanvasOperationsFacadeOptions = {
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  commands: CollaborationCanvasCommandFacade;
  runtimeAvailability: CanvasRuntimeAvailabilityCoordinator;
  contentVersions: ContentVersionFacade;
};

/** Queue-aware main-process facade for one canvas command/content/runtime surface. */
export class CollaborationCanvasOperationsFacade {
  constructor(private readonly options: CollaborationCanvasOperationsFacadeOptions) {}

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

  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      return operation();
    });
  }
}
