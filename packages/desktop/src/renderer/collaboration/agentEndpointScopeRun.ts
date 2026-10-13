import type {
  DesktopAutoRunEvent,
  DesktopAutoRunScope,
  DesktopAutoRunState
} from "@planweave-ai/runtime";

/** Resource-release terminal phases for a finished Auto Run (not recoverable ownership). */
const RESOURCE_TERMINAL_LOCAL_PHASES = new Set<DesktopAutoRunState["phase"]>([
  "completed",
  "blocked",
  "failed",
  "stopped"
]);

/**
 * Claim-bus one-unit settle set. Desktop Auto Run ends successful stepLimit runs as
 * `paused` + "Step limit reached." (see runApi step_limit_reached), not `completed`.
 */
const CLAIM_BUS_LOCAL_SETTLE_PHASES = new Set<DesktopAutoRunState["phase"]>([
  "completed",
  "blocked",
  "failed",
  "stopped",
  "paused",
  "manual"
]);

export const CLAIM_BUS_STEP_LIMIT_ERROR = "Step limit reached.";

export type LocalAutoRunObserver = {
  getAutoRunState: (runId: string) => Promise<DesktopAutoRunState>;
  onAutoRunChanged: (callback: (event: DesktopAutoRunEvent) => void) => () => void;
};

function waitForLocalAutoRunPhases(input: {
  api: LocalAutoRunObserver;
  workspaceRoot: string;
  initial: DesktopAutoRunState;
  settlePhases: ReadonlySet<DesktopAutoRunState["phase"]>;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<DesktopAutoRunState> {
  if (input.settlePhases.has(input.initial.phase)) return Promise.resolve(input.initial);

  return new Promise((resolve, reject) => {
    let settled = false;
    let refreshInFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (state: DesktopAutoRunState) => {
      cleanup();
      resolve(state);
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const scheduleFallback = () => {
      if (settled) return;
      timer = setTimeout(() => void refresh(), input.fallbackRefreshMs ?? 1_000);
    };
    const refresh = async () => {
      if (settled || refreshInFlight) return;
      refreshInFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const state = await input.api.getAutoRunState(input.initial.runId);
        if (input.settlePhases.has(state.phase)) {
          finish(state);
          return;
        }
        scheduleFallback();
      } catch (caught) {
        fail(caught);
      } finally {
        refreshInFlight = false;
      }
    };
    const onAbort = () => fail(new Error("agent_endpoint_scope_run_cancelled"));
    const unsubscribe = input.api.onAutoRunChanged((event) => {
      if (
        event.workspaceRoot !== input.workspaceRoot ||
        event.projectRoot !== input.initial.projectRoot ||
        event.canvasId !== input.initial.canvasId ||
        event.runId !== input.initial.runId
      )
        return;
      if (input.settlePhases.has(event.state.phase)) {
        finish(event.state);
      }
    });

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void refresh();
  });
}

/** Wait until Auto Run reaches a resource-terminal phase (completed/blocked/failed/stopped). */
export function waitForLocalAutoRunTerminal(input: {
  api: LocalAutoRunObserver;
  workspaceRoot: string;
  initial: DesktopAutoRunState;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<DesktopAutoRunState> {
  return waitForLocalAutoRunPhases({
    ...input,
    settlePhases: RESOURCE_TERMINAL_LOCAL_PHASES
  });
}

/**
 * Wait until a claim-bus one-unit Auto Run settles, including successful step-limit pause.
 */
export function waitForClaimBusLocalAutoRunUnit(input: {
  api: LocalAutoRunObserver;
  workspaceRoot: string;
  initial: DesktopAutoRunState;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<DesktopAutoRunState> {
  return waitForLocalAutoRunPhases({
    ...input,
    settlePhases: CLAIM_BUS_LOCAL_SETTLE_PHASES
  });
}

/** True when Desktop Auto Run finished one claim-bus unit successfully. */
export function isClaimBusLocalUnitSuccess(state: DesktopAutoRunState): boolean {
  if (state.phase === "completed") return true;
  return state.phase === "paused" && state.error === CLAIM_BUS_STEP_LIMIT_ERROR;
}

/**
 * Run exactly one Auto Run step for claim-bus local block/feedback units.
 * Accepts real stepLimit terminal semantics (paused + Step limit reached.) and always
 * stops a non-resource-terminal run so the next unit can startAutoRun.
 */
export async function runClaimBusLocalAutoRunUnit(input: {
  scope: DesktopAutoRunScope;
  startLocal: (
    scope: DesktopAutoRunScope,
    options?: { stepLimit?: number }
  ) => Promise<DesktopAutoRunState | null | undefined>;
  stopLocal: (runId: string) => Promise<unknown>;
  api: LocalAutoRunObserver;
  workspaceRoot: string;
  unitLabel: string;
  signal?: AbortSignal;
  waitForUnit?: typeof waitForClaimBusLocalAutoRunUnit;
}): Promise<DesktopAutoRunState> {
  const started = await input.startLocal(input.scope, { stepLimit: 1 });
  if (!started) {
    throw new Error(`local_agent_run_not_started:${input.unitLabel}`);
  }
  const wait = input.waitForUnit ?? waitForClaimBusLocalAutoRunUnit;
  let settled: DesktopAutoRunState;
  try {
    settled = await wait({
      api: input.api,
      workspaceRoot: input.workspaceRoot,
      initial: started,
      signal: input.signal
    });
  } catch (caught) {
    try {
      await input.stopLocal(started.runId);
    } catch {
      // Prefer the settle/abort error; stop is best-effort release.
    }
    throw caught;
  }

  if (!isClaimBusLocalUnitSuccess(settled)) {
    if (!RESOURCE_TERMINAL_LOCAL_PHASES.has(settled.phase)) {
      try {
        await input.stopLocal(settled.runId);
      } catch {
        // still report the unit failure
      }
    }
    throw new Error(`local_agent_unit_${settled.phase}:${input.unitLabel}`);
  }

  // Successful step-limit runs remain non-terminal (paused) and block the next startAutoRun.
  if (!RESOURCE_TERMINAL_LOCAL_PHASES.has(settled.phase)) {
    await input.stopLocal(settled.runId);
  }
  return settled;
}
