import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  desktopWorkspaceExecutionStartInputSchema,
  desktopWorkspaceExecutionStartCancellationInputSchema,
  type DesktopWorkspaceExecutionStartInput,
  type DesktopWorkspaceExecutionStartCancellationInput
} from "../shared/workspaceExecution.js";

const intentSchema = z
  .object({
    input: desktopWorkspaceExecutionStartInputSchema,
    settled: z.boolean(),
    owner: z
      .object({ pid: z.number().int().positive(), instanceId: z.string().uuid() })
      .strict()
      .optional(),
    cancellationConfirmed: z.boolean(),
    cancellation: desktopWorkspaceExecutionStartCancellationInputSchema.nullable()
  })
  .strict();
type StartIntent = z.infer<typeof intentSchema>;
const processOwner = { pid: process.pid, instanceId: randomUUID() };

export function workspaceStartDispatchKey(startRequestId: string): string {
  return `workspace-execution-${startRequestId}`;
}

export class WorkspaceExecutionStartIntents {
  readonly owner = processOwner;

  constructor(private readonly root: string) {}

  ownerHasEnded(intent: StartIntent): boolean {
    const owner = intent.owner;
    if (!owner) return false;
    if (owner.pid === processOwner.pid) return owner.instanceId !== processOwner.instanceId;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ESRCH") return true;
        if (error.code === "EPERM") return false;
      }
      throw error;
    }
  }

  private directory(locator: DesktopWorkspaceExecutionStartInput["locator"]) {
    return join(
      this.root,
      "start-intents",
      createHash("sha256")
        .update(JSON.stringify(Object.entries(locator).sort(([a], [b]) => a.localeCompare(b))))
        .digest("hex")
    );
  }

  private path(input: DesktopWorkspaceExecutionStartInput) {
    if (!input.startRequestId) throw new Error("workspace_execution_start_identity_required");
    return join(
      this.directory(input.locator),
      `${createHash("sha256").update(input.startRequestId).digest("hex")}.json`
    );
  }

  async read(input: DesktopWorkspaceExecutionStartInput): Promise<StartIntent | null> {
    try {
      const intent = intentSchema.parse(JSON.parse(await readFile(this.path(input), "utf8")));
      if (!isDeepStrictEqual(intent.input, input))
        throw new Error("workspace_execution_resume_mismatch");
      return intent;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }

  async write(intent: StartIntent): Promise<void> {
    const target = this.path(intent.input);
    await mkdir(this.directory(intent.input.locator), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(intentSchema.parse(intent)), { mode: 0o600 });
    await rename(temporary, target);
  }

  async recover(
    locator: DesktopWorkspaceExecutionStartInput["locator"]
  ): Promise<DesktopWorkspaceExecutionStartCancellationInput[]> {
    const directory = this.directory(locator);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          intentSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")))
        )
    );
    return records.flatMap((record) => {
      if (!isDeepStrictEqual(record.input.locator, locator))
        throw new Error("workspace_execution_resume_mismatch");
      return record.cancellation && !record.cancellationConfirmed ? [record.cancellation] : [];
    });
  }
}
