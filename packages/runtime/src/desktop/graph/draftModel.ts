import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../../types.js";
import type { DesktopTaskDraft } from "../types.js";
import { getTask } from "./graphHelpers.js";

function draftTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "New task").replace(/^#+\s*/, "").slice(0, 80);
}

function acceptanceFromText(text: string): string[] {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0)
    .slice(0, 3);
  return bullets.length > 0 ? bullets : ["Task is implemented and reviewed."];
}

export async function createTaskDraft(
  projectRoot: PackageWorkspaceRef,
  input: {
    mode: "task" | "blocks" | "document";
    text: string;
    targetTaskId?: string | null;
  }
): Promise<DesktopTaskDraft> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Task draft text must not be empty.");
  }
  if (input.mode === "blocks") {
    if (!input.targetTaskId) {
      throw new Error("Appending blocks requires a target task.");
    }
    getTask(compileTaskGraph((await loadPackage(projectRoot)).manifest), input.targetTaskId);
    return {
      mode: "blocks",
      targetTaskId: input.targetTaskId,
      tasks: [],
      blocks: [
        {
          taskId: input.targetTaskId,
          type: "implementation",
          title: draftTitle(text),
          promptMarkdown: text
        }
      ]
    };
  }
  if (input.mode === "document") {
    const sections = text
      .split(/\n(?=#+\s+)/)
      .map((section) => section.trim())
      .filter(Boolean);
    const taskSections = sections.length > 1 ? sections : [text];
    return {
      mode: "document",
      targetTaskId: null,
      tasks: taskSections.slice(0, 6).map((section) => ({
        title: draftTitle(section),
        promptMarkdown: section,
        acceptance: acceptanceFromText(section),
        blockTypes: ["implementation", "review"]
      })),
      blocks: []
    };
  }
  return {
    mode: "task",
    targetTaskId: null,
    tasks: [
      {
        title: draftTitle(text),
        promptMarkdown: text,
        acceptance: acceptanceFromText(text),
        blockTypes: ["implementation", "review"]
      }
    ],
    blocks: []
  };
}
