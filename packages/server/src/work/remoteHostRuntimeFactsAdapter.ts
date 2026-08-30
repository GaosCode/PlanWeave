import { canvasRuntimeJsonValueSchema } from "@planweave-ai/agent-host-protocol";
import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema,
  type ResolveWorkItemsResult
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import type { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcError, type CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import type {
  WorkRuntimeFactsLease,
  WorkRuntimeFactsRequest,
  WorkRuntimePackageFactsPort
} from "./runtimePort.js";
import { WorkRuntimeUnavailableError } from "./runtimePort.js";
import { factsLease } from "./runtimeFactsAdapters.js";
import type { CanvasRuntimeContentTarget } from "@planweave-ai/collaboration-protocol/content/version";

const contentDriftErrorCodes = new Set([
  "runtime_canvas_not_found",
  "runtime_project_not_configured",
  "runtime_project_missing",
  "runtime_project_escape",
  "runtime_project_identity_mismatch",
  "work_package_evidence_invalid",
  "runtime_package_location_mismatch"
]);

const deviceUnavailableErrorCodes = new Set([
  "canvas_runtime_host_offline",
  "canvas_runtime_rpc_deadline_exceeded",
  "canvas_runtime_host_disconnected",
  "canvas_runtime_host_superseded",
  "canvas_runtime_host_revoked"
]);

type HostFactsObservation =
  | { kind: "match"; result: ResolveWorkItemsResult }
  | { kind: "content_out_of_sync" }
  | { kind: "host_offline" };

/** Bounded read-only Work facts RPC. It never acquires an execution Runtime lease. */
export class RemoteHostWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker,
    private readonly contentAuthority: {
      read(
        scope: WorkRuntimeFactsRequest["scope"]
      ): { target: CanvasRuntimeContentTarget; sourceRevision: string } | undefined;
    }
  ) {}

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const request = resolveWorkItemsRequestSchema.parse({ workItems: input.workItems });
    const located = this.locator.locateCandidates(input.scope);
    if (located.kind === "unavailable") throw new WorkRuntimeUnavailableError(located.reason);
    const authority = this.contentAuthority.read(input.scope);
    if (!authority) throw new WorkRuntimeUnavailableError("content_out_of_sync");

    const observations = await Promise.all(
      located.hostIds.map((hostId) =>
        this.readHostFacts(hostId, input, request, authority.target, authority.sourceRevision)
      )
    );
    const match = observations.find(
      (observation): observation is Extract<HostFactsObservation, { kind: "match" }> =>
        observation.kind === "match"
    );
    if (match) return factsLease(input, match.result);
    if (observations.some((observation) => observation.kind === "content_out_of_sync")) {
      throw new WorkRuntimeUnavailableError("content_out_of_sync");
    }
    throw new WorkRuntimeUnavailableError("host_offline");
  }

  private async readHostFacts(
    hostId: string,
    input: WorkRuntimeFactsRequest,
    request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>,
    contentTarget: CanvasRuntimeContentTarget,
    sourceRevision: string
  ): Promise<HostFactsObservation> {
    let response: Awaited<ReturnType<CanvasRuntimeRpcBroker["request"]>>;
    try {
      response = await this.broker.request(
        hostId,
        input.scope,
        {
          operation: "resolve_work_items",
          contentTarget,
          input: canvasRuntimeJsonValueSchema.parse(request)
        },
        this.broker.attachmentVersion(hostId)
      );
    } catch (error) {
      if (error instanceof CanvasRuntimeRpcError && deviceUnavailableErrorCodes.has(error.code)) {
        return { kind: "host_offline" };
      }
      throw error;
    }
    if (response.outcome === "error") {
      if (contentDriftErrorCodes.has(response.error.code)) {
        return { kind: "content_out_of_sync" };
      }
      throw new CanvasRuntimeRpcError(
        response.error.code,
        response.error.retryable,
        response.error.reconcileRequired === true
      );
    }
    if (response.operation !== "resolve_work_items") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    const result = parseResolveWorkItemsResult(request, response.result);
    if (
      result.sourceRevision !== sourceRevision ||
      result.graphFingerprint !== contentTarget.graphFingerprint
    ) {
      return { kind: "content_out_of_sync" };
    }
    return { kind: "match", result };
  }
}
