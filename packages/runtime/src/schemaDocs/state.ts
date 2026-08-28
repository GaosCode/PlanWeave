import type { SchemaDocument } from "./types.js";

export const stateSchemaDocument: SchemaDocument<"state"> = {
  name: "state",
  summary: "Runtime execution state schema.",
  path: "CLI-returned statePath; default canvas uses canvases/default/state.json",
  ownership:
    "Runtime owned. Do not hand-author during plan import; use claim/submit/recovery commands.",
  validation: [
    "planweave status --json",
    "planweave doctor",
    "planweave doctor --repair for narrow state/results drift only"
  ],
  schema: {
    currentRefs: "block ref string[]",
    currentFeedbackId: "feedback id string | null",
    currentReviewBlockRef: "review block ref string | null",
    tasks: {
      "[taskId]": {
        status: ["planned", "ready", "in_progress", "implemented"],
        openFeedbackCount: "integer"
      }
    },
    blocks: {
      "[blockRef]": {
        status: [
          "planned",
          "ready",
          "in_progress",
          "completed",
          "needs_changes",
          "blocked",
          "diverged"
        ],
        lastRunId: "string | null, optional",
        latestReviewAttemptId: "string | null, optional",
        activeFeedbackId: "string | null, optional",
        pendingFeedbackId: "string | null, optional",
        blockedReason: "string | null, optional",
        divergenceReason: "string | null, optional",
        completionReason: ["passed", "max_cycles_reached", null],
        passedWorkRevision: "string | null, optional",
        remoteOwnership: {
          description:
            "optional; absent for local/manual/CLI/ACP execution; valid for remote implementation and review blocks",
          preparing: {
            phase: "preparing",
            operationId: "bounded portable identifier",
            controlPlane: "owner | collaboration; optional only on legacy records",
            sourceRevision: "bounded portable source revision",
            graphFingerprint: "bounded portable graph fingerprint"
          },
          active: {
            phase: "active",
            operationId: "same identifier as preparing",
            controlPlane: "same control plane as preparing",
            sourceRevision: "same revision as preparing",
            graphFingerprint: "same fingerprint as preparing",
            dispatchId: "exact distributed dispatch identifier",
            executionAttemptId: "exact distributed execution-attempt identifier"
          }
        },
        remoteInterruption: {
          description: "optional; present only on a diverged block with active remote ownership",
          reason: "bounded distributed interruption reason",
          resumable: "boolean; whether only the exact attempt may resume"
        },
        remoteOperationReceipt: {
          description:
            "optional terminal idempotency evidence for remote implementation/review operations; never an active owner; completed or failed only",
          completed:
            "exact operation/source/dispatch/attempt identity plus the authoritative runId",
          failed: "exact operation/source/dispatch/attempt identity plus normalized public failure"
        }
      }
    },
    lastResetReceipt:
      "optional durable operation/source/fingerprint evidence written atomically with a Runtime reset",
    feedback: {
      "[feedbackId]": {
        status: ["open", "in_progress", "resolved", "dismissed"],
        sourceReviewBlockRef: "review block ref string",
        latestSubmissionId: "string | null",
        content: "string"
      }
    }
  },
  notes: [
    "State is derived from manifest plus runtime actions.",
    "Use status --json, explain, doctor, or Desktop read models for the canonical remoteExecution projection; it exposes the Owner/collaboration control plane plus logical operation/source/dispatch-attempt identity, lifecycle phase/status, and Runtime-derived actionRequired.",
    "Remote ownership is valid only for in_progress or diverged implementation/review blocks; completed, blocked, and reset state never retain an active owner.",
    "Terminal remote receipts are immutable idempotency evidence and are cleared by reset, unblock, or later local recovery mutations.",
    "Remote failure receipts preserve retryability, retain Runtime-owned public codes, expose report_output_missing as Remote ACP execution completed without report output and report_output_too_large as Remote ACP report output exceeded its artifact contract, keep redacted diagnostics for selected ACP codes (such as acp_unknown_error), and normalize every other unknown wire code to remote_execution_failed with message Remote execution failed.",
    "Manifest edits can make old state refs stale; run validate/status/doctor instead of editing state by hand.",
    "Feedback is runtime state; do not create feedback blocks in the Plan Package manifest."
  ]
};
