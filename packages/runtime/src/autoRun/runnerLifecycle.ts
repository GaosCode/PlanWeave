import {
  runnerLifecycleStateSchema,
  runnerTerminalStateSchema,
  terminalOutcomeSchema,
  type RunnerLifecycleState,
  type TerminalOutcome
} from "./runnerContractSchemas.js";
import {
  assertLiveOwnership,
  cleanupRunnerLiveControl,
  type LiveOwnership,
  type RunnerCleanupResult,
  type RunnerLiveControl
} from "./liveControl.js";

export type RunnerTransitionCause = "normal" | "restart" | "ownership_loss";

export type RunnerLifecycleTransition = {
  from: RunnerLifecycleState;
  to: RunnerLifecycleState;
  cause: RunnerTransitionCause;
  ownership: LiveOwnership;
  nextOwnership?: LiveOwnership;
  outcome?: TerminalOutcome;
};

export type RunnerLifecycleTransitionResult = {
  state: RunnerLifecycleState;
  ownership: LiveOwnership;
  terminal: boolean;
  idempotent: boolean;
};

export type RunnerLifecycleExecutionResult = RunnerLifecycleTransitionResult & {
  cleanup: RunnerCleanupResult | null;
};

export type RunnerLifecycleExecutionInput = {
  transition: RunnerLifecycleTransition;
  live: { kind: "present"; control: RunnerLiveControl; cleanupReason: string } | { kind: "absent" };
};

const normalTransitions = {
  created: ["initializing"],
  initializing: ["ready", "failed", "cancelled"],
  ready: ["running", "failed", "cancelled"],
  running: ["waiting_interaction", "cancelling", "succeeded", "failed", "cancelled"],
  waiting_interaction: ["running", "cancelling", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: []
} as const satisfies Record<RunnerLifecycleState, readonly RunnerLifecycleState[]>;

function isTerminal(state: RunnerLifecycleState): boolean {
  return runnerTerminalStateSchema.safeParse(state).success;
}

function assertTerminalOutcome(
  state: RunnerLifecycleState,
  outcome: TerminalOutcome | undefined
): void {
  if (!isTerminal(state)) {
    if (outcome !== undefined) {
      throw new Error("Nonterminal runner transitions cannot carry a terminal outcome.");
    }
    return;
  }
  if (!outcome) {
    throw new Error(`Terminal runner transition '${state}' requires an outcome.`);
  }
  const parsed = terminalOutcomeSchema.parse(outcome);
  if (parsed.state !== state) {
    throw new Error("Terminal outcome state does not match the lifecycle transition.");
  }
}

function requireRestartOwnership(
  current: LiveOwnership,
  next: LiveOwnership | undefined
): LiveOwnership {
  if (
    !next ||
    next === current ||
    next.runId !== current.runId ||
    next.generation <= current.generation
  ) {
    throw new Error("Runner restart requires a newer ownership generation for the same run.");
  }
  return next;
}

export function transitionRunnerLifecycle(
  transition: RunnerLifecycleTransition
): RunnerLifecycleTransitionResult {
  const from = runnerLifecycleStateSchema.parse(transition.from);
  const to = runnerLifecycleStateSchema.parse(transition.to);
  assertTerminalOutcome(to, transition.outcome);

  if (isTerminal(from)) {
    if (from !== to || transition.cause !== "normal") {
      throw new Error(
        `Runner lifecycle cannot transition from terminal state '${from}' to '${to}'.`
      );
    }
    assertLiveOwnership(transition.ownership, transition.nextOwnership ?? transition.ownership);
    return { state: to, ownership: transition.ownership, terminal: true, idempotent: true };
  }

  if (transition.cause === "restart") {
    if (
      to !== "initializing" ||
      (from !== "ready" && from !== "running" && from !== "waiting_interaction")
    ) {
      throw new Error(`Runner restart is not legal from '${from}' to '${to}'.`);
    }
    const nextOwnership = requireRestartOwnership(transition.ownership, transition.nextOwnership);
    return {
      state: to,
      ownership: nextOwnership,
      terminal: false,
      idempotent: false
    };
  }

  if (transition.cause === "ownership_loss") {
    if (to !== "failed" || transition.outcome?.state !== "failed") {
      throw new Error("Runner ownership loss must terminate the run as failed.");
    }
    return { state: to, ownership: transition.ownership, terminal: true, idempotent: false };
  }

  assertLiveOwnership(transition.ownership, transition.nextOwnership ?? transition.ownership);
  if (!(normalTransitions[from] as readonly RunnerLifecycleState[]).includes(to)) {
    throw new Error(`Illegal runner lifecycle transition '${from}' -> '${to}'.`);
  }
  return {
    state: to,
    ownership: transition.ownership,
    terminal: isTerminal(to),
    idempotent: false
  };
}

export async function executeRunnerLifecycleTransition(
  input: RunnerLifecycleExecutionInput
): Promise<RunnerLifecycleExecutionResult> {
  const result = transitionRunnerLifecycle(input.transition);
  if (!result.terminal || input.live.kind === "absent") {
    return { ...result, cleanup: null };
  }
  const cleanup = await cleanupRunnerLiveControl(
    input.live.control,
    result.ownership,
    input.live.cleanupReason,
    { cancelSession: input.transition.to !== "succeeded" }
  );
  return { ...result, cleanup };
}
