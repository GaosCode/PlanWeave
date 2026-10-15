import { statSync, type Stats } from "node:fs";
import { optionalStat } from "./optionalFile.js";

export type ProjectRootIdentity = { dev: number; ino: number; birthtimeMs: number } | null;

function rootIdentity(info: Stats | null): ProjectRootIdentity {
  return info ? { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs } : null;
}

/** Capture before yielding when queue admission must bind an existing project instance. */
export function captureProjectRootIdentitySync(root: string): ProjectRootIdentity {
  return rootIdentity(statSync(root));
}

export async function captureProjectRootIdentity(root: string): Promise<ProjectRootIdentity> {
  return rootIdentity(await optionalStat(root));
}

/** Caller holds the stable parent lock, including when the root has been replaced. */
export async function assertProjectRootIdentity(
  root: string,
  captured: ProjectRootIdentity
): Promise<void> {
  const current = await captureProjectRootIdentity(root);
  if (
    current?.dev !== captured?.dev ||
    current?.ino !== captured?.ino ||
    current?.birthtimeMs !== captured?.birthtimeMs
  ) {
    throw new Error(`PlanWeave project workspace identity changed at '${root}'.`);
  }
}
