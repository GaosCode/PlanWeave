import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  LocalCanvasCommandMaterializer,
  type LocalCanvasCommandBinding
} from "./LocalCanvasCommandMaterializer.js";
import type { CanvasReplicaCommittedSnapshot, CanvasReplicaScope } from "./CanvasReplicaStore.js";

type LocalCanvasReplicaScope = Extract<CanvasReplicaScope, { bindingKind: "local" }>;

type CanvasReplicaMaterializerPort = Pick<
  LocalCanvasCommandMaterializer,
  "bind" | "materializeConfirmed"
>;

type CanvasReplicaDiskBinding = {
  scope: LocalCanvasReplicaScope;
  local: Promise<LocalCanvasCommandBinding>;
};

function sameScope(left: LocalCanvasReplicaScope, right: CanvasReplicaScope): boolean {
  return (
    right.bindingKind === "local" &&
    left.authorityId === right.authorityId &&
    left.localProjectId === right.localProjectId &&
    left.localCanvasId === right.localCanvasId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/**
 * Serializes server-confirmed replica snapshots to the imported local canvas.
 * Optimistic state never crosses this boundary and online command success never waits on disk I/O.
 */
export class CanvasReplicaDiskMirror {
  private binding: CanvasReplicaDiskBinding | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending: {
    generation: number;
    binding: CanvasReplicaDiskBinding;
    input: { content: CompleteContentVersion; contentDigest: string };
  } | null = null;
  private drainQueued = false;
  private lastError: unknown = null;

  constructor(
    private readonly materializer: CanvasReplicaMaterializerPort = new LocalCanvasCommandMaterializer()
  ) {}

  async bind(scope: LocalCanvasReplicaScope): Promise<void> {
    const generation = ++this.generation;
    this.pending = null;
    this.binding = null;
    this.lastError = null;
    const previous = this.tail;
    const local = previous.then(() =>
      this.materializer.bind({
        projectId: scope.localProjectId,
        canvasId: scope.localCanvasId,
        authorityProjectId: scope.projectId
      })
    );
    const binding = { scope, local };
    this.tail = local.then(
      () => {
        if (generation === this.generation) this.binding = binding;
      },
      (error) => {
        if (generation === this.generation) this.lastError = error;
      }
    );
    await this.tail;
    if (generation === this.generation && this.lastError) throw this.lastError;
  }

  capture(snapshot: CanvasReplicaCommittedSnapshot): void {
    const binding = this.binding;
    if (!binding || !sameScope(binding.scope, snapshot.scope)) return;
    this.pending = {
      generation: this.generation,
      binding,
      input: { content: snapshot.content, contentDigest: snapshot.contentDigest }
    };
    this.queueDrain();
  }

  async flush(): Promise<void> {
    while (true) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail && !this.pending) break;
    }
    if (this.lastError) throw this.lastError;
  }

  clear(): void {
    this.generation += 1;
    this.pending = null;
    this.binding = null;
  }

  private queueDrain(): void {
    if (this.drainQueued) return;
    this.drainQueued = true;
    this.tail = this.tail.then(async () => {
      try {
        while (this.pending) {
          const next = this.pending;
          this.pending = null;
          if (next.generation !== this.generation || this.binding !== next.binding) {
            continue;
          }
          try {
            await this.materializer.materializeConfirmed(await next.binding.local, next.input);
            if (next.generation === this.generation) this.lastError = null;
          } catch (error) {
            if (next.generation === this.generation) this.lastError = error;
          }
        }
      } finally {
        this.drainQueued = false;
        if (this.pending) this.queueDrain();
      }
    });
  }
}
