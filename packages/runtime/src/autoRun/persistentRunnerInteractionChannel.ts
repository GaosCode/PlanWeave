import type {
  RunnerPermissionInteractionRequest,
  RunnerPermissionInteractionResponse,
  RunnerPermissionOption
} from "./runnerInteractionContract.js";
import {
  PersistentRunnerInteractionStore,
  RunnerInteractionStoreError
} from "./runnerInteractionStore.js";

export type RunnerPermissionChannelDecision =
  | { kind: "select"; option: RunnerPermissionOption }
  | { kind: "cancel" }
  | {
      kind: "expired";
      reason: "establishment_failed" | "aborted" | "deadline" | "terminal_cleanup";
    };

export interface RunnerInteractionChannel {
  requestPermission(
    request: RunnerPermissionInteractionRequest,
    options: { signal: AbortSignal; deadline: Date | null }
  ): Promise<RunnerPermissionChannelDecision>;
}

export class RunnerInteractionChannelError extends Error {
  constructor(
    readonly code: "interaction_persistence_failed" | "interaction_response_invalid",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RunnerInteractionChannelError";
  }
}

type PersistentRunnerInteractionChannelOptions = {
  store: PersistentRunnerInteractionStore;
  publishPending: (request: RunnerPermissionInteractionRequest) => Promise<void>;
  publishResult: (
    request: RunnerPermissionInteractionRequest,
    decision: RunnerPermissionChannelDecision
  ) => Promise<void>;
  setWaiting: (requestId: string, waiting: boolean) => Promise<void>;
  recordFailure: (failure: RunnerInteractionChannelError) => void;
  notifyRequired?: (request: RunnerPermissionInteractionRequest) => void | Promise<void>;
  publishDiagnostic?: (code: string, message: string) => void | Promise<void>;
  pollIntervalMs?: number;
  now?: () => Date;
};

