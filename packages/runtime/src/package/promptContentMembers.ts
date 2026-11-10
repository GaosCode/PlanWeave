import {
  normalizeContentVersionPromptPath,
  packageFileNamespaceConflict,
  type ContentVersionMemberKind
} from "@planweave-ai/collaboration-protocol/content/version";
import type { PlanPackageManifest } from "../types.js";

export function manifestPromptContentMembers(
  manifest: PlanPackageManifest
): Map<string, Exclude<ContentVersionMemberKind, "manifest" | "desktop_layout">> {
  const roles = new Map<string, Set<"task" | "block">>();
  const add = (path: string, role: "task" | "block") => {
    const normalized = normalizeContentVersionPromptPath(path);
    const existing = roles.get(normalized) ?? new Set<"task" | "block">();
    existing.add(role);
    roles.set(normalized, existing);
  };
  for (const task of manifest.nodes) {
    add(task.prompt, "task");
    for (const block of task.blocks) add(block.prompt, "block");
  }
  const namespaceConflict = packageFileNamespaceConflict(["manifest.json", ...roles.keys()]);
  if (namespaceConflict) throw new Error(namespaceConflict);
  return new Map(
    [...roles].map(([path, owners]) => [
      path,
      owners.size === 2 ? "shared_prompt" : owners.has("task") ? "task_prompt" : "block_prompt"
    ])
  );
}

export function manifestPromptMarkdownByPath(
  manifest: PlanPackageManifest,
  contentByNormalizedPath: ReadonlyMap<string, string>
): Map<string, string> {
  const logical = new Map<string, string>();
  for (const task of manifest.nodes) {
    for (const path of [task.prompt, ...task.blocks.map((block) => block.prompt)]) {
      const markdown = contentByNormalizedPath.get(normalizeContentVersionPromptPath(path));
      if (markdown === undefined) throw new Error(`content_version_prompt_missing:${path}`);
      logical.set(path, markdown);
    }
  }
  return logical;
}
