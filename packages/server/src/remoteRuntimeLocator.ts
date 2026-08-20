import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { canonicalRemoteRuntimePort } from "./canonicalRemoteRuntimePort.js";
import type { CanvasExecutionRuntimeLeasePort } from "./canvas/executionRuntimePort.js";
import type { RemoteRuntimeLocator } from "./remoteBlockCoordinatorPorts.js";

function locatorKey(locator: RemoteRuntimeLocator): string {
  const workspaceId = workspaceIdSchema.safeParse(locator.workspaceId);
  if (!workspaceId.success) throw new Error("remote_runtime_workspace_required");
  return `${workspaceId.data}\0${locator.projectId}\0${locator.canvasId}`;
}

export type ScopedRemoteRuntimeBinding = {
  runtime: RemoteBlockRuntimePort;
  artifacts: RemoteBlockArtifactSource;
  release(): void | Promise<void>;
};

type ScopedRemoteRuntimeResolver = (
  locator: RemoteRuntimeLocator
) => ScopedRemoteRuntimeBinding | Promise<ScopedRemoteRuntimeBinding>;

export class RemoteRuntimePortRegistry implements CanvasExecutionRuntimeLeasePort {
  private readonly ports = new Map<
    string,
    { runtime: RemoteBlockRuntimePort; artifacts?: RemoteBlockArtifactSource }
  >();
  private scopedResolver: ScopedRemoteRuntimeResolver | undefined;

  setScopedResolver(resolver: ScopedRemoteRuntimeResolver): void {
    this.scopedResolver = resolver;
  }

  bind(
    locator: RemoteRuntimeLocator,
    runtime: RemoteBlockRuntimePort,
    artifacts?: RemoteBlockArtifactSource
  ): () => void {
    const key = locatorKey(locator);
    if (this.ports.has(key)) throw new Error("remote_runtime_locator_already_bound");
    const binding = {
      runtime: canonicalRemoteRuntimePort(runtime, locator.workspaceId),
      artifacts
    };
    this.ports.set(key, binding);
    return () => {
      if (this.ports.get(key) === binding) this.ports.delete(key);
    };
  }

  resolve(locator: RemoteRuntimeLocator): RemoteBlockRuntimePort {
    const binding = this.bindingFor(locator);
    if (!binding) {
      throw new Error(`remote_runtime_locator_unresolved:${locator.projectId}:${locator.canvasId}`);
    }
    return binding.runtime;
  }

  /** Acquire one request-scoped binding. An installed scoped resolver is authoritative. */
  async acquire(locator: RemoteRuntimeLocator): Promise<ScopedRemoteRuntimeBinding> {
    if (this.scopedResolver) {
      const binding = await this.scopedResolver(locator);
      return runtimeHandle(binding.runtime, binding.artifacts, binding.release);
    }
    return runtimeHandle(
      this.resolve(locator),
      this.resolveArtifactSource(locator),
      () => undefined
    );
  }

  async acquireArtifactSource(
    locator: RemoteRuntimeLocator
  ): Promise<{ source: RemoteBlockArtifactSource; release(): void | Promise<void> }> {
    if (this.scopedResolver) {
      const binding = await this.scopedResolver(locator);
      return artifactHandle(binding.artifacts, binding.release);
    }
    return artifactHandle(this.resolveArtifactSource(locator), () => undefined);
  }

  resolveArtifactSource(locator: RemoteRuntimeLocator): RemoteBlockArtifactSource {
    const binding = this.bindingFor(locator);
    if (!binding) {
      throw new Error(`remote_runtime_locator_unresolved:${locator.projectId}:${locator.canvasId}`);
    }
    if (!binding.artifacts) {
      throw new Error(
        `remote_runtime_artifact_source_unresolved:${locator.projectId}:${locator.canvasId}`
      );
    }
    return binding.artifacts;
  }

  private bindingFor(
    locator: RemoteRuntimeLocator
  ): { runtime: RemoteBlockRuntimePort; artifacts?: RemoteBlockArtifactSource } | undefined {
    return this.ports.get(locatorKey(locator));
  }
}

function once(releaseBinding: () => void | Promise<void>): () => void | Promise<void> {
  let released = false;
  let releaseResult: void | Promise<void>;
  return () => {
    if (released) return releaseResult;
    released = true;
    releaseResult = releaseBinding();
    return releaseResult;
  };
}

function runtimeHandle(
  runtime: RemoteBlockRuntimePort,
  artifacts: RemoteBlockArtifactSource,
  releaseBinding: () => void | Promise<void>
): ScopedRemoteRuntimeBinding {
  return { runtime, artifacts, release: once(releaseBinding) };
}

function artifactHandle(
  source: RemoteBlockArtifactSource,
  releaseBinding: () => void | Promise<void>
): { source: RemoteBlockArtifactSource; release(): void | Promise<void> } {
  return { source, release: once(releaseBinding) };
}
