export type ReviewResultContractInput = {
  resultPath: string;
  reviewBlockRef: string;
  taskId: string;
};

export function reviewResultEnvironment(input: ReviewResultContractInput): NodeJS.ProcessEnv {
  return {
    PLANWEAVE_REVIEW_RESULT_PATH: input.resultPath,
    PLANWEAVE_REVIEW_BLOCK_REF: input.reviewBlockRef,
    PLANWEAVE_TASK_ID: input.taskId
  };
}

export function appendReviewResultFileInstruction(prompt: string, input: ReviewResultContractInput): string {
  return [
    prompt.trimEnd(),
    "",
    "## Auto Run Review Result File",
    "",
    `Write the required review result JSON to this exact file path: \`${input.resultPath}\`.`,
    "",
    "The file content must be one JSON object with this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        reviewBlockRef: input.reviewBlockRef,
        taskId: input.taskId,
        verdict: "passed | needs_changes",
        content: "review summary and requested changes"
      },
      null,
      2
    ),
    "```",
    "",
    "You may print a human-readable review report to stdout. PlanWeave will parse only the JSON file above, not stdout."
  ].join("\n");
}
