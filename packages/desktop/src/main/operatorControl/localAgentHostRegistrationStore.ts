import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const registrationIdentifierSchema = z.string().trim().min(1).max(128);

const registrationSchema = z
  .object({
    profileId: registrationIdentifierSchema,
    instanceKey: registrationIdentifierSchema,
    workspaceId: registrationIdentifierSchema.optional(),
    updatedAt: z.iso.datetime(),
    generation: z.uuid()
  })
  .strict();

const legacyRegistrationSchema = z
  .object({
    profileId: registrationIdentifierSchema,
    workspaceId: registrationIdentifierSchema,
    updatedAt: z.iso.datetime()
  })
  .strict();

function rejectDuplicateProfiles(
  value: { registrations: readonly { profileId: string }[] },
  context: z.RefinementCtx
) {
  const seen = new Set<string>();
  for (const [index, registration] of value.registrations.entries()) {
    if (seen.has(registration.profileId)) {
      context.addIssue({
        code: "custom",
        message: "duplicate local Agent Host profile",
        path: ["registrations", index, "profileId"]
      });
    }
    seen.add(registration.profileId);
  }
}

const documentSchema = z
  .object({
    version: z.literal(3),
    registrations: z.array(registrationSchema).max(128)
  })
  .strict()
  .superRefine(rejectDuplicateProfiles);

const previousDocumentSchema = z
  .object({
    version: z.literal(2),
    registrations: z.array(registrationSchema.omit({ generation: true })).max(128)
  })
  .strict()
  .superRefine(rejectDuplicateProfiles);

const mutations = new Map<string, Promise<void>>();

const legacyDocumentSchema = z
  .object({
    version: z.literal(1),
    registrations: z.array(legacyRegistrationSchema).max(128)
  })
  .strict()
  .superRefine(rejectDuplicateProfiles);

export type LocalAgentHostRegistration = z.infer<typeof registrationSchema>;

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class LocalAgentHostRegistrationStore {
  constructor(
    private readonly filePath: string = desktopHomePaths().operatorLocalAgentHostsFile,
    private readonly clock: { now(): Date } = { now: () => new Date() }
  ) {}

  private async readDocument(): Promise<z.infer<typeof documentSchema>> {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return { version: 3, registrations: [] };
      throw new Error("local_agent_host_store_invalid", { cause: error });
    }
    const current = documentSchema.safeParse(input);
    if (current.success) return current.data;
    let migrated: z.infer<typeof documentSchema>;
    try {
      const previous = previousDocumentSchema.safeParse(input);
      const registrations = previous.success
        ? previous.data.registrations
        : legacyDocumentSchema.parse(input).registrations.map((registration) => ({
            profileId: registration.profileId,
            instanceKey: registration.workspaceId,
            updatedAt: registration.updatedAt
          }));
      migrated = documentSchema.parse({
        version: 3,
        registrations: registrations.map((registration) => ({
          ...registration,
          generation: randomUUID()
        }))
      });
    } catch (error) {
      throw new Error("local_agent_host_store_invalid", { cause: error });
    }
    await this.writeDocument(migrated);
    return migrated;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.filePath);
    const result = (mutations.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    mutations.set(key, settled);
    void settled.then(() => {
      if (mutations.get(key) === settled) mutations.delete(key);
    });
    return result;
  }

  get(profileId: string): Promise<LocalAgentHostRegistration | null> {
    return this.serialize(
      async () =>
        (await this.readDocument()).registrations.find((item) => item.profileId === profileId) ??
        null
    );
  }

  latest(): Promise<LocalAgentHostRegistration | null> {
    return this.serialize(async () => (await this.readDocument()).registrations.at(-1) ?? null);
  }

  upsert(
    profileId: string,
    input: { instanceKey: string; workspaceId?: string }
  ): Promise<LocalAgentHostRegistration> {
    return this.serialize(async () => {
      const current = await this.readDocument();
      const registration = registrationSchema.parse({
        profileId,
        instanceKey: input.instanceKey,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        updatedAt: this.clock.now().toISOString(),
        generation: randomUUID()
      });
      const document = documentSchema.parse({
        version: 3,
        registrations: [
          ...current.registrations.filter((item) => item.profileId !== profileId),
          registration
        ]
      });
      await this.writeDocument(document);
      return registration;
    });
  }

  removeIfCurrent(expected: LocalAgentHostRegistration): Promise<boolean> {
    return this.serialize(async () => {
      const current = await this.readDocument();
      const registration = current.registrations.find(
        (item) => item.profileId === expected.profileId
      );
      if (
        !registration ||
        registration.instanceKey !== expected.instanceKey ||
        registration.generation !== expected.generation
      )
        return false;
      await this.writeDocument(
        documentSchema.parse({
          version: 3,
          registrations: current.registrations.filter(
            (item) => item.profileId !== expected.profileId
          )
        })
      );
      return true;
    });
  }

  private async writeDocument(document: z.infer<typeof documentSchema>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM") throw error;
    });
  }
}
