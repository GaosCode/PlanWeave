import { finalArtifactPromptInstruction } from "../autoRun/finalArtifactPromptProjection.js";
import { REVIEW_RESULT_CONTENT_GUIDANCE } from "./reviewResultContract.js";

function renderList(title: string, values: readonly string[]): string {
  return [
    `## ${title}`,
    "",
    ...(values.length === 0 ? ["- None."] : values.map((value) => `- ${value}`))
  ].join("\n");
}

export type RemoteDispatchPromptProjectionInput = {
  ref: string;
  taskId: string;
  blockTitle: string;
  blockType: "implementation" | "review";
  globalPrompt?: string;
  projectPrompt?: string;
  projectCanvasContext?: string;
  planGraphContext: string;
  taskPrompt: string;
  blockPrompt: string;
  acceptance: readonly string[];
  requiredCapabilities: readonly string[];
  sharedResources: readonly string[];
  focusedReviewContext?: readonly string[];
};

/** Single browser-safe projection for every remote-dispatch prompt producer. */
export function renderRemoteDispatchPromptProjection(
  input: RemoteDispatchPromptProjectionInput
): string {
  const sections = [
    `# ${input.ref}: ${input.blockTitle}`,
    input.globalPrompt === undefined ? "" : "## PlanWeave Global Prompt",
    input.globalPrompt?.trim() ?? "",
    input.projectPrompt === undefined ? "" : "## Project Prompt",
    input.projectPrompt?.trim() ?? "",
    input.projectCanvasContext === undefined ? "" : "## Project Canvas Context",
    input.projectCanvasContext?.trim() ?? "",
    "## PlanGraph Claim Context",
    input.planGraphContext.trim(),
    "## Task Node Prompt",
    input.taskPrompt.trim(),
    "## Block Prompt",
    input.blockPrompt.trim(),
    renderList("Task Acceptance", input.acceptance),
    renderList("Required Host Capabilities", input.requiredCapabilities),
    renderList(
      "Shared Resource Hints",
      input.sharedResources.map(
        (resource) =>
          `${resource} (coordination hint only; it does not reserve the resource or block parallel work)`
      )
    ),
    input.focusedReviewContext?.length
      ? renderList("Focused Re-review Context", input.focusedReviewContext)
      : ""
  ];
  if (input.blockType === "review") {
    sections.push(
      [
        "## Required Review Result JSON",
        "",
        "```json",
        JSON.stringify(
          {
            reviewBlockRef: input.ref,
            taskId: input.taskId,
            verdict: "passed | needs_changes",
            content: "review summary and requested changes"
          },
          null,
          2
        ),
        "```",
        "",
        REVIEW_RESULT_CONTENT_GUIDANCE,
        "",
        "Remote Host writeback accepts either:",
        "1) a final response that is exactly this JSON object, or",
        "2) a PLANWEAVE_FINAL_ARTIFACT envelope with artifact.kind = review and the same reviewResult fields."
      ].join("\n")
    );
  } else {
    sections.push(
      [
        "## Suggested Implementation Report Format",
        "",
        "- Summary: what changed and why.",
        "- Changed files: notable files touched and the purpose of each change.",
        "- Verification: commands, checks, or manual validation performed, including the result.",
        "- Notes / risks: unverified items, limitations, or follow-up work."
      ].join("\n")
    );
  }
  return `${[
    sections.filter((section) => section.trim().length > 0).join("\n\n"),
    finalArtifactPromptInstruction({ kind: input.blockType, ref: input.ref, taskId: input.taskId })
  ].join("\n\n")}\n`;
}
