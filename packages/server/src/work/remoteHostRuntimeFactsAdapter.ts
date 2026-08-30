import { canvasRuntimeJsonValueSchema } from "@planweave-ai/agent-host-protocol";
import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import type { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcError, type CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import {
  type RuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidateDiagnostic,
  type RuntimeAuthorityCandidateHandle,
  type RuntimeAuthorityCandidateObservation,
  type RuntimeReadAuthority
} from "../canvas/runtimeAuthorityCandidates.js";
import type { WorkRuntimeFactsLease, WorkRuntimeFactsRequest } from "./runtimePort.js";
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

type RemoteHostWorkRuntimeFactsAdapterOptions = {
  requestTimeoutMs: number;
  diagnosticSink?: (diagnostic: RuntimeAuthorityCandidateDiagnostic) => void;
};

function factsDiagnosticCode(error: unknown): string {
  return error instanceof CanvasRuntimeRpcError
    ? error.code
    : "work_runtime_facts_candidate_unknown";
}

function logFactsDiagnostic(diagnostic: RuntimeAuthorityCandidateDiagnostic): void {
  console.warn("work_runtime_facts_candidate_error", diagnostic);
}

/** Bounded read-only Work facts RPC. It never acquires an execution Runtime lease. */
export class RemoteHostWorkRuntimeFactsAdapter {
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker,
    private readonly options: RemoteHostWorkRuntimeFactsAdapterOptions
  ) {}

  factCandidates(
    input: WorkRuntimeFactsRequest,
    request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>,
    authority: RuntimeReadAuthority
  ): RuntimeAuthorityCandidate<WorkRuntimeFactsLease>[] {
    const located = this.locator.locateCandidates(input.scope);
    if (located.kind === "unavailable") {
      return [
        {
          id: "remote",
          start: () => ({
            response: Promise.resolve({ kind: "unavailable", reason: located.reason }),
            cancel: () => false
          })
        }
      ];
    }
    return located.hostIds.map((hostId) => ({
      id: `host:${hostId}`,
      start: () => this.startHostFacts(hostId, input, request, authority.target)
    }));
  }

  reportDiagnostic(diagnostic: RuntimeAuthorityCandidateDiagnostic): void {
    try {
      (this.options.diagnosticSink ?? logFactsDiagnostic)(diagnostic);
    } catch {
      // Diagnostics are observational and cannot prevent a candidate from settling.
    }
  }

  diagnosticCode(error: unknown): string {
    return factsDiagnosticCode(error);
  }

  private startHostFacts(
    hostId: string,
    input: WorkRuntimeFactsRequest,
    request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>,
    contentTarget: CanvasRuntimeContentTarget
  ): RuntimeAuthorityCandidateHandle<WorkRuntimeFactsLease> {
    try {
      const handle = this.broker.requestCancellableRead(
        hostId,
        input.scope,
        {
          operation: "resolve_work_items",
          contentTarget,
          input: canvasRuntimeJsonValueSchema.parse(request)
        },
        this.broker.attachmentVersion(hostId),
        { requestTimeoutMs: this.options.requestTimeoutMs }
      );
      return {
        response: this.readHostFactsResponse(handle.response, input, request),
        cancel: () => {
          return handle.cancel();
        }
      };
    } catch (error) {
      if (error instanceof CanvasRuntimeRpcError && deviceUnavailableErrorCodes.has(error.code)) {
        return {
          response: Promise.resolve({ kind: "unavailable", reason: "host_offline" }),
          cancel: () => false
        };
      }
      return { response: Promise.reject(error), cancel: () => false };
    }
  }

  private async readHostFactsResponse(
    responsePromise: ReturnType<CanvasRuntimeRpcBroker["requestCancellableRead"]>["response"],
    input: WorkRuntimeFactsRequest,
    request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>
  ): Promise<RuntimeAuthorityCandidateObservation<WorkRuntimeFactsLease>> {
    let response: Awaited<typeof responsePromise>;
    try {
      response = await responsePromise;
    } catch (error) {
      if (error instanceof CanvasRuntimeRpcError && deviceUnavailableErrorCodes.has(error.code)) {
        return { kind: "unavailable", reason: "host_offline" };
      }
      throw error;
    }
    if (response.outcome === "error") {
      if (contentDriftErrorCodes.has(response.error.code)) {
        return { kind: "unavailable", reason: "content_out_of_sync" };
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
    return {
      kind: "available",
      evidence: {
        sourceRevision: result.sourceRevision,
        graphFingerprint: result.graphFingerprint
      },
      value: factsLease(input, result)
    };
  }
}
