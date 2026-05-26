import type { SchemaDocument } from "./types.js";

export const stateSchemaDocument: SchemaDocument = {
  name: "state",
  summary: "Runtime execution state schema.",
  path: "state.json at the CLI-returned statePath",
  ownership: "Runtime owned. Do not hand-author during plan import; use claim/submit/recovery commands.",
  validation: ["planweave status --json", "planweave doctor", "planweave doctor --repair for narrow state/results drift only"],
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
        status: ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"],
        lastRunId: "string | null, optional",
        latestReviewAttemptId: "string | null, optional",
        activeFeedbackId: "string | null, optional",
        blockedReason: "string | null, optional",
        divergenceReason: "string | null, optional",
        completionReason: ["passed", "max_cycles_reached", null],
        passedWorkRevision: "string | null, optional"
      }
    },
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
    "Manifest edits can make old state refs stale; run validate/status/doctor instead of editing state by hand.",
    "Feedback is runtime state; do not create feedback blocks in package/manifest.json."
  ]
};
