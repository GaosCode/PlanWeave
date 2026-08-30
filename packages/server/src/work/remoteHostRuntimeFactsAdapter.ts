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

type SettledHostFactsObservation =
  | { kind: "observation"; observation: HostFactsObservation }
  | { kind: "error"; error: unknown };

type RemoteHostWorkRuntimeFactsAdapterOptions = {
  requestTimeoutMs: number;
};

/** Bounded read-only Work facts RPC. It never acquires an execution Runtime lease. */
export class RemoteHostWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker,
    private readonly contentAuthority: {
      read(
        scope: WorkRuntimeFactsRequest["scope"]
      ): { target: CanvasRuntimeContentTarget; sourceRevision: string } | undefined;
    },
    private readonly options: RemoteHostWorkRuntimeFactsAdapterOptions
  ) {}

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const request = resolveWorkItemsRequestSchema.parse({ workItems: input.workItems });
    const located = this.locator.locateCandidates(input.scope);
    if (located.kind === "unavailable") throw new WorkRuntimeUnavailableError(located.reason);
    const authority = this.contentAuthority.read(input.scope);
    if (!authority) throw new WorkRuntimeUnavailableError("content_out_of_sync");

    const match = await this.firstExactFacts(
      located.hostIds,
      input,
      request,
      authority.target,
      authority.sourceRevision
    );
    return factsLease(input, match);
  }

  private firstExactFacts(
    hostIds: readonly string[],
    input: WorkRuntimeFactsRequest,
    request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>,
    contentTarget: CanvasRuntimeContentTarget,
    sourceRevision: string
  ): Promise<ResolveWorkItemsResult> {
    return new Promise((resolve, reject) => {
      const settled: Array<SettledHostFactsObservation | undefined> = new Array(hostIds.length);
      let remaining = hostIds.length;
      let resolved = false;

      const finishWithoutMatch = (): void => {
        const unknown = settled.find(
          (entry): entry is Extract<SettledHostFactsObservation, { kind: "error" }> =>
            entry?.kind === "error"
        );
        if (unknown) {
          reject(unknown.error);
          return;
        }
        if (
          settled.some(
            (entry) =>
              entry?.kind === "observation" && entry.observation.kind === "content_out_of_sync"
          )
        ) {
          reject(new WorkRuntimeUnavailableError("content_out_of_sync"));
          return;
        }
        reject(new WorkRuntimeUnavailableError("host_offline"));
      };

      hostIds.forEach((hostId, index) => {
        void this.readHostFacts(hostId, input, request, contentTarget, sourceRevision).then(
          (observation) => {
            if (observation.kind === "match") {
              if (!resolved) {
                resolved = true;
                resolve(observation.result);
              }
              return;
            }
            settled[index] = { kind: "observation", observation };
            remaining -= 1;
            if (!resolved && remaining === 0) finishWithoutMatch();
          },
          (error: unknown) => {
            settled[index] = { kind: "error", error };
            remaining -= 1;
            if (!resolved && remaining === 0) finishWithoutMatch();
          }
        );
      });
    });
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
        this.broker.attachmentVersion(hostId),
        { requestTimeoutMs: this.options.requestTimeoutMs }
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
