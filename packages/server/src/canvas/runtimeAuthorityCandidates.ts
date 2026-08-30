import type { CanvasRuntimeContentTarget } from "@planweave-ai/collaboration-protocol/content/version";

export type RuntimeReadAuthority = {
  target: CanvasRuntimeContentTarget;
  sourceRevision: string;
};

export type RuntimeAuthorityEvidence = {
  sourceRevision: string;
  graphFingerprint: string;
};

export type RuntimeCandidateUnavailableReason =
  | "content_out_of_sync"
  | "runtime_not_attached"
  | "host_offline";

export type RuntimeAuthorityCandidateObservation<T> =
  | {
      kind: "available";
      evidence: RuntimeAuthorityEvidence;
      value: T;
    }
  | {
      kind: "unavailable";
      reason: RuntimeCandidateUnavailableReason;
      value?: T;
    };

export type RuntimeAuthorityCandidateHandle<T> = {
  response: Promise<RuntimeAuthorityCandidateObservation<T>>;
  cancel(): boolean;
};

export type RuntimeAuthorityCandidate<T> = {
  id: string;
  start(): RuntimeAuthorityCandidateHandle<T>;
};

export type RuntimeAuthorityCandidateResult<T> =
  | { kind: "available"; candidateId: string; value: T }
  | {
      kind: "unavailable";
      reason: RuntimeCandidateUnavailableReason;
      candidateId?: string;
      value?: T;
    };

export type RuntimeAuthorityCandidateDiagnostic = {
  candidateId: string;
  category: "peer_error" | "cancelled";
  code: string;
};

type Settlement<T> =
  | { kind: "observation"; observation: RuntimeAuthorityCandidateObservation<T> }
  | { kind: "error"; error: unknown };

const unavailablePriority: readonly RuntimeCandidateUnavailableReason[] = [
  "content_out_of_sync",
  "runtime_not_attached",
  "host_offline"
];

/** Settles read-only Runtime evidence without selecting a mutation route. */
export function firstExactRuntimeAuthorityCandidate<T>(options: {
  authority: RuntimeReadAuthority;
  candidates: readonly RuntimeAuthorityCandidate<T>[];
  matchesEvidence?(evidence: RuntimeAuthorityEvidence, authority: RuntimeReadAuthority): boolean;
  matches?(value: T): boolean;
  discard?(value: T): void | Promise<void>;
  diagnosticCode?(error: unknown): string;
  diagnose?(diagnostic: RuntimeAuthorityCandidateDiagnostic): void;
}): Promise<RuntimeAuthorityCandidateResult<T>> {
  if (options.candidates.length === 0) {
    return Promise.resolve({ kind: "unavailable", reason: "runtime_not_attached" });
  }

  return new Promise((resolve, reject) => {
    const settlements: Array<Settlement<T> | undefined> = new Array(options.candidates.length);
    const handles: Array<RuntimeAuthorityCandidateHandle<T> | undefined> = new Array(
      options.candidates.length
    );
    let remaining = options.candidates.length;
    let completed = false;
    const cancelled = new Set<number>();

    const safeDiagnose = (diagnostic: RuntimeAuthorityCandidateDiagnostic): void => {
      try {
        options.diagnose?.(diagnostic);
      } catch {
        // Diagnostics are observational and must never change candidate settlement.
      }
    };
    const discard = (index: number, observation: RuntimeAuthorityCandidateObservation<T>): void => {
      if (observation.kind !== "available") return;
      void Promise.resolve()
        .then(() => options.discard?.(observation.value))
        .catch((error: unknown) => {
          safeDiagnose({
            candidateId: options.candidates[index]!.id,
            category: "peer_error",
            code: options.diagnosticCode?.(error) ?? "runtime_authority_candidate_unknown"
          });
        });
    };
    const cancelLosers = (winner: number): void => {
      handles.forEach((handle, index) => {
        if (index === winner || !handle) return;
        try {
          if (handle.cancel()) cancelled.add(index);
        } catch {
          safeDiagnose({
            candidateId: options.candidates[index]!.id,
            category: "peer_error",
            code: "runtime_authority_candidate_cancel_failed"
          });
        }
      });
    };
    const isExact = (
      observation: RuntimeAuthorityCandidateObservation<T>
    ): observation is Extract<RuntimeAuthorityCandidateObservation<T>, { kind: "available" }> =>
      observation.kind === "available" &&
      (options.matchesEvidence?.(observation.evidence, options.authority) ??
        (observation.evidence.sourceRevision === options.authority.sourceRevision &&
          observation.evidence.graphFingerprint === options.authority.target.graphFingerprint)) &&
      (options.matches?.(observation.value) ?? true);
    const finishWithoutExact = (): void => {
      const unknown = settlements.find(
        (entry): entry is Extract<Settlement<T>, { kind: "error" }> => entry?.kind === "error"
      );
      if (unknown) {
        reject(unknown.error);
        return;
      }
      const observations = settlements.flatMap((entry, index) =>
        entry?.kind === "observation" ? [{ index, observation: entry.observation }] : []
      );
      for (const reason of unavailablePriority) {
        const selected = observations.find(({ observation }) =>
          observation.kind === "available"
            ? reason === "content_out_of_sync"
            : observation.reason === reason
        );
        if (!selected) continue;
        const { observation } = selected;
        resolve({
          kind: "unavailable",
          reason,
          candidateId: options.candidates[selected.index]!.id,
          ...(observation.kind === "unavailable" && observation.value !== undefined
            ? { value: observation.value }
            : {})
        });
        return;
      }
      resolve({ kind: "unavailable", reason: "content_out_of_sync" });
    };
    const settle = (index: number, settlement: Settlement<T>): void => {
      settlements[index] = settlement;
      remaining -= 1;
      if (cancelled.delete(index)) {
        if (settlement.kind === "observation") discard(index, settlement.observation);
        safeDiagnose({
          candidateId: options.candidates[index]!.id,
          category: "cancelled",
          code: "runtime_authority_candidate_cancelled"
        });
        return;
      }
      if (settlement.kind === "error") {
        safeDiagnose({
          candidateId: options.candidates[index]!.id,
          category: "peer_error",
          code: options.diagnosticCode?.(settlement.error) ?? "runtime_authority_candidate_unknown"
        });
      } else if (isExact(settlement.observation)) {
        if (!completed) {
          completed = true;
          cancelLosers(index);
          resolve({
            kind: "available",
            candidateId: options.candidates[index]!.id,
            value: settlement.observation.value
          });
        } else {
          discard(index, settlement.observation);
        }
        return;
      } else {
        discard(index, settlement.observation);
      }
      if (!completed && remaining === 0) {
        completed = true;
        finishWithoutExact();
      }
    };

    options.candidates.forEach((candidate, index) => {
      try {
        const handle = candidate.start();
        handles[index] = handle;
        void handle.response.then(
          (observation) => settle(index, { kind: "observation", observation }),
          (error: unknown) => settle(index, { kind: "error", error })
        );
      } catch (error) {
        settle(index, { kind: "error", error });
      }
    });
  });
}
