import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  AcpProfileManager,
  AcpProfileAlreadyExistsError,
  AcpProfileNotFoundError,
  AcpProfileRevisionConflictError,
  acpProfileDescriptorSchema,
  type AcpProfileCatalog,
  type AcpProfileDescriptor
} from "@planweave-ai/runtime";

type AcpProfilesErrorEnvelope = {
  ok: false;
  error: Record<string, unknown> & { code: string; message: string };
};

export class AcpProfilesJsonError extends Error {
  constructor(readonly envelope: AcpProfilesErrorEnvelope) {
    super(JSON.stringify(envelope));
    this.name = "AcpProfilesJsonError";
  }
}

function errorEnvelope(error: unknown): AcpProfilesErrorEnvelope {
  if (error instanceof AcpProfileRevisionConflictError) {
    return {
      ok: false,
      error: {
        code: "revision_conflict",
        message: error.message,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      }
    };
  }
  if (error instanceof AcpProfileNotFoundError) {
    return {
      ok: false,
      error: { code: "profile_not_found", message: error.message, profileId: error.profileId }
    };
  }
  if (error instanceof AcpProfileAlreadyExistsError) {
    return {
      ok: false,
      error: { code: "profile_already_exists", message: error.message, profileId: error.profileId }
    };
  }
  if (typeof error === "object" && error !== null && "issues" in error) {
    return {
      ok: false,
      error: { code: "invalid_profile_descriptor", message: "ACP profile descriptor is invalid." }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "acp_profiles_failed", message } };
}

async function jsonAware<T>(json: boolean | undefined, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (json) throw new AcpProfilesJsonError(errorEnvelope(error));
    throw error;
  }
}

function revision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("expected revision must be a non-negative safe integer");
  }
  return parsed;
}

async function readProfile(path: string): Promise<AcpProfileDescriptor> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return acpProfileDescriptorSchema.parse(raw);
}

function printCatalog(catalog: AcpProfileCatalog, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  console.log(`Revision: ${catalog.revision}`);
  for (const profile of catalog.profiles) {
    console.log(`${profile.id}\t${profile.agentId}\t${profile.host.kind}\t${profile.displayName}`);
  }
}

export function registerAcpProfilesCommand(
  program: Command,
  manager: Pick<
    AcpProfileManager,
    "list" | "show" | "register" | "update" | "remove"
  > = new AcpProfileManager()
): void {
  const profiles = program
    .command("acp-profiles")
    .description(
      "Manage local ACP profiles (register -> planweave trust executor; CRUD: list/show/register/update/remove)"
    )
    .addHelpText(
      "after",
      "\nWorkflow: register -> planweave trust executor <name>\nCRUD: list, show, register, update, remove\n"
    );

  profiles
    .command("list")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) =>
      printCatalog(await jsonAware(options.json, () => manager.list()), options.json)
    );

  profiles
    .command("show <profile-id>")
    .option("--json", "print machine-readable output")
    .action(async (profileId: string, options: { json?: boolean }) => {
      const result = await jsonAware(options.json, () => manager.show(profileId));
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else
        printCatalog(
          {
            version: "planweave.acp-profile-catalog/v1",
            revision: result.revision,
            profiles: [result.profile]
          },
          false
        );
    });

  profiles
    .command("register")
    .requiredOption("--file <path>", "JSON ACP profile descriptor")
    .requiredOption("--expected-revision <revision>", "catalog revision used for CAS")
    .option("--json", "print machine-readable output")
    .action(async (options: { file: string; expectedRevision: string; json?: boolean }) => {
      const profile = await jsonAware(options.json, () => readProfile(options.file));
      printCatalog(
        await jsonAware(options.json, () =>
          manager.register({ expectedRevision: revision(options.expectedRevision), profile })
        ),
        options.json
      );
    });

  profiles
    .command("update <profile-id>")
    .requiredOption("--file <path>", "JSON ACP profile descriptor")
    .requiredOption("--expected-revision <revision>", "catalog revision used for CAS")
    .option("--json", "print machine-readable output")
    .action(
      async (
        profileId: string,
        options: { file: string; expectedRevision: string; json?: boolean }
      ) => {
        const profile = await jsonAware(options.json, () => readProfile(options.file));
        printCatalog(
          await jsonAware(options.json, () =>
            manager.update({
              expectedRevision: revision(options.expectedRevision),
              profileId,
              profile
            })
          ),
          options.json
        );
      }
    );

  profiles
    .command("remove <profile-id>")
    .requiredOption("--expected-revision <revision>", "catalog revision used for CAS")
    .option("--json", "print machine-readable output")
    .action(async (profileId: string, options: { expectedRevision: string; json?: boolean }) =>
      printCatalog(
        await jsonAware(options.json, () =>
          manager.remove({
            expectedRevision: revision(options.expectedRevision),
            profileId
          })
        ),
        options.json
      )
    );
}
