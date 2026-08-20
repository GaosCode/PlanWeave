import { canvasRuntimeJsonValueSchema } from "@planweave-ai/agent-host-protocol";
import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import {
  CanvasRuntimeHostAmbiguousError,
  type CanvasRuntimeHostLocator
} from "../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcError, type CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import type {
  WorkRuntimeFactsLease,
  WorkRuntimeFactsRequest,
  WorkRuntimePackageFactsPort
} from "./runtimePort.js";
import { WorkRuntimeUnavailableError } from "./runtimePort.js";
import { factsLease } from "./runtimeFactsAdapters.js";

const contentDriftErrorCodes = new Set([
  "runtime_canvas_not_found",
  "runtime_project_not_configured",
  "runtime_project_missing",
  "runtime_project_escape",
  "runtime_project_identity_mismatch",
  "work_package_evidence_invalid",
  "runtime_package_location_mismatch"
]);

/** Bounded read-only Work facts RPC. It never acquires an execution Runtime lease. */
export class RemoteHostWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker
  ) {}

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const request = resolveWorkItemsRequestSchema.parse({ workItems: input.workItems });
    let located: ReturnType<CanvasRuntimeHostLocator["locate"]>;
    try {
      located = this.locator.locate(input.scope);
    } catch (error) {
      if (error instanceof CanvasRuntimeHostAmbiguousError) {
        throw new WorkRuntimeUnavailableError("canvas_runtime_host_ambiguous");
      }
      throw error;
    }
    if (located.kind === "unavailable") throw new WorkRuntimeUnavailableError(located.reason);

    let response: Awaited<ReturnType<CanvasRuntimeRpcBroker["request"]>>;
    try {
      response = await this.broker.request(
        located.hostId,
        input.scope,
        {
          operation: "resolve_work_items",
          input: canvasRuntimeJsonValueSchema.parse(request)
        },
        this.broker.attachmentVersion(located.hostId)
      );
    } catch (error) {
      if (
        error instanceof CanvasRuntimeRpcError &&
        (error.code === "canvas_runtime_host_offline" ||
          error.code === "canvas_runtime_rpc_deadline_exceeded")
      ) {
        throw new WorkRuntimeUnavailableError("host_offline");
      }
      throw error;
    }
    if (response.outcome === "error") {
      if (contentDriftErrorCodes.has(response.error.code)) {
        throw new WorkRuntimeUnavailableError("content_out_of_sync");
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
    return factsLease(input, parseResolveWorkItemsResult(request, response.result));
  }
}
