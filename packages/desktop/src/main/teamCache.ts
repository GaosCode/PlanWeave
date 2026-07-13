import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopHomePaths } from "./planweaveHomePaths.js";

export type TeamCache = {
  updatedAt: string;
  projectSnapshot?: unknown;
  coordination?: unknown;
  tasks?: unknown;
  assignments?: unknown;
  mergeQueue?: unknown;
  rooms?: unknown;
};

function cachePath(profileId: string, projectId: string): string {
  if (!/^[0-9a-f]{16}$/.test(profileId)) throw new Error("Invalid remote profile id");
  const projectKey = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 32);
  return join(desktopHomePaths().planweaveHome, "desktop", "team-cache", profileId, `${projectKey}.json`);
}

export async function readTeamCache(profileId: string, projectId: string): Promise<TeamCache | null> {
  try { return JSON.parse(await readFile(cachePath(profileId, projectId), "utf8")) as TeamCache; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

export async function updateTeamCache(profileId: string, projectId: string, patch: Omit<Partial<TeamCache>, "updatedAt">): Promise<void> {
  const path = cachePath(profileId, projectId);
  const current = await readTeamCache(profileId, projectId) ?? { updatedAt: new Date(0).toISOString() };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
