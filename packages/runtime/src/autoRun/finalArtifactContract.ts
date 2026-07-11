import { z } from "zod";
import { reviewResultSchema, type ReviewResult } from "../taskManager/reviewResultContract.js";
import {
  RUNNER_ARTIFACT_MAX_CONTENT_BYTES,
  materializeArtifactBytes
} from "./artifactReferenceContract.js";
import type { ArtifactReference } from "./runnerContractSchemas.js";

export const FINAL_ARTIFACT_MARKER = "PLANWEAVE_FINAL_ARTIFACT ";
export const FINAL_ARTIFACT_MAX_LINE_BYTES = 1 * 1_024 * 1_024;
export const FINAL_ARTIFACT_MAX_CONTENT_BYTES = RUNNER_ARTIFACT_MAX_CONTENT_BYTES;

const implementationArtifactSchema = z
  .object({
    kind: z.literal("implementation"),
    ref: z.string().min(1),
    taskId: z.string().min(1),
    reportMarkdown: z.string().refine((value) => value.trim().length > 0, "Report must not be blank.")
  })
  .strict();
const reviewArtifactSchema = z
  .object({
    kind: z.literal("review"),
    ref: z.string().min(1),
    taskId: z.string().min(1),
    reviewResult: reviewResultSchema
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      artifact.reviewResult.reviewBlockRef !== artifact.ref ||
      artifact.reviewResult.taskId !== artifact.taskId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewResult"],
        message: "Review result identity must match the artifact ref and taskId."
      });
    }
  });
const feedbackArtifactSchema = z
  .object({
    kind: z.literal("feedback"),
    feedbackId: z.string().min(1),
    sourceReviewBlockRef: z.string().min(1),
    taskId: z.string().min(1),
    reportMarkdown: z.string().refine((value) => value.trim().length > 0, "Report must not be blank.")
  })
  .strict();

export const finalArtifactEnvelopeSchema = z
  .object({
    version: z.literal("planweave.runner-artifact/v1"),
    artifact: z.discriminatedUnion("kind", [
      implementationArtifactSchema,
      reviewArtifactSchema,
      feedbackArtifactSchema
    ])
  })
  .strict();
export type FinalArtifactEnvelope = z.infer<typeof finalArtifactEnvelopeSchema>;
export type FinalArtifact = FinalArtifactEnvelope["artifact"];

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

export function extractFinalArtifactEnvelope(
  output: string,
  expected: ExpectedFinalArtifactIdentity
): FinalArtifactEnvelope {
  const complete = output.endsWith("\n");
  const lines = output.split(/\r?\n/);
  if (!complete) {
    const partial = lines.at(-1) ?? "";
    if (partial.startsWith(FINAL_ARTIFACT_MARKER)) {
      throw new FinalArtifactContractError(
        "truncated",
        "Final artifact marker is on an unterminated line."
      );
    }
  }
  const framed = lines.filter((line) => line.startsWith(FINAL_ARTIFACT_MARKER));
  if (framed.length === 0) {
    throw new FinalArtifactContractError("missing", "Final artifact marker was not found.");
  }
  if (framed.length !== 1) {
    throw new FinalArtifactContractError(
      "multiple",
      `Expected exactly one final artifact marker, received ${framed.length}.`
    );
  }
  const line = framed[0];
  if (Buffer.byteLength(line, "utf8") > FINAL_ARTIFACT_MAX_LINE_BYTES) {
    throw new FinalArtifactContractError(
      "limit_exceeded",
      `Final artifact line exceeds ${FINAL_ARTIFACT_MAX_LINE_BYTES} bytes.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(FINAL_ARTIFACT_MARKER.length));
  } catch (error) {
    throw new FinalArtifactContractError(
      "malformed",
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
