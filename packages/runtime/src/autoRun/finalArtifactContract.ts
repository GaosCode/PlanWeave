import {
  REVIEW_RESULT_CONTENT_GUIDANCE,
  type ReviewResult
} from "../taskManager/reviewResultContract.js";
import {
  RUNNER_ARTIFACT_MAX_CONTENT_BYTES,
  materializeArtifactBytes
} from "./artifactReferenceContract.js";
import type { ArtifactReference } from "./runnerContractSchemas.js";
import {
  FINAL_ARTIFACT_MARKER,
  finalArtifactEnvelopeSchema,
  type FinalArtifact,
  type FinalArtifactEnvelope
} from "./finalArtifactEnvelope.js";
export {
  FINAL_ARTIFACT_MARKER,
  finalArtifactEnvelopeSchema,
  type FinalArtifact,
  type FinalArtifactEnvelope
} from "./finalArtifactEnvelope.js";
export const FINAL_ARTIFACT_MAX_LINE_BYTES = 1 * 1_024 * 1_024;
export const FINAL_ARTIFACT_MAX_CONTENT_BYTES = RUNNER_ARTIFACT_MAX_CONTENT_BYTES;

export function finalArtifactRelativePath(kind: FinalArtifact["kind"]): string {
  if (kind === "review") return "review-result.json";
  if (kind === "feedback") return "feedback-report.md";
  return "report.md";
}

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

export type FinalArtifactContractErrorCode =
  | "missing"
  | "multiple"
  | "malformed"
  | "truncated"
  | "mismatched"
  | "limit_exceeded";

export class FinalArtifactContractError extends Error {
  constructor(
    readonly code: FinalArtifactContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FinalArtifactContractError";
  }
}

function contentBytes(artifact: FinalArtifact): number {
  if (artifact.kind === "review") {
    return Buffer.byteLength(JSON.stringify(artifact.reviewResult), "utf8");
  }
  return Buffer.byteLength(artifact.reportMarkdown, "utf8");
}

function assertExpectedIdentity(
  envelope: FinalArtifactEnvelope,
  expected: ExpectedFinalArtifactIdentity
): void {
  const artifact = envelope.artifact;
  if (artifact.kind !== expected.kind) {
    throw new FinalArtifactContractError(
      "mismatched",
      `Expected ${expected.kind} final artifact, received ${artifact.kind}.`
    );
  }
  if (artifact.kind === "feedback" && expected.kind === "feedback") {
    if (
      artifact.feedbackId !== expected.feedbackId ||
      artifact.sourceReviewBlockRef !== expected.sourceReviewBlockRef ||
      artifact.taskId !== expected.taskId
    ) {
      throw new FinalArtifactContractError(
        "mismatched",
        "Feedback final artifact identity does not match the active feedback claim."
      );
    }
    return;
  }
  if (artifact.kind !== "feedback" && expected.kind !== "feedback") {
    if (artifact.ref !== expected.ref || artifact.taskId !== expected.taskId) {
      throw new FinalArtifactContractError(
        "mismatched",
        "Final artifact ref/task identity does not match the active block claim."
      );
    }
  }
}

