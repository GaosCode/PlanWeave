import { optionalStat } from "./optionalFile.js";

export type ProjectRootIdentity = { dev: number; ino: number; birthtimeMs: number } | null;

export async function captureProjectRootIdentity(root: string): Promise<ProjectRootIdentity> {
  const info = await optionalStat(root);
  return info ? { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs } : null;
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
