import { isAbsolute, relative } from "node:path";
import { toPackagePosixPath } from "../../package/packagePosixPath.js";
import type { ExecutionGraphSession, PackageFileChange } from "../../types.js";
import { requireMapValue } from "../requireMapValue.js";
import {
  packagePromptOwners,
  promptReferenceKey,
  promptWatchAliases
} from "../../package/promptInventory.js";

export function promptPathToRefs(session: ExecutionGraphSession, path: string): string[] {
  const key = toPackagePosixPath(promptReferenceKey(path));
  const targets = session.fileSnapshot.promptTargets;
  const paths = (targets && promptWatchAliases(targets).get(key)) ?? [key];
  const owners = packagePromptOwners(session.fileSnapshot.manifest);
  return paths.flatMap((logicalPath) =>
    (owners.get(logicalPath) ?? []).flatMap(({ kind, ref, taskId }) =>
      kind === "task" ? requireMapValue(session.graph.blocksByTask, taskId, "blocksByTask") : [ref]
    )
  );
}

export function dedupeFileChanges(changes: PackageFileChange[]): PackageFileChange[] {
  return [...new Map(changes.map((change) => [change.path, change])).values()];
}

export function normalizePackagePath(session: ExecutionGraphSession, path: string): string {
  const relativePath = isAbsolute(path) ? relative(session.packageRoot, path) : path;
  return toPackagePosixPath(relativePath);
}
