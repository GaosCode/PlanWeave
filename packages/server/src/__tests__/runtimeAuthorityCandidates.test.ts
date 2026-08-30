import { describe, expect, it, vi } from "vitest";
import {
  firstExactRuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidateObservation
} from "../canvas/runtimeAuthorityCandidates.js";

const authority = {
  target: {
    revision: 1,
    content: {
      versionId: `version-${"c".repeat(64)}`,
      canonicalDigest: "c".repeat(64),
      verification: "complete" as const
    },
    graphFingerprint: `pkg-${"a".repeat(64)}`
  },
  sourceRevision: `snapshot:${"b".repeat(64)}`
};

type Value = { name: string };

function exact(name: string): RuntimeAuthorityCandidateObservation<Value> {
  return {
    kind: "available",
    evidence: {
      sourceRevision: authority.sourceRevision,
      graphFingerprint: authority.target.graphFingerprint
    },
    value: { name }
  };
}

function candidate(
  id: string,
  response: Promise<RuntimeAuthorityCandidateObservation<Value>>,
  cancel: () => boolean = () => false
): RuntimeAuthorityCandidate<Value> {
  return { id, start: () => ({ response, cancel }) };
}

describe("firstExactRuntimeAuthorityCandidate", () => {
  it("returns the first exact authority and cancels a pending loser", async () => {
    let rejectLoser: ((error: Error) => void) | undefined;
    const loser = new Promise<RuntimeAuthorityCandidateObservation<Value>>((_, reject) => {
      rejectLoser = reject;
    });
    const diagnostics = vi.fn();
    const cancel = vi.fn(() => {
      rejectLoser?.(new Error("cancelled"));
      return true;
    });

    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate("winner", Promise.resolve(exact("winner"))),
          candidate("loser", loser, cancel)
        ],
        diagnose: diagnostics
      })
    ).resolves.toEqual({ kind: "available", candidateId: "winner", value: { name: "winner" } });
    await vi.waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith({
        candidateId: "loser",
        category: "cancelled",
        code: "runtime_authority_candidate_cancelled"
      })
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps a settled loser error as peer_error when cancellation returns false", async () => {
    const diagnostics = vi.fn();
    const settledError = Object.assign(new Error("peer failed"), { code: "peer_failed" });
    const cancel = vi.fn(() => false);

    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate("winner", Promise.resolve(exact("winner"))),
          candidate("settled", Promise.reject(settledError), cancel)
        ],
        diagnosticCode: (error) =>
          error instanceof Error && "code" in error ? String(error.code) : "unknown",
        diagnose: diagnostics
      })
    ).resolves.toMatchObject({ kind: "available", candidateId: "winner" });
    expect(diagnostics).toHaveBeenCalledWith({
      candidateId: "settled",
      category: "peer_error",
      code: "peer_failed"
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("prefers content drift over other unavailable observations", async () => {
    const discard = vi.fn();
    const result = await firstExactRuntimeAuthorityCandidate({
      authority,
      candidates: [
        candidate("offline", Promise.resolve({ kind: "unavailable", reason: "host_offline" })),
        candidate(
          "drift",
          Promise.resolve({
            kind: "available",
            evidence: {
              sourceRevision: "snapshot:stale",
              graphFingerprint: authority.target.graphFingerprint
            },
            value: { name: "stale" }
          })
        ),
        candidate(
          "missing",
          Promise.resolve({ kind: "unavailable", reason: "runtime_not_attached" })
        )
      ],
      discard
    });

    expect(result).toEqual({
      kind: "unavailable",
      reason: "content_out_of_sync",
      candidateId: "drift"
    });
    expect(discard).toHaveBeenCalledWith({ name: "stale" });
  });

  it("propagates the first candidate error in stable order when no exact exists", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = new Promise<RuntimeAuthorityCandidateObservation<Value>>((_, reject) => {
      rejectFirst = reject;
    });
    const pending = firstExactRuntimeAuthorityCandidate({
      authority,
      candidates: [
        candidate("first", first),
        candidate("second", Promise.reject(new Error("second_error")))
      ]
    });
    rejectFirst?.(new Error("first_error"));

    await expect(pending).rejects.toThrow("first_error");
  });

  it("attributes discard failures to the losing candidate", async () => {
    const diagnostics = vi.fn();
    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate(
            "stale-local",
            Promise.resolve({
              kind: "available",
              evidence: {
                sourceRevision: "snapshot:stale",
                graphFingerprint: authority.target.graphFingerprint
              },
              value: { name: "stale" }
            })
          ),
          candidate("winner", Promise.resolve(exact("winner")))
        ],
        discard: async () => {
          throw Object.assign(new Error("release failed"), { code: "release_failed" });
        },
        diagnosticCode: (error) =>
          error instanceof Error && "code" in error ? String(error.code) : "unknown",
        diagnose: diagnostics
      })
    ).resolves.toMatchObject({ kind: "available", candidateId: "winner" });
    await vi.waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith({
        candidateId: "stale-local",
        category: "peer_error",
        code: "release_failed"
      })
    );
  });

  it("contains a synchronous discard failure after selecting an exact winner", async () => {
    const diagnostics = vi.fn();
    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate(
            "stale",
            Promise.resolve({
              kind: "available",
              evidence: {
                sourceRevision: "snapshot:stale",
                graphFingerprint: authority.target.graphFingerprint
              },
              value: { name: "stale" }
            })
          ),
          candidate("winner", Promise.resolve(exact("winner")))
        ],
        discard: () => {
          throw Object.assign(new Error("sync release failed"), { code: "sync_release_failed" });
        },
        diagnosticCode: (error) =>
          error instanceof Error && "code" in error ? String(error.code) : "unknown",
        diagnose: diagnostics
      })
    ).resolves.toMatchObject({ kind: "available", candidateId: "winner" });
    await vi.waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith({
        candidateId: "stale",
        category: "peer_error",
        code: "sync_release_failed"
      })
    );
  });

  it("isolates a throwing diagnostic sink from exact and unavailable settlement", async () => {
    const diagnose = vi.fn(() => {
      throw new Error("diagnostic_sink_failed");
    });

    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate("failed", Promise.reject(new Error("peer_failed"))),
          candidate("winner", Promise.resolve(exact("winner")))
        ],
        diagnose
      })
    ).resolves.toMatchObject({ kind: "available", candidateId: "winner" });
    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate("offline", Promise.resolve({ kind: "unavailable", reason: "host_offline" }))
        ],
        diagnose
      })
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "host_offline",
      candidateId: "offline"
    });
  });

  it("returns an exact winner when cancelling a loser throws", async () => {
    const diagnostics = vi.fn();
    const never = new Promise<RuntimeAuthorityCandidateObservation<Value>>(() => undefined);

    await expect(
      firstExactRuntimeAuthorityCandidate({
        authority,
        candidates: [
          candidate("winner", Promise.resolve(exact("winner"))),
          candidate("loser", never, () => {
            throw new Error("cancel_failed");
          })
        ],
        diagnose: diagnostics
      })
    ).resolves.toMatchObject({ kind: "available", candidateId: "winner" });
    expect(diagnostics).toHaveBeenCalledWith({
      candidateId: "loser",
      category: "peer_error",
      code: "runtime_authority_candidate_cancel_failed"
    });
  });
});
