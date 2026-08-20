import type { ClaimResult, DesktopAutoRunScope } from "@planweave-ai/runtime";

export type ClaimPreviewPort = {
  previewNext: (scope: DesktopAutoRunScope) => Promise<ClaimResult>;
};

export type BlockExecutionPort = {
  execute: (ref: string, signal?: AbortSignal) => Promise<void>;
};

export type FeedbackExecutionPort = {
  execute: (
    claim: Extract<ClaimResult, { kind: "feedback" }>,
    signal?: AbortSignal
  ) => Promise<void>;
};

export type ScopeCompletionCheckOptions = {
  /**
   * Force a fresh collaboration Runtime availability read before judging.
   * Used after claim-none / at_capacity so a lagging projection cannot false-idle a finished scope.
   */
  refresh?: boolean;
};

export type ScopeCompletionPort = {
  isSatisfied: (options?: ScopeCompletionCheckOptions) => Promise<boolean>;
};

export type EndpointRoutingPort = {
  routeForBlock: (ref: string) => "local" | "remote";
};

export type ClaimBusScopeInput = {
  scope: DesktopAutoRunScope;
  preview: ClaimPreviewPort;
  route: EndpointRoutingPort;
  localBlock: BlockExecutionPort;
  remoteBlock: BlockExecutionPort;
  feedback: FeedbackExecutionPort;
  completion: ScopeCompletionPort;
  signal?: AbortSignal;
};

async function executeBlockRef(ref: string, input: ClaimBusScopeInput): Promise<void> {
  const mode = input.route.routeForBlock(ref);
  if (mode === "remote") {
    await input.remoteBlock.execute(ref, input.signal);
    return;
  }
  if (mode === "local") {
    await input.localBlock.execute(ref, input.signal);
    return;
  }
  throw new Error(`claim_bus_route_missing:${ref}`);
}

type InFlightExecution = {
  blockRef?: string;
  settled: Promise<{ execution: InFlightExecution; error?: unknown }>;
};

function startInFlight(execute: () => Promise<void>, blockRef?: string): InFlightExecution {
  const execution = { blockRef } as InFlightExecution;
  execution.settled = execute().then(
    () => ({ execution }),
    (error: unknown) => ({ execution, error })
  );
  return execution;
}

async function settleExecution(
  inFlight: Set<InFlightExecution>,
  execution: InFlightExecution
): Promise<void> {
  const outcome = await execution.settled;
  inFlight.delete(outcome.execution);
  if (outcome.error !== undefined) throw outcome.error;
}

async function settleNext(inFlight: Set<InFlightExecution>): Promise<void> {
  if (inFlight.size === 0) return;
  const outcome = await Promise.race([...inFlight].map((execution) => execution.settled));
  await settleExecution(inFlight, outcome.execution);
}

/**
 * Claim-bus work-unit loop: dry-run claim order only, then route each unit.
 * Does not scan dispatchable projection or reimplement readiness.
 */
export async function runClaimBusScope(input: ClaimBusScopeInput): Promise<void> {
  const inFlight = new Set<InFlightExecution>();
  const start = (execute: () => Promise<void>, blockRef?: string) => {
    const execution = startInFlight(execute, blockRef);
    inFlight.add(execution);
    return execution;
  };
  const executionForBlock = (ref: string) =>
    [...inFlight].find((execution) => execution.blockRef === ref);

  while (!input.signal?.aborted) {
    if (inFlight.size === 0 && (await input.completion.isSatisfied())) {
      return;
    }

    const unit = await input.preview.previewNext(input.scope);

    if (unit.kind === "none") {
      if (inFlight.size > 0) {
        await settleNext(inFlight);
        continue;
      }
      // Projection may lag the just-finished unit; refresh before idle vs complete.
      if (await input.completion.isSatisfied({ refresh: true })) {
        return;
      }
      throw new Error(`claim_bus_idle:${unit.reason ?? "unknown"}`);
    }

    if (unit.kind === "blocked") {
      throw new Error(`claim_bus_blocked:${unit.reason}`);
    }

    if (unit.kind === "feedback") {
      const execution = start(() => input.feedback.execute(unit, input.signal));
      await settleExecution(inFlight, execution);
      continue;
    }

    if (unit.kind === "batch") {
      // Parallel dry-run may report retained in_progress holders as batch+at_capacity
      // (same as runAutoRunStep idle). Never re-dispatch those refs.
      if (unit.reason === "at_capacity") {
        if (inFlight.size > 0) {
          await settleNext(inFlight);
          continue;
        }
        if (await input.completion.isSatisfied({ refresh: true })) {
          return;
        }
        throw new Error("claim_bus_idle:at_capacity");
      }
      if (input.signal?.aborted) {
        throw new Error("claim_bus_cancelled");
      }
      const newRefs = unit.refs.filter((ref) => executionForBlock(ref) === undefined);
      for (const ref of newRefs) {
        start(() => executeBlockRef(ref, input), ref);
      }
      // A dry-run preview can still observe a just-dispatched remote block as ready while
      // its claim is crossing IPC/HTTP. Keep the existing local execution as the authority
      // for that ref and wait instead of dispatching the same block twice.
      await settleNext(inFlight);
      continue;
    }

    const existingExecution = executionForBlock(unit.ref);
    if (existingExecution) {
      await settleExecution(inFlight, existingExecution);
      continue;
    }
    const execution = start(() => executeBlockRef(unit.ref, input), unit.ref);
    if (unit.blockType === "review") {
      // Runtime review ownership is a single slot. A settled implementation may still
      // be present in the local set while the review dispatch is crossing the IPC/HTTP
      // boundary, so wait for this review rather than racing an older implementation.
      await settleExecution(inFlight, execution);
    } else {
      await settleNext(inFlight);
    }
  }

  throw new Error("claim_bus_cancelled");
}
