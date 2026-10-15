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
    cancellationConfirmed: z.boolean(),
    cancellation: desktopWorkspaceExecutionStartCancellationInputSchema.nullable()
  })
  .strict();
type StartIntent = z.infer<typeof intentSchema>;

export function workspaceStartDispatchKey(startRequestId: string): string {
  return `workspace-execution-${startRequestId}`;
}

export class WorkspaceExecutionStartIntents {
  constructor(private readonly root: string) {}

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
