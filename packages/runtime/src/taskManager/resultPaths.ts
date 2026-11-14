import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalFileTarget } from "../fs/canonicalFileTarget.js";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { identifierSegmentRequirement, isIdentifierSegment } from "../schema/identifierSegment.js";
import { submissionRunIdSchema } from "../schema/runtimeState.js";

export class ResultsPathError extends Error {
  code = "results_path_outside" as const;
}

function assertResultsPathSegment(segment: string): void {
  if (!isIdentifierSegment(segment)) {
    throw new ResultsPathError(
      `Invalid Results path segment ${JSON.stringify(segment)}. ${identifierSegmentRequirement}`
    );
  }
}

export function assertResultsRunId(runId: string): void {
  if (!submissionRunIdSchema.safeParse(runId).success) {
    throw new ResultsPathError(
      `Submission runId must be a non-hidden single directory name. Received ${JSON.stringify(runId)}.`
    );
  }
  assertResultsPathSegment(runId);
}

function assertResultsDescendant(root: string, target: string, path: string): string {
  const fromRoot = relative(root, target);
  if (fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)) {
    return fromRoot;
  }
  throw new ResultsPathError(
    `Results path '${path}' points outside the Results directory '${root}' or to its root.`
  );
}

async function optionalPathEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return null;
    throw error;
  }
}

export async function resolveResultsPath(
  resultsDir: string,
  ...segments: string[]
): Promise<string> {
  for (const segment of segments) assertResultsPathSegment(segment);

  const root = resolve(resultsDir);
  const candidate = join(root, ...segments);
  assertResultsDescendant(root, candidate, candidate);
  const realRoot = await canonicalFileTarget(root);
  let target = realRoot;
  for (const segment of segments) {
    target = join(target, segment);
    const entry = await optionalPathEntry(target);
    if (!entry) break;
    if (entry.isSymbolicLink()) {
      try {
        target = await realpath(target);
      } catch (error) {
        if (!isNodeFileNotFoundError(error)) throw error;
        throw new ResultsPathError(
          `Results path '${candidate}' contains an unresolved symbolic link at '${target}'.`,
          { cause: error }
        );
      }
      assertResultsDescendant(realRoot, target, candidate);
    }
  }
  return candidate;
}

export function assertResultsPath(resultsDir: string, path: string): Promise<string> {
  const fromRoot = assertResultsDescendant(resolve(resultsDir), resolve(path), path);
  return resolveResultsPath(resultsDir, ...fromRoot.split(sep));
}