export function validateFinalArtifactEnvelope(
  input: unknown,
  expected: ExpectedFinalArtifactIdentity
): FinalArtifactEnvelope {
  const parsed = finalArtifactEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new FinalArtifactContractError(
      "malformed",
      `Final artifact envelope is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  if (contentBytes(parsed.data.artifact) > FINAL_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new FinalArtifactContractError(
      "limit_exceeded",
      `Final artifact content exceeds ${FINAL_ARTIFACT_MAX_CONTENT_BYTES} bytes.`
    );
  }
  assertExpectedIdentity(parsed.data, expected);
  return parsed.data;
}

export function encodeFinalArtifactEnvelope(envelope: FinalArtifactEnvelope): string {
  const parsed = finalArtifactEnvelopeSchema.parse(envelope);
  if (contentBytes(parsed.artifact) > FINAL_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new FinalArtifactContractError(
      "limit_exceeded",
      `Final artifact content exceeds ${FINAL_ARTIFACT_MAX_CONTENT_BYTES} bytes.`
    );
  }
  const line = `${FINAL_ARTIFACT_MARKER}${JSON.stringify(parsed)}`;
  if (Buffer.byteLength(line, "utf8") > FINAL_ARTIFACT_MAX_LINE_BYTES) {
    throw new FinalArtifactContractError(
      "limit_exceeded",
      `Final artifact line exceeds ${FINAL_ARTIFACT_MAX_LINE_BYTES} bytes.`
    );
  }
  return `${line}\n`;
}

function containsMarkerOutsideJsonString(value: string): boolean {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (value.startsWith(FINAL_ARTIFACT_MARKER, index)) return true;
  }
  return false;
}

export function extractFinalArtifactEnvelope(
  output: string,
  expected: ExpectedFinalArtifactIdentity
): FinalArtifactEnvelope {
  const markerIndex = output.indexOf(FINAL_ARTIFACT_MARKER);
  if (markerIndex < 0) {
    throw new FinalArtifactContractError("missing", "Final artifact marker was not found.");
  }
  const afterMarker = output.slice(markerIndex + FINAL_ARTIFACT_MARKER.length);
  if (containsMarkerOutsideJsonString(afterMarker)) {
    throw new FinalArtifactContractError(
      "multiple",
      "Expected exactly one final artifact marker, received more than one."
    );
  }
  const framed = output.slice(markerIndex);
  const hasTerminalNewline = framed.endsWith("\n");
  const serialized = hasTerminalNewline
    ? framed.slice(0, framed.endsWith("\r\n") ? -2 : -1).slice(FINAL_ARTIFACT_MARKER.length)
    : framed.slice(FINAL_ARTIFACT_MARKER.length);
  if (serialized.includes("\n") || serialized.includes("\r")) {
    throw new FinalArtifactContractError(
      "malformed",
      "Final artifact JSON must be the final response content after its marker."
    );
  }
  if (serialized.trim() !== serialized) {
    throw new FinalArtifactContractError(
      "malformed",
      "Final artifact JSON cannot have whitespace outside its JSON object."
    );
  }
  if (
    Buffer.byteLength(`${FINAL_ARTIFACT_MARKER}${serialized}`, "utf8") >
    FINAL_ARTIFACT_MAX_LINE_BYTES
  ) {
    throw new FinalArtifactContractError(
      "limit_exceeded",
      `Final artifact line exceeds ${FINAL_ARTIFACT_MAX_LINE_BYTES} bytes.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    throw new FinalArtifactContractError(
      hasTerminalNewline ? "malformed" : "truncated",
      `Final artifact JSON is malformed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateFinalArtifactEnvelope(raw, expected);
}

export function implementationArtifactEnvelope(input: {
  ref: string;
  taskId: string;
  reportMarkdown: string;
}): FinalArtifactEnvelope {
  return validateFinalArtifactEnvelope(
    { version: "planweave.runner-artifact/v1", artifact: { kind: "implementation", ...input } },
    { kind: "implementation", ref: input.ref, taskId: input.taskId }
  );
}

export function reviewArtifactEnvelope(input: {
  ref: string;
  taskId: string;
  reviewResult: ReviewResult;
}): FinalArtifactEnvelope {
  return validateFinalArtifactEnvelope(
    { version: "planweave.runner-artifact/v1", artifact: { kind: "review", ...input } },
    { kind: "review", ref: input.ref, taskId: input.taskId }
  );
}

export function feedbackArtifactEnvelope(input: {
  feedbackId: string;
  sourceReviewBlockRef: string;
  taskId: string;
  reportMarkdown: string;
}): FinalArtifactEnvelope {
  return validateFinalArtifactEnvelope(
    { version: "planweave.runner-artifact/v1", artifact: { kind: "feedback", ...input } },
    {
      kind: "feedback",
      feedbackId: input.feedbackId,
      sourceReviewBlockRef: input.sourceReviewBlockRef,
      taskId: input.taskId
    }
  );
}

export async function materializeFinalArtifact(options: {
  envelope: FinalArtifactEnvelope;
  expected: ExpectedFinalArtifactIdentity;
  rootDir: string;
  relativePath: string;
}): Promise<ArtifactReference> {
  const envelope = validateFinalArtifactEnvelope(options.envelope, options.expected);
  const content =
    envelope.artifact.kind === "review"
      ? `${JSON.stringify(envelope.artifact.reviewResult, null, 2)}\n`
      : envelope.artifact.reportMarkdown;
  return materializeArtifactBytes({
    rootDir: options.rootDir,
    relativePath: options.relativePath,
    kind: envelope.artifact.kind,
    content
  });
}
