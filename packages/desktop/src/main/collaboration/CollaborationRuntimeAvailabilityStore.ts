import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const identifierSchema = z.string().trim().min(1).max(256);
export const collaborationRuntimeAvailabilityKeySchema = z
  .object({
    profileId: identifierSchema,
    serverOrigin: z.string().url(),
    projectId: identifierSchema,
    localProjectId: identifierSchema,
    localCanvasId: identifierSchema
  })
  .strict();

const recordSchema = z
  .object({
    key: collaborationRuntimeAvailabilityKeySchema,
    availability: canvasRuntimeAvailabilitySchema
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.availability.state.kind === "initialized" &&
      record.availability.state.status.scope.projectId !== record.key.projectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability", "state", "status", "scope", "projectId"],
        message: "runtime_availability_project_scope_mismatch"
      });
    }
  });

const documentSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(10_000)
  })
  .strict();

export type CollaborationRuntimeAvailabilityKey = z.infer<
  typeof collaborationRuntimeAvailabilityKeySchema
>;

export type CollaborationRuntimeAvailabilityStorePort = {
  get(key: CollaborationRuntimeAvailabilityKey): Promise<CanvasRuntimeAvailability | null>;
  put(
    key: CollaborationRuntimeAvailabilityKey,
    availability: CanvasRuntimeAvailability
  ): Promise<CanvasRuntimeAvailability>;
};

const writeLocks = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sameKey(
  left: CollaborationRuntimeAvailabilityKey,
  right: CollaborationRuntimeAvailabilityKey
): boolean {
  return (
    left.profileId === right.profileId &&
    left.serverOrigin === right.serverOrigin &&
    left.projectId === right.projectId &&
    left.localProjectId === right.localProjectId &&
    left.localCanvasId === right.localCanvasId
  );
}

async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  writeLocks.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(path) === queued) writeLocks.delete(path);
  }
}

/** Main-only cache of the last Server-confirmed runtime availability for an exact replica. */
export class CollaborationRuntimeAvailabilityStore
  implements CollaborationRuntimeAvailabilityStorePort
{
  private loaded: z.infer<typeof documentSchema> | null = null;

  constructor(
    private readonly path: string = desktopHomePaths().collaborationRuntimeAvailabilityFile
  ) {}

  async get(input: CollaborationRuntimeAvailabilityKey): Promise<CanvasRuntimeAvailability | null> {
    const key = collaborationRuntimeAvailabilityKeySchema.parse(input);
    const document = await this.read();
    return document.records.find((record) => sameKey(record.key, key))?.availability ?? null;
  }

  async put(
    inputKey: CollaborationRuntimeAvailabilityKey,
    inputAvailability: CanvasRuntimeAvailability
  ): Promise<CanvasRuntimeAvailability> {
    const parsed = recordSchema.parse({ key: inputKey, availability: inputAvailability });
    return withWriteLock(this.path, async () => {
      const document = await this.read();
      const index = document.records.findIndex((record) => sameKey(record.key, parsed.key));
      const records =
        index >= 0
          ? document.records.map((record, recordIndex) => (recordIndex === index ? parsed : record))
          : [...document.records, parsed];
      await this.write(documentSchema.parse({ version: 1, records }));
      return parsed.availability;
    });
  }

  private async read(): Promise<z.infer<typeof documentSchema>> {
    if (this.loaded) return this.loaded;
    try {
      this.loaded = documentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      return this.loaded;
    } catch (error) {
      if (isMissing(error)) {
        this.loaded = { version: 1, records: [] };
        return this.loaded;
      }
      throw new Error("collaboration_runtime_availability_store_invalid", { cause: error });
    }
  }

  private async write(document: z.infer<typeof documentSchema>): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    if (((await stat(this.path)).mode & 0o777) !== 0o600) await chmod(this.path, 0o600);
    this.loaded = document;
  }
}
