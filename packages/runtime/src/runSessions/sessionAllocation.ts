import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { optionalReaddir } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";

const sessionIdPattern = /^SESSION-(\d{4,})$/;
const allocationSchema = z
  .object({
    version: z.literal(1),
    highestAllocated: z.number().int().nonnegative().safe()
  })
  .strict();
const legacyReferenceSchema = z
  .object({ runSessionId: z.string().nullable().optional() })
  .passthrough();

function sessionNumber(value: string): number {
  const match = sessionIdPattern.exec(value);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number))
    throw new Error(`Run session id '${value}' exceeds safe allocation range.`);
  return number;
}

async function legacyHighWater(workspace: ProjectWorkspace): Promise<number> {
  let highest = 0;
  async function scan(directory: string): Promise<void> {
    for (const entry of (await optionalReaddir(directory, { withFileTypes: true })) ?? []) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === join(workspace.resultsDir, "run-sessions")) {
          highest = Math.max(highest, sessionNumber(entry.name));
        } else if (!entry.name.startsWith(".")) {
          await scan(path);
        }
      } else if (
        entry.isFile() &&
        (entry.name === "metadata.json" ||
          (entry.name === "state.json" &&
            directory.startsWith(join(workspace.resultsDir, "auto-runs") + sep)))
      ) {
        const raw = await readFile(path, "utf8");
        const reference = legacyReferenceSchema.parse(JSON.parse(raw));
        if (reference.runSessionId)
          highest = Math.max(highest, sessionNumber(reference.runSessionId));
      }
    }
  }
  await scan(workspace.resultsDir);
  return highest;
}

function allocationPath(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "run-sessions", ".session-sequence.json");
}

/** Caller holds current session storage admission; retain consumed ids through pruning. */
export async function ensureSessionAllocation(workspace: ProjectWorkspace): Promise<number> {
  try {
    const raw = await readFile(allocationPath(workspace), "utf8");
    return allocationSchema.parse(JSON.parse(raw)).highestAllocated;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const highestAllocated = await legacyHighWater(workspace);
  await writeJsonFile(allocationPath(workspace), { version: 1, highestAllocated });
  return highestAllocated;
}

export async function allocateSessionId(workspace: ProjectWorkspace): Promise<string> {
  const highestAllocated = (await ensureSessionAllocation(workspace)) + 1;
  if (!Number.isSafeInteger(highestAllocated))
    throw new Error("Run session allocation range exhausted.");
  await writeJsonFile(allocationPath(workspace), { version: 1, highestAllocated });
  return `SESSION-${String(highestAllocated).padStart(4, "0")}`;
}