export class PersistentRunnerInteractionChannel implements RunnerInteractionChannel {
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: PersistentRunnerInteractionChannelOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("Runner interaction poll interval must be a positive integer.");
    }
  }

  async requestPermission(
    request: RunnerPermissionInteractionRequest,
    wait: { signal: AbortSignal; deadline: Date | null }
  ): Promise<RunnerPermissionChannelDecision> {
    let waitingPersisted = false;
    let waitingAttempted = false;
    let requestCreated = false;
    try {
      await this.options.store.createRequest(request);
      requestCreated = true;
      await this.options.publishPending(request);
      waitingAttempted = true;
      await this.options.setWaiting(request.identity.requestId, true);
      waitingPersisted = true;
    } catch (error) {
      const failures: unknown[] = [error];
      if (requestCreated) {
        let settlementDecision: RunnerPermissionChannelDecision = {
          kind: "expired",
          reason: "establishment_failed"
        };
        try {
          settlementDecision = await this.expireRequest(
            request,
            "establishment_failed",
            "Permission establishment failed."
          );
        } catch (ownerResultError) {
          failures.push(ownerResultError);
        }
        try {
          await this.options.publishResult(request, settlementDecision);
        } catch (auditError) {
          failures.push(auditError);
        }
        if (waitingAttempted) {
          try {
            await this.options.setWaiting(request.identity.requestId, false);
          } catch (waitingCleanupError) {
            failures.push(waitingCleanupError);
          }
        }
      }
      throw new RunnerInteractionChannelError(
        "interaction_persistence_failed",
        "ACP permission interaction could not be persisted and was failed closed.",
        { cause: failures.length === 1 ? error : new AggregateError(failures) }
      );
    }

    this.notifyRequired(request);

    let decision: RunnerPermissionChannelDecision | null = null;
    let decisionError: RunnerInteractionChannelError | null = null;
    try {
      decision = await this.waitForDecision(request, wait);
      if (decision.kind === "expired") {
        decision = await this.expireRequest(
          request,
          decision.reason,
          `Permission request expired because of ${decision.reason}.`
        );
      }
      await this.options.publishResult(request, decision);
    } catch (error) {
      decisionError =
        error instanceof RunnerInteractionChannelError
          ? error
          : new RunnerInteractionChannelError(
              "interaction_persistence_failed",
              "ACP permission interaction result could not be persisted and was failed closed.",
              { cause: error }
            );
    }
    if (waitingPersisted) {
      try {
        await this.options.setWaiting(request.identity.requestId, false);
      } catch (error) {
        throw new RunnerInteractionChannelError(
          "interaction_persistence_failed",
          "ACP permission waiting state could not be cleared.",
          { cause: decisionError ? new AggregateError([decisionError, error]) : error }
        );
      }
    }
    if (decisionError) throw decisionError;
    if (!decision) {
      throw new RunnerInteractionChannelError(
        "interaction_persistence_failed",
        "ACP permission interaction ended without a decision."
      );
    }

    return decision;
  }

  private async waitForDecision(
    request: RunnerPermissionInteractionRequest,
    wait: { signal: AbortSignal; deadline: Date | null }
  ): Promise<RunnerPermissionChannelDecision> {
    while (true) {
      if (wait.signal.aborted) return { kind: "expired", reason: "aborted" };
      if (wait.deadline && this.now().getTime() >= wait.deadline.getTime()) {
        return { kind: "expired", reason: "deadline" };
      }
      try {
        const snapshot = await this.options.store.readSnapshot(request.identity.requestId);
        if (snapshot.response) return this.toDecision(snapshot.response, snapshot.request.options);
        if (snapshot.ownerResult) {
          const reason = snapshot.ownerResult.reason;
          return { kind: "expired", reason };
        }
      } catch (error) {
        if (error instanceof RunnerInteractionStoreError) {
          throw new RunnerInteractionChannelError(
            "interaction_response_invalid",
            "ACP permission response failed canonical store validation.",
            { cause: error }
          );
        }
        throw error;
      }
      await this.pause(wait.signal, wait.deadline);
    }
  }

  private async expireRequest(
    request: RunnerPermissionInteractionRequest,
    reason: "establishment_failed" | "aborted" | "deadline" | "terminal_cleanup",
    message: string
  ): Promise<RunnerPermissionChannelDecision> {
    const settlement = await this.options.store.settleOwnerResult({
      version: "planweave.runner-interaction-owner-result/v1",
      identity: request.identity,
      outcome: "expired",
      reason,
      recordedAt: this.now().toISOString(),
      message
    });
    if (settlement.winner.kind === "response") {
      return this.toDecision(settlement.winner.response, request.options);
    }
    return { kind: "expired", reason: settlement.winner.ownerResult.reason };
  }

  private toDecision(
    response: RunnerPermissionInteractionResponse,
    options: readonly RunnerPermissionOption[]
  ): RunnerPermissionChannelDecision {
    if (response.decision.kind === "cancel") return { kind: "cancel" };
    const selectedOptionId = response.decision.optionId;
    const selected = options.find(({ optionId }) => optionId === selectedOptionId);
    if (!selected) {
      throw new RunnerInteractionChannelError(
        "interaction_response_invalid",
        "ACP permission response selected an option that was not advertised."
      );
    }
    return { kind: "select", option: selected };
  }

  private async pause(signal: AbortSignal, deadline: Date | null): Promise<void> {
    const remaining = deadline ? Math.max(0, deadline.getTime() - this.now().getTime()) : Infinity;
    const delay = Math.min(this.pollIntervalMs, remaining);
    if (delay === 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private notifyRequired(request: RunnerPermissionInteractionRequest): void {
    if (!this.options.notifyRequired) return;
    void Promise.resolve()
      .then(() => this.options.notifyRequired?.(request))
      .catch(async (error) => {
        try {
          await this.options.publishDiagnostic?.(
            "interaction_observer_failed",
            error instanceof Error ? error.message : "Runner interaction observer failed."
          );
        } catch (diagnosticError) {
          this.options.recordFailure(
            new RunnerInteractionChannelError(
              "interaction_persistence_failed",
              "ACP interaction notification and its diagnostic audit both failed.",
              {
                cause: new AggregateError(
                  [error, diagnosticError],
                  "ACP interaction notification and diagnostic audit failed."
                )
              }
            )
          );
        }
      });
  }
}
