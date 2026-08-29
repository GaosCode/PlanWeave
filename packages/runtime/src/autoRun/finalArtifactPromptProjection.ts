import { REVIEW_RESULT_CONTENT_GUIDANCE } from "../taskManager/reviewResultContract.js";
import { FINAL_ARTIFACT_MARKER } from "./finalArtifactEnvelope.js";

export type ExpectedFinalArtifactIdentity =
  | { kind: "implementation"; ref: string; taskId: string }
  | { kind: "review"; ref: string; taskId: string }
  | {
      kind: "feedback";
      feedbackId: string;
      sourceReviewBlockRef: string;
      taskId: string;
    };

function finalArtifactPromptTemplate(expected: ExpectedFinalArtifactIdentity): object {
  if (expected.kind === "implementation") {
    return {
      version: "planweave.runner-artifact/v1",
      artifact: {
        kind: "implementation",
        ref: expected.ref,
        taskId: expected.taskId,
        reportMarkdown: ""
      }
    };
  }
  if (expected.kind === "review") {
    return {
      version: "planweave.runner-artifact/v1",
      artifact: {
        kind: "review",
        ref: expected.ref,
        taskId: expected.taskId,
        reviewResult: {
          reviewBlockRef: expected.ref,
          taskId: expected.taskId,
          verdict: "passed|needs_changes",
          content: ""
        }
      }
    };
  }
  return {
    version: "planweave.runner-artifact/v1",
    artifact: {
      kind: "feedback",
      feedbackId: expected.feedbackId,
      sourceReviewBlockRef: expected.sourceReviewBlockRef,
      taskId: expected.taskId,
      reportMarkdown: ""
    }
  };
}

export function finalArtifactPromptInstruction(expected: ExpectedFinalArtifactIdentity): string {
  const contentField = expected.kind === "review" ? "reviewResult.content" : "reportMarkdown";
  const reviewInstruction =
    expected.kind === "review"
      ? " Replace reviewResult.verdict with exactly passed or needs_changes."
      : "";
  return [
    "PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT",
    "After completing the assigned work, your final response MUST contain exactly one PLANWEAVE_FINAL_ARTIFACT marker followed by one JSON object. Put it on a standalone final line when possible; the transport may omit the trailing newline.",
    `Use this exact envelope and identity: ${FINAL_ARTIFACT_MARKER}${JSON.stringify(finalArtifactPromptTemplate(expected))}`,
    `Replace ${contentField} with your agent-authored, non-empty result.${reviewInstruction}`,
    expected.kind === "review" ? REVIEW_RESULT_CONTENT_GUIDANCE : "",
    "Do not use a Markdown fence, do not emit text after the JSON object, and do not emit more than one PLANWEAVE_FINAL_ARTIFACT marker."
  ]
    .filter(Boolean)
    .join("\n");
}
