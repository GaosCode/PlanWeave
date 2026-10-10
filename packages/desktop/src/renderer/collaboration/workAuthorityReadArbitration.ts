import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import { collaborationBoundaryErrorFromUnknown } from "./collaborationBoundaryError.js";

type AuthorityReadOutcome =
  | { status: "applied" | "retired" }
  | { status: "failed"; error: unknown };
export type WorkAuthorityReadRequest = {
  key: string;
  generation: number;
  completion: Promise<AuthorityReadOutcome>;
  settle(outcome: AuthorityReadOutcome): void;
};

type AggregateAuthorityReadResult = {
  index: number;
  original: WorkAuthorityReadRequest;
  request: WorkAuthorityReadRequest;
  outcome: AuthorityReadOutcome;
};

type AuthorityReadPort = {
  isCurrentScope(generation: number): boolean;
  read(workItem: WorkItemRef): Promise<WorkAuthorityProjection>;
  acquire(key: string): { release(): void };
  emit(): void;
  apply(key: string, workItem: WorkItemRef, projection: WorkAuthorityProjection): void;
  applyError(error: CollaborationBoundaryErrorView): void;
  recoverError(error: CollaborationBoundaryErrorView): void;
};

/** Owns work-item read replacement and the single boundary error published by those reads. */
export class WorkAuthorityReadArbitrator {
  private readonly latest = new Map<string, WorkAuthorityReadRequest>();
  private boundaryError: {
    key: string;
    generation: number;
    error: CollaborationBoundaryErrorView;
  } | null = null;

  constructor(private readonly port: AuthorityReadPort) {}

  reset(): void {
    for (const request of this.latest.values()) request.settle({ status: "retired" });
    this.latest.clear();
    this.boundaryError = null;
  }

  isCurrent(request: WorkAuthorityReadRequest): boolean {
    return this.port.isCurrentScope(request.generation) && this.latest.get(request.key) === request;
  }

  async waitForCurrent(
    request: WorkAuthorityReadRequest
  ): Promise<{ request: WorkAuthorityReadRequest; outcome: AuthorityReadOutcome }> {
    while (this.port.isCurrentScope(request.generation)) {
      const current = this.latest.get(request.key);
      if (!current) break;
      const outcome = await current.completion;
      if (this.isCurrent(current)) return { request: current, outcome };
    }
    return { request, outcome: { status: "retired" } };
  }

  async waitForAggregate(
    requests: ReadonlyMap<number, WorkAuthorityReadRequest>,
    generation: number
  ): Promise<AggregateAuthorityReadResult[]> {
    let results: AggregateAuthorityReadResult[];
    do {
      results = await Promise.all(
        [...requests].map(async ([index, original]) => ({
          index,
          original,
          ...(await this.waitForCurrent(original))
        }))
      );
    } while (
      this.port.isCurrentScope(generation) &&
      results.some(({ request }) => !this.isCurrent(request))
    );
    return results;
  }

  async read(
    workItem: WorkItemRef,
    generation: number,
    onStarted?: (request: WorkAuthorityReadRequest) => void
  ): Promise<"applied" | "superseded"> {
    if (!this.port.isCurrentScope(generation)) return "superseded";
    const key = workItemKey(workItem);
    this.latest.get(key)?.settle({ status: "retired" });
    const loading = this.port.acquire(key);
    let settled = false;
    let settle!: (outcome: AuthorityReadOutcome) => void;
    const completion = new Promise<AuthorityReadOutcome>((resolve) => {
      settle = (outcome) => {
        if (settled) return;
        settled = true;
        loading.release();
        resolve(outcome);
      };
    });
    const request = { key, generation, completion, settle };
    this.latest.set(key, request);
    onStarted?.(request);
    const read = async () => {
      try {
        const pending = this.port.read(workItem);
        this.port.emit();
        const projection = await pending;
        if (!this.isCurrent(request)) return;
        this.port.apply(key, workItem, projection);
        const previous = this.boundaryError;
        if (previous?.key === key && previous.generation === generation) {
          this.port.recoverError(previous.error);
          this.boundaryError = null;
        }
        request.settle({ status: "applied" });
      } catch (error) {
        if (!this.isCurrent(request)) return;
        const mapped = collaborationBoundaryErrorFromUnknown(error);
        this.boundaryError = { key, generation, error: mapped };
        this.port.applyError(mapped);
        request.settle({ status: "failed", error });
      }
    };
    // Retired callers finish independently; the transport still has a rejection consumer.
    void read().catch((error) => {
      request.settle({ status: "failed", error });
    });
    try {
      const outcome = await completion;
      if (outcome.status === "failed") throw outcome.error;
      return outcome.status === "applied" ? "applied" : "superseded";
    } finally {
      if (this.port.isCurrentScope(generation)) this.port.emit();
    }
  }
}
